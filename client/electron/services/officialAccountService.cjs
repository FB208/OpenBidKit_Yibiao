const fs = require('node:fs');
const path = require('node:path');
const { getOfficialApiSessionFilePath, getOfficialRechargeQrCachePath } = require('../utils/paths.cjs');
const { fetchWithRedirect } = require('../utils/fetchWithRedirect.cjs');

const SERVICE_BASE_URL = 'https://v3.yibiao.pro/qhp-yibiao';
const OPEN_PATH = '/anonymous/yibiao/open';
const RECHARGE_PATH = '/anonymous/yibiao/recharge';
const API_KEY_NAME = '易标开源版';
// 匿名令牌只返回字符串，有效期由服务端固定为 900 秒。
const ANONYMOUS_TOKEN_LIFETIME = 900 * 1000;
const PAGE_SIZE = 5;
const EMAIL_REFRESH_INTERVAL = 60 * 60 * 1000;
const QR_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const QR_CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000;

// 原子保存 UTF-8 JSON，避免退出或断电留下半个文件。
function writeJsonAtomic(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempFile, filePath);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

// 服务端时间为 yyyy-MM-dd HH:mm:ss 本地时间。
function parseServerTime(value) {
  return Date.parse(String(value).replace(' ', 'T'));
}

// 服务端分页对象的数字可能以字符串传输，统一转为页面使用的数字。
function readPage(data, label) {
  const current = Number(data?.current);
  const size = Number(data?.size);
  const total = Number(data?.total);
  if (!Array.isArray(data?.records) || !Number.isSafeInteger(current) || current < 1
    || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(total) || total < 0) {
    throw new Error(`官方${label}接口返回的分页数据不完整，请重试`);
  }
  return { records: data.records, current, size, total };
}

// 订单只向页面暴露展示字段，金额和点数保留服务端字符串精度。
function toOrderView(order, qrCode = null) {
  return {
    orderNo: order.orderNo,
    productName: order.productNameSnapshot || '自定义充值',
    payAmountFen: String(order.payAmountFen),
    rechargePoint: String(order.rechargePoint),
    status: order.status,
    refundStatus: order.refundStatus,
    createTime: order.createTime,
    paidTime: order.paidTime || null,
    qrCode,
  };
}

