const fs = require('node:fs');
const path = require('node:path');
const { getOfficialApiSessionFilePath, getOfficialRechargeQrCachePath } = require('../utils/paths.cjs');

const API_BASE_URL = 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/open';
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
  let qrCodes = [];
  let qrCleanupTimer = null;

  // 仅返回页面需要的账户展示状态。
  function getState() {
    const account = session && session.expiresAt > Date.now() ? session.account : null;
    return {
      status: loading ? 'loading' : account ? 'signed-in' : 'signed-out',
      clientId,
      email: account?.email || null,
      accountId: account?.accountId || null,
      availablePoint: account?.availablePoint ?? null,
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

  // 保留上限是本地清理规则，不代表微信二维码的有效期。
  function pruneQrCodes() {
    const retained = qrCodes.filter((item) => Date.now() - item.cachedAt < QR_CACHE_MAX_AGE);
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
  function clearSession() {
    resetOrderTracking();
    clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshAt = 0;
    session = null;
    loading = false;
    publish();
    fs.rmSync(sessionFile, { force: true });
  }

  // 官方接口统一响应解析；网络异常可在当前令牌有效期内重试。
  async function request(endpoint, { body, authenticated = false, method = 'POST' } = {}) {
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (authenticated && remaining <= 0) {
      clearSession();
      throw new Error('请先登陆官方账户');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) headers[session.tokenHeader] = session.token;
    let response;
    try {
      response = await fetchImpl(`${API_BASE_URL}${endpoint}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(Math.max(1, Math.floor(authenticated ? Math.min(15000, remaining) : 15000))),
        ]),
      });
    } catch (error) {
      throw Object.assign(new Error('暂时无法连接官方账户服务，请稍后重试', { cause: error }), { retryable: true });
    }
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
      if (authenticated && (response.status === 401 || response.status === 403)) clearSession();
      throw Object.assign(new Error(result?.msg || `官方账户请求失败（${response.status}）`), { retryable: response.status >= 500 });
    }
    return result.data;
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

  // 接收服务端签发的新令牌，立即保存并按有效期的 80% 安排刷新。
  function acceptToken(token, account = session?.account || null) {
    const lifetime = Number(token?.expiresInSeconds) * 1000;
    if (!token?.token || !token.tokenHeader || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new Error('官方账户接口未返回有效令牌');
    }
    persist({
      token: token.token,
      tokenHeader: token.tokenHeader,
      expiresAt: Date.now() + lifetime,
      account: account ? { accountId: account.accountId, email: account.email || null, availablePoint: account.availablePoint } : null,
    });
    scheduleRefresh(lifetime * 0.8);
  }

  // 保存账户展示字段，余额保留服务端字符串精度。
  function acceptAccount(account) {
    persist({ ...session, account: { accountId: account.accountId, email: account.email || null, availablePoint: account.availablePoint } });
    loading = false;
    publish();
  }

  // 后台失败不弹提示；临时断网只在当前令牌有效期内继续刷新。
  function handleAutomaticFailure(error) {
    if (closed) return;
    loading = false;
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (error.retryable && remaining > 0) {
      scheduleRefresh(Math.min(30000, remaining));
      publish();
    } else {
      clearSession();
    }
  }

  // 刷新现有会话，并同步查询最新账户邮箱和余额。
  async function refreshSession() {
    try {
      if (!session || session.expiresAt <= Date.now()) {
        clearSession();
        return;
      }
      acceptToken(await request('/tokens/refresh', { authenticated: true }));
      acceptAccount(await request('/account', { method: 'GET', authenticated: true }));
      if (!orderTrackingStarted) beginOrderTracking();
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

  // 启动时优先续用有效会话，否则只尝试一次 clientID 注册或登录。
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
        if (session && session.expiresAt > Date.now()) {
          await refreshSession();
          return;
        }
        session = null;
        fs.rmSync(sessionFile, { force: true });
        acceptToken(await request('/clients/register', { body: { clientId } }));
        acceptAccount(await request('/account', { method: 'GET', authenticated: true }));
        beginOrderTracking();
      } catch (error) {
        handleAutomaticFailure(error);
      }
    });
    return startPromise;
  }

  // 验证码始终使用当前登录链路的原始 clientID。
  function sendEmailCode({ email, purpose }) {
    return enqueue(() => request('/email-codes', { body: { email, clientId, purpose } }));
  }

  // 使用邮箱验证码登录，保存该响应中的账户及新令牌。
  function loginWithEmail({ email, code }) {
    return enqueue(async () => {
      const result = await request('/email/login', { body: { email, code, clientId } });
      acceptToken(result.token, result.account);
      loading = false;
      publish();
      beginOrderTracking();
      return getState();
    });
  }

  // 绑定邮箱可能合并账户，必须立即替换旧令牌及账户信息。
  function bindEmail({ email, code }) {
    return enqueue(async () => {
      const result = await request('/email/bind', { body: { email, code }, authenticated: true });
      acceptToken(result.token, result.account);
      loading = false;
      publish();
      beginOrderTracking();
      return getState();
    });
  }

  // 使用当前开放令牌查询商品，仅返回页面展示字段，不持久化商品列表。
  function getRechargeOptions() {
    return enqueue(async () => {
      const options = await request('/recharge/options', { method: 'GET', authenticated: true });
      return options.map(({ id, name, price, pointValue }) => ({ id, name, price, pointValue }));
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

  // 广播服务端状态；支付成功或关单后立即清除当前账户的二维码。
  function recordOrder(order) {
    if (order.payStatus === 'SUCCESS' && orderStatuses.get(order.id) !== 'SUCCESS') balanceNeedsRefresh = true;
    orderStatuses.set(order.id, order.payStatus);
    if (order.payStatus === 'WAITING') pendingOrders.add(order.id);
    else {
      pendingOrders.delete(order.id);
      const retained = qrCodes.filter((item) => item.accountId !== session.account.accountId || item.orderId !== order.id);
      if (retained.length !== qrCodes.length) { qrCodes = retained; saveQrCodes(); }
    }
    orderListeners.forEach((listener) => listener({ ...order, qrCode: null }));
  }

  // 确认成功后立即查询余额；查询失败只重试余额，不回退支付状态。
  async function refreshPaidBalance() {
    if (!balanceNeedsRefresh || !session || closed || Date.now() < balanceRetryAt) return;
    try {
      acceptAccount(await request('/account', { method: 'GET', authenticated: true }));
      balanceNeedsRefresh = false;
      balanceRetryAt = 0;
    } catch {
      balanceRetryAt = Date.now() + 30000;
      orderRetryAt = balanceRetryAt;
    }
  }

  // 列表以服务端为准，同时恢复其中尚未完成的订单。
  async function readRechargeOrders() {
    const orders = await request('/recharge/orders', { method: 'GET', authenticated: true });
    orders.forEach(recordOrder);
    reloadOrders = false;
    await refreshPaidBalance();
    return orders;
  }

  // 手动查询和后台确认走同一路径，成功状态必定触发余额查询。
  async function readRechargeOrder(id) {
    const order = await request(`/recharge/orders/${id}`, { method: 'GET', authenticated: true });
    recordOrder(order);
    await refreshPaidBalance();
    return order;
  }

  // 关闭页面仍确认支付；断网后 30 秒重试，到期停止。
  async function checkOrders() {
    if (!session || session.expiresAt <= Date.now()) { clearSession(); return; }
    orderRetryAt = 0;
    try {
      if (reloadOrders) await readRechargeOrders();
      else {
        for (const id of [...pendingOrders]) await readRechargeOrder(id);
        await refreshPaidBalance();
      }
    } catch {
      orderRetryAt = Date.now() + 30000;
    } finally {
      scheduleOrderCheck();
    }
  }

  // 创建只执行一次；失败后查询列表确认可能已落库的订单，不自动重发下单。
  function createRechargeOrder({ optionId }) {
    if (creatingOrder) return creatingOrder;
    creatingOrder = enqueue(async () => {
      try {
        const order = await request('/recharge/orders', { body: { optionId, quantity: 1 }, authenticated: true });
        if (order.payStatus === 'WAITING' && order.qrCode) {
          qrCodes.push({ accountId: session.account.accountId, orderId: order.id, qrCode: order.qrCode, cachedAt: Date.now() });
          saveQrCodes();
        }
        recordOrder(order);
        await refreshPaidBalance();
        return order;
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

  // 手动刷新列表后继续监控待支付订单。
  function getRechargeOrders() {
    return enqueue(async () => {
      try { return await readRechargeOrders(); }
      finally { scheduleOrderCheck(); }
    });
  }

  // 先查询服务端状态，仅为仍待支付的订单附上当前账户的有效本地缓存。
  function getRechargeOrder(id) {
    return enqueue(async () => {
      try {
        const order = await readRechargeOrder(id);
        pruneQrCodes();
        const cached = order.payStatus === 'WAITING'
          ? qrCodes.find((item) => item.accountId === session?.account?.accountId && item.orderId === order.id)
          : null;
        return { ...order, qrCode: cached?.qrCode || null };
      }
      finally { scheduleOrderCheck(); }
    });
  }

  // 关单后重新查询权威状态；拒绝关单时也查询，处理付款与关单并发。
  function closeRechargeOrder(id) {
    return enqueue(async () => {
      try {
        await request(`/recharge/orders/${id}/close`, { authenticated: true });
        return await readRechargeOrder(id);
      } catch (error) {
        try { await readRechargeOrder(id); } catch { orderRetryAt = Date.now() + 30000; }
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

  return { start, getState, onChanged, sendEmailCode, loginWithEmail, bindEmail, getRechargeOptions,
    createRechargeOrder, getRechargeOrders, getRechargeOrder, closeRechargeOrder, onRechargeOrderChanged, close };
}

module.exports = { createOfficialAccountService };