// 管理官方账户会话；所有身份变更在 Main 中串行执行，令牌不发送给页面。
function createOfficialAccountService({ app, configStore, powerMonitor, fetchImpl = fetch }) {
  const sessionFile = getOfficialApiSessionFilePath(app);
  const qrCacheFile = getOfficialRechargeQrCachePath(app);
  const listeners = new Set();
  const orderListeners = new Set();
  const orderStatuses = new Map();
  const pendingOrders = new Set();
  const shutdown = new AbortController();
  let session = null;
  let clientId = '';
  let loading = true;
  let sessionError = '';
  let apiKeyError = '';
  let closed = false;
  let startPromise = null;
  let tail = Promise.resolve();
  let refreshTimer = null;
  let refreshAt = 0;
  let orderTimer = null;
  let orderTrackingStarted = false;
  let reloadOrders = false;
  let balanceNeedsRefresh = false;
  let balanceRetryAt = 0;
  let orderRetryAt = 0;
  let creatingOrder = null;
  let refreshingBalance = null;
  let qrCodes = [];
  let qrCleanupTimer = null;

  // 仅返回页面需要的账户展示状态。
  function getState() {
    const account = session && session.expiresAt > Date.now() ? session.account : null;
    return {
      status: loading ? 'loading' : account ? 'signed-in' : 'signed-out',
      clientId,
      identityType: account ? session.kind : null,
      error: apiKeyError || sessionError,
      email: account?.email || null,
      accountId: account?.accountId || null,
      availablePoint: account?.availablePoint ?? null,
      sources: account?.sources || [],
    };
  }

  // 向所有账户页面同步最新状态。
  function publish() {
    if (closed) return;
    const state = getState();
    listeners.forEach((listener) => listener(state));
  }

  // 顺序处理登录、绑定和刷新，防止旧响应覆盖新令牌。
  function enqueue(operation) {
    const result = tail.then(() => {
      if (closed) throw new Error('官方账户服务已关闭');
      return operation();
    });
    tail = result.catch(() => undefined);
    return result;
  }

  // 保存最新会话后更新内存令牌。
  function persist(nextSession) {
    writeJsonAtomic(sessionFile, nextSession);
    session = nextSession;
  }

  // 缓存磁盘异常不能中断支付确认和余额更新。
  function saveQrCodes() {
    try {
      if (qrCodes.length) writeJsonAtomic(qrCacheFile, qrCodes);
      else fs.rmSync(qrCacheFile, { force: true });
    } catch (error) {
      console.warn('[official-account] 支付二维码缓存写入失败', error);
    }
  }

  // 保留上限是本地清理规则，不代表微信二维码的有效期；没有订单号的旧版缓存一并清除。
  function pruneQrCodes() {
    const retained = qrCodes.filter((item) => item.orderNo && Date.now() - item.cachedAt < QR_CACHE_MAX_AGE);
    if (retained.length === qrCodes.length) return;
    qrCodes = retained;
    saveQrCodes();
  }

  // 未登录时也定期清理，避免其他账户的缓存长期残留。
  function scheduleQrCleanup() {
    qrCleanupTimer = setTimeout(() => {
      void enqueue(() => { pruneQrCodes(); scheduleQrCleanup(); }).catch(() => undefined);
    }, QR_CACHE_CLEANUP_INTERVAL);
    qrCleanupTimer.unref?.();
  }

  // 失效会话停止刷新，并静默回到未登录状态。
  function clearSession(message = '') {
    resetOrderTracking();
    clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshAt = 0;
    session = null;
    sessionError = message;
    loading = false;
    publish();
    fs.rmSync(sessionFile, { force: true });
  }

  // 会话失效：邮箱身份回到未登录；匿名身份标记过期，并立即用 clientId 重新登录。
  function expireSession() {
    if (session?.kind !== 'anonymous') {
      clearSession('登录已失效，请重新登录官方账户');
      return;
    }
    // 已在恢复中时沿用已安排的重试。
    if (!session.expiresAt) return;
    session = { ...session, expiresAt: 0 };
    loading = true;
    publish();
    scheduleRefresh(0);
  }

  // 官方接口统一响应解析；网络异常可在当前令牌有效期内重试。
  async function request(endpoint, { body, rawBody, authenticated = false, method = 'POST' } = {}) {
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (authenticated && remaining <= 0) {
      const anonymous = session?.kind === 'anonymous';
      expireSession();
      throw new Error(anonymous ? '官方账户正在重新连接，请稍后重试' : '请先登陆官方账户');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) {
      if (session.kind === 'email') headers.Authorization = `${session.tokenHeader || 'Bearer '}${session.token}`;
      else headers['X-Yibiao-Open-Token'] = session.token;
    }
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(Math.max(1, Math.floor(authenticated ? Math.min(15000, remaining) : 15000))),
    ]);
    let response;
    try {
      // 服务端以 307 跳转到实际入口，需保留鉴权头。
      response = await fetchWithRedirect(`${SERVICE_BASE_URL}${endpoint}`, {
        method,
        headers,
        ...(rawBody ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {}),
        signal,
      }, fetchImpl);
    } catch (error) {
      throw Object.assign(new Error('暂时无法连接官方账户服务，请稍后重试', { cause: error }), { retryable: true });
    }
    // 认证失效以 HTTP 状态为准，即使错误正文不是 JSON 也应退出失效会话。
    if (authenticated && response.status === 401) expireSession();
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw Object.assign(new Error('官方账户响应读取失败，请稍后重试', { cause: error }), {
        retryable: response.status >= 500 || error instanceof TypeError,
      });
    }
    if (closed) throw new Error('官方账户服务已关闭');
    if (!response.ok || !result || (result.code !== 0 && result.code !== 200)) {
      throw Object.assign(new Error(result?.msg || `官方账户请求失败（${response.status}）`), { retryable: response.status >= 500 });
    }
    return result.data;
  }

  // 列表按创建时间倒序返回；复用最新有效同名 Key，没有则在开放入口创建并立即保存。
  async function syncApiKey() {
    try {
      // 邮箱身份默认是团队管理员，Key 属于当前团队；匿名身份管理个人 Key。
      const keys = await request(session?.kind === 'email' ? '/yibiao/api-keys' : `${OPEN_PATH}/api-keys`, { method: 'GET', authenticated: true });
      if (!Array.isArray(keys)) throw new Error('API Key 列表格式不正确');
      const key = keys.find((item) => item.name === API_KEY_NAME && item.status === 'ACTIVE'
        && (!item.expireTime || parseServerTime(item.expireTime) > Date.now()))
        || await request(`${OPEN_PATH}/api-keys`, { body: { name: API_KEY_NAME }, authenticated: true });
      if (typeof key?.keyValue !== 'string' || !key.keyValue.trim()) throw new Error('接口未返回完整 API Key');
      configStore.save({ text_model_profiles: { official: { api_key: key.keyValue } } });
      apiKeyError = '';
    } catch (error) {
      apiKeyError = '获取官方 API Key 失败，请重启软件或重新登录';
      throw new Error(apiKeyError, { cause: error });
    } finally {
      loading = false;
      publish();
    }
  }

  // 安排唯一的刷新任务，网络重试也使用同一个计时器。
  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshAt = Date.now() + delay;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void enqueue(() => refreshSession()).catch(() => undefined);
    }, Math.max(1, delay));
    refreshTimer.unref?.();
  }

  // 接收服务端签发的新匿名令牌，立即保存并按有效期的 80% 安排刷新。
  function acceptAnonymousToken(token, account = session?.account || null) {
    if (typeof token !== 'string' || !token) throw new Error('官方账户接口未返回有效令牌');
    persist({ token, kind: 'anonymous', expiresAt: Date.now() + ANONYMOUS_TOKEN_LIFETIME, account });
    sessionError = '';
    scheduleRefresh(ANONYMOUS_TOKEN_LIFETIME * 0.8);
  }

  // 邮箱响应使用 QHP JWT；读取 exp 安排本机到期检查，签名与权限由服务端验证。
  function acceptEmailLogin(login, account = session?.account) {
    let expiresAt;
    try {
      expiresAt = Number(JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString('utf-8')).exp) * 1000;
    } catch {
      throw new Error('官方账户接口未返回有效的邮箱登录令牌');
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('邮箱登录令牌已过期，请重新登录');
    persist({ kind: 'email', token: login.token, tokenHeader: login.tokenHeader || 'Bearer ', expiresAt, account });
    sessionError = '';
    scheduleRefresh(Math.min(EMAIL_REFRESH_INTERVAL, expiresAt - Date.now()));
  }

  // 保存账户展示字段；服务端不返回邮箱，沿用登录时保存的邮箱。
  function acceptAccount(account) {
    persist({ ...session, account: {
      email: session.account?.email || null,
      accountId: account.accountId == null ? null : String(account.accountId),
      subjectKey: `${account.subjectType}:${account.subjectId}`,
      availablePoint: account.availablePoint == null ? null : String(account.availablePoint),
      sources: (account.sources || []).map((item) => ({ sourceAccountId: String(item.sourceAccountId), merged: item.mergedToAccountId != null })),
    } });
    loading = false;
    sessionError = '';
    publish();
  }

  // 后台业务或临时服务失败保留仍有效的会话；只有失效或到期才退出。
  function handleAutomaticFailure(error) {
    if (closed) return;
    loading = false;
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (remaining > 0) {
      sessionError = error.message;
      scheduleRefresh(Math.min(error.retryable ? 30000 : session.kind === 'email' ? EMAIL_REFRESH_INTERVAL : remaining * 0.8, remaining));
      publish();
    } else if (session?.kind === 'anonymous') {
      sessionError = error.message;
      expireSession();
    } else {
      clearSession(sessionError || error.message);
    }
  }

  // 刷新现有会话，并同步查询最新账户余额和来源。
  async function refreshSession() {
    try {
      if (!session || session.expiresAt <= Date.now()) {
        if (session?.kind === 'anonymous') await loginAnonymous();
        else clearSession('登录已失效，请重新登录官方账户');
        return;
      }
      if (session.kind === 'email') acceptEmailLogin(await request('/openUser/refresh-token', { method: 'GET', authenticated: true }));
      else acceptAnonymousToken(await request(`${OPEN_PATH}/tokens/refresh`, { authenticated: true }));
      acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      if (!orderTrackingStarted) beginOrderTracking();
      return true;
    } catch (error) {
      handleAutomaticFailure(error);
    }
  }

  // 休眠恢复后按真实时钟重新判断是否到期或需要刷新。
  function handleResume() {
    if (closed) return;
    void enqueue(pruneQrCodes).catch(() => undefined);
    if (!session) return;
    if (Date.now() >= refreshAt || Date.now() >= session.expiresAt) {
      clearTimeout(refreshTimer);
      void enqueue(() => refreshSession()).catch(() => undefined);
    } else {
      scheduleRefresh(refreshAt - Date.now());
    }
  }

  // 匿名身份以 clientId 为凭据：启动和令牌失效时重新登录；网络或服务故障保持加载状态，30 秒后重试。
  async function loginAnonymous() {
    loading = true;
    publish();
    try {
      acceptAnonymousToken(await request(`${OPEN_PATH}/clients/login`, { body: { clientId } }));
      acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      beginOrderTracking();
      await syncApiKey();
    } catch (error) {
      if (closed) return;
      sessionError = error.message;
      if (!error.retryable) loading = false;
      // 统一安排下一次尝试，同时替换失败过程中安排的立即恢复，避免无间隔循环。
      scheduleRefresh(error.retryable ? 30000 : ANONYMOUS_TOKEN_LIFETIME * 0.8);
      publish();
    }
  }

  // 邮箱会话启动时刷新；匿名会话每次启动重新登录，不使用缓存令牌续期。
  function start() {
    if (startPromise) return startPromise;
    powerMonitor.on('resume', handleResume);
    startPromise = enqueue(async () => {
      try {
        if (fs.existsSync(qrCacheFile)) qrCodes = JSON.parse(fs.readFileSync(qrCacheFile, 'utf-8'));
        pruneQrCodes();
      } catch (error) {
        console.warn('[official-account] 支付二维码缓存读取失败', error);
      }
      scheduleQrCleanup();
      try {
        clientId = configStore.load().analytics_client_id;
        publish();
        if (fs.existsSync(sessionFile)) session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        if (session?.kind === 'email') {
          if (await refreshSession()) await syncApiKey();
          return;
        }
        // 不保存的占位会话：启动登录失败后，重试和休眠唤醒仍按匿名身份恢复。
        session = { kind: 'anonymous', expiresAt: 0, account: null };
        fs.rmSync(sessionFile, { force: true });
        await loginAnonymous();
      } catch (error) {
        handleAutomaticFailure(error);
      }
    });
    return startPromise;
  }

  // 验证码只提交邮箱和用途，不携带 Client 身份或已有凭据。
  function sendEmailCode({ email, purpose }) {
    return enqueue(() => request(`${OPEN_PATH}/email-codes`, { body: { email, purpose } }));
  }

  // 使用邮箱验证码登录，保存新令牌后查询该账户；Key 同步不因账户查询失败而跳过。
  function loginWithEmail({ email, code }) {
    return enqueue(async () => {
      acceptEmailLogin(await request(`${OPEN_PATH}/email/login`, { body: { email, code } }), { email });
      beginOrderTracking();
      try {
        acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      } finally {
        await syncApiKey();
      }
      return getState();
    });
  }

  // 绑定邮箱会把匿名资产迁入默认团队，必须立即替换旧令牌及账户信息；Key 同步不因账户查询失败而跳过。
  function bindEmail({ email, code }) {
    return enqueue(async () => {
      acceptEmailLogin(await request(`${OPEN_PATH}/email/bind`, { body: { email, code }, authenticated: true }), { email });
      beginOrderTracking();
      try {
        acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      } finally {
        await syncApiKey();
      }
      return getState();
    });
  }

  // 页面和手动刷新共用同一请求，沿用当前会话查询并广播最新余额。
  function refreshBalance() {
    if (refreshingBalance) return refreshingBalance;
    refreshingBalance = enqueue(async () => {
      acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      return getState();
    }).finally(() => { refreshingBalance = null; });
    return refreshingBalance;
  }

  // 兑换只接受邮箱登录凭据；同一用户和团队重复提交时服务端返回首次成功记录。
  function redeemCode({ code }) {
    return enqueue(async () => {
      const result = await request('/yibiao/redeem', { body: { code }, authenticated: true });
      balanceNeedsRefresh = true;
      balanceRetryAt = 0;
      await refreshPaidBalance();
      scheduleOrderCheck();
      return { redeemedPoint: String(result.pointValue) };
    });
  }

  // 查询单笔订单的开票申请；没有申请时返回 null。
  function getInvoiceApplication(orderNo) {
    return enqueue(async () => {
      const application = await request(`/yibiao/recharge/orders/${orderNo}/invoice`, { method: 'GET', authenticated: true });
      return application ? {
        status: application.status,
        mailStatus: application.mailStatus,
        rejectReason: application.rejectReason || null,
        version: Number(application.version),
      } : null;
    });
  }

  // 提交或在驳回后重新提交一次开票申请，沿用当前账户的认证请求，不自动重发。
  function createInvoiceApplication({ orderNo, ...input }) {
    return enqueue(async () => {
      await request(`/yibiao/recharge/orders/${orderNo}/invoice`, { body: input, authenticated: true });
    });
  }

  // 使用当前令牌查询套餐，仅返回页面展示字段，不持久化套餐列表。
  function getRechargeOptions() {
    return enqueue(async () => {
      const products = await request(`${RECHARGE_PATH}/products`, { method: 'GET', authenticated: true });
      return products.map(({ id, name, payAmountFen, rechargePoint }) => ({
        id: String(id),
        name,
        payAmountFen: String(payAmountFen),
        rechargePoint: String(rechargePoint),
      }));
    });
  }

  // 账户变化、会话失效及退出时停止监控；二维码缓存单独管理。
  function resetOrderTracking() {
    orderTrackingStarted = false;
    clearTimeout(orderTimer);
    orderTimer = null;
    pendingOrders.clear();
    orderStatuses.clear();
    reloadOrders = false;
    balanceNeedsRefresh = false;
    balanceRetryAt = 0;
    orderRetryAt = 0;
  }

  // 登录完成后异步恢复待支付订单，不延迟登录响应。
  function beginOrderTracking() {
    resetOrderTracking();
    orderTrackingStarted = true;
    reloadOrders = true;
    scheduleOrderCheck(0);
  }

  // 所有订单请求使用现有串行队列，唯一计时器防止轮询重叠。
  function scheduleOrderCheck(delay = 5000) {
    clearTimeout(orderTimer);
    orderTimer = null;
    if (closed || !session || (!reloadOrders && !pendingOrders.size && !balanceNeedsRefresh)) return;
    const remaining = session.expiresAt - Date.now();
    orderTimer = setTimeout(() => {
      orderTimer = null;
      void enqueue(checkOrders).catch(() => undefined);
    }, Math.max(1, Math.min(remaining, Math.max(delay, orderRetryAt - Date.now()))));
    orderTimer.unref?.();
  }

  // 广播服务端状态，created 只标记本机刚创建的订单；支付成功或关单后立即清除当前账户的二维码。
  function recordOrder(order, created = false) {
    if (order.status === 'PAID' && orderStatuses.get(order.orderNo) !== 'PAID') balanceNeedsRefresh = true;
    orderStatuses.set(order.orderNo, order.status);
    if (order.status === 'WAITING') pendingOrders.add(order.orderNo);
    else {
      pendingOrders.delete(order.orderNo);
      const retained = qrCodes.filter((item) => item.subjectKey !== session.account.subjectKey || item.orderNo !== order.orderNo);
      if (retained.length !== qrCodes.length) { qrCodes = retained; saveQrCodes(); }
    }
    orderListeners.forEach((listener) => listener(toOrderView(order), created));
  }

  // 确认成功后立即查询余额；查询失败只重试余额，不回退支付状态。
  async function refreshPaidBalance() {
    if (!balanceNeedsRefresh || !session || closed || Date.now() < balanceRetryAt) return;
    try {
      acceptAccount(await request(`${OPEN_PATH}/account`, { method: 'GET', authenticated: true }));
      balanceNeedsRefresh = false;
      balanceRetryAt = 0;
    } catch {
      balanceRetryAt = Date.now() + 30000;
      orderRetryAt = balanceRetryAt;
    }
  }

  // 列表以服务端为准，同时恢复其中尚未完成的订单；后台恢复只读当前主体第一页。
  async function readRechargeOrders({ current = 1, size = 20, sourceAccountId = '' } = {}) {
    const query = new URLSearchParams({ current: String(current), size: String(size) });
    if (sourceAccountId) query.set('sourceAccountId', sourceAccountId);
    const page = readPage(await request(`${RECHARGE_PATH}/orders?${query}`, { method: 'GET', authenticated: true }), '订单');
    page.records.forEach((order) => recordOrder(order));
    reloadOrders = false;
    await refreshPaidBalance();
    return page;
  }

  // 手动查询和后台确认走同一路径，只查本地订单，成功状态必定触发余额查询。
  async function readRechargeOrder(orderNo) {
    const order = await request(`${RECHARGE_PATH}/orders/${orderNo}`, { method: 'GET', authenticated: true });
    recordOrder(order);
    await refreshPaidBalance();
    return order;
  }

  // 关闭页面仍确认支付；断网后 30 秒重试，到期停止。
  async function checkOrders() {
    if (!session || session.expiresAt <= Date.now()) { expireSession(); return; }
    orderRetryAt = 0;
    try {
      if (reloadOrders) await readRechargeOrders();
      else {
        for (const orderNo of [...pendingOrders]) await readRechargeOrder(orderNo);
        await refreshPaidBalance();
      }
    } catch {
      orderRetryAt = Date.now() + 30000;
    } finally {
      scheduleOrderCheck();
    }
  }

  // 创建只执行一次；失败后查询列表确认可能已落库的订单，不自动重发下单。
  function createRechargeOrder({ productId }) {
    if (creatingOrder) return creatingOrder;
    creatingOrder = enqueue(async () => {
      try {
        // 服务端只接受 JSON 整数，雪花 ID 直接写入请求体，不经过 Number 转换。
        const { order, qrCode } = await request(`${RECHARGE_PATH}/orders`, { rawBody: `{"productId":${productId}}`, authenticated: true });
        if (order.status === 'WAITING' && qrCode) {
          qrCodes.push({ subjectKey: session.account.subjectKey, orderNo: order.orderNo, qrCode, cachedAt: Date.now() });
          saveQrCodes();
        }
        recordOrder(order, true);
        await refreshPaidBalance();
        return toOrderView(order, qrCode || null);
      } catch (error) {
        reloadOrders = true;
        try { await readRechargeOrders(); } catch { orderRetryAt = Date.now() + 30000; }
        throw error;
      } finally {
        scheduleOrderCheck();
      }
    }).finally(() => { creatingOrder = null; });
    return creatingOrder;
  }

  // 订单页按来源分页查询，查询后继续监控其中的待支付订单。
  function getRechargeOrders({ current, sourceAccountId }) {
    return enqueue(async () => {
      try {
        const page = await readRechargeOrders({ current, size: PAGE_SIZE, sourceAccountId });
        return { ...page, records: page.records.map((order) => toOrderView(order)) };
      } finally { scheduleOrderCheck(); }
    });
  }

  // 两种登录身份共用消费接口，可按本人历史来源查询，凭据及查询范围由服务端鉴权处理。
  function getTransactions({ current, sourceAccountId }) {
    return enqueue(async () => {
      const query = new URLSearchParams({ current: String(current), size: String(PAGE_SIZE) });
      if (sourceAccountId) query.set('sourceAccountId', sourceAccountId);
      const page = readPage(await request(`/anonymous/yibiao/finance/consumptions?${query}`, {
        method: 'GET', authenticated: true,
      }), '流水');
      return {
        ...page,
        records: page.records.map((item) => ({
          id: String(item.id),
          requestNo: item.requestNo || null,
          aiType: item.aiType || null,
          consumePoint: String(item.consumePoint),
          // 历史来源结算到团队时服务端隐藏团队余额。
          availableAfter: item.availableAfter == null ? null : String(item.availableAfter),
          createTime: item.createTime,
        })),
      };
    });
  }

  // 先查询本地订单状态，仅为仍待支付的订单附上当前账户的有效本地缓存。
  function getRechargeOrder(orderNo) {
    return enqueue(async () => {
      try {
        const order = await readRechargeOrder(orderNo);
        pruneQrCodes();
        const cached = order.status === 'WAITING'
          ? qrCodes.find((item) => item.subjectKey === session?.account?.subjectKey && item.orderNo === order.orderNo)
          : null;
        return toOrderView(order, cached?.qrCode || null);
      }
      finally { scheduleOrderCheck(); }
    });
  }

  // 关单后重新查询订单状态；拒绝关单时也查询，处理付款与关单并发。
  function closeRechargeOrder(orderNo) {
    return enqueue(async () => {
      try {
        await request(`${RECHARGE_PATH}/orders/${orderNo}/close`, { authenticated: true });
        return toOrderView(await readRechargeOrder(orderNo));
      } catch (error) {
        try { await readRechargeOrder(orderNo); } catch { orderRetryAt = Date.now() + 30000; }
        throw error;
      } finally {
        scheduleOrderCheck();
      }
    });
  }

  // 订阅不包含二维码的订单状态变化。
  function onRechargeOrderChanged(listener) {
    orderListeners.add(listener);
    return () => orderListeners.delete(listener);
  }

  // 订阅不包含令牌的账户状态。
  function onChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // 退出时取消网络请求及刷新任务，等待串行队列结束。
  function close() {
    closed = true;
    resetOrderTracking();
    clearTimeout(refreshTimer);
    clearTimeout(qrCleanupTimer);
    powerMonitor.removeListener('resume', handleResume);
    shutdown.abort();
    listeners.clear();
    orderListeners.clear();
    return tail;
  }

  return { start, getState, onChanged, sendEmailCode, loginWithEmail, bindEmail, refreshBalance, getRechargeOptions,
    redeemCode, getInvoiceApplication, createInvoiceApplication, createRechargeOrder, getRechargeOrders, getTransactions,
    getRechargeOrder, closeRechargeOrder, onRechargeOrderChanged, close };
}

module.exports = { createOfficialAccountService };
