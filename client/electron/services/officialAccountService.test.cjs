const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createOfficialAccountService } = require('./officialAccountService.cjs');
const { createConfigStore } = require('./configStore.cjs');

const clientId = 'machine-v1-official-account-test-client-identity';
const account = { accountId: '2087000000000000001', email: null, availablePoint: '0' };
const settle = () => new Promise(setImmediate);

// 测试 Key 仅用于服务端替身，不调用真实模型接口。
const validKey = (apiKey, fields = {}) => ({ name: '易标开源版', status: 'ACTIVE', expireTime: null, apiKey, ...fields });

// 构造接口文档中的短期令牌响应。
function token(value) {
  return { token: value, tokenHeader: 'X-Yibiao-Open-Token', expiresInSeconds: '900', accountId: account.accountId };
}

// 模拟新邮箱登录结果；JWT 的 exp 用于本机定时，测试不执行服务端验签。
function emailLogin(value = 'email') {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 })).toString('base64url');
  return { token: `header.${payload}.${value}`, tokenHeader: 'Bearer ', openUserId: 'user-one', tenantId: 'tenant-one', tenantCode: 'demo' };
}

// 使用临时中文目录和可记录请求的服务端替身，不创建真实账户或发送邮件。
function setup(t, handler, keyHandler = () => ({ code: 0, data: [{ name: '易标开源版', status: 'ACTIVE', apiKey: 'test-official-key', expireTime: null }] })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '易标账户-'));
  const configStore = createConfigStore({ getPath: () => directory });
  configStore.save({ analytics_client_id: clientId });
  const requests = [];
  const powerMonitor = new EventEmitter();
  const services = [];
  const create = () => {
    const service = createOfficialAccountService({
      app: { getPath: () => directory },
      configStore,
      powerMonitor,
      fetchImpl: async (url, options) => {
        const request = { url, endpoint: new URL(url).pathname.replace('/qhp-yibiao/anonymous/yibiao/open', '').replace('/qhp-yibiao', ''), ...options, body: options.body ? JSON.parse(options.body) : undefined };
        requests.push(request);
        const result = await (request.endpoint === '/api-keys' ? keyHandler(request) : handler(request));
        const status = result.httpStatus || 200;
        return { ok: status >= 200 && status < 300, status, json: async () => {
          if (result.invalidJson) throw new SyntaxError('Invalid JSON');
          return result;
        } };
      },
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { create, requests, powerMonitor, configStore, sessionFile: path.join(directory, 'official_api_session.json'), qrCacheFile: path.join(directory, 'official_recharge_qr_cache.json') };
}

test('匿名、绑定和邮箱登录统一查询消费接口，使用各自凭据并保留点数精度', async (t) => {
  const anonymousRecord = { recordId: '2087000000000000099', consumePoint: '9007199254740993', availableAfter: '100', consumeType: 'AI_SETTLE' };
  const emailRecord = { ...anonymousRecord, recordId: '2087000000000000100', consumePoint: '20' };
  const login = emailLogin('transactions');
  const relogin = emailLogin('transactions-relogin');
  const env = setup(t, ({ endpoint, url, headers }) => {
    if (endpoint === '/account') return { code: 0, data: account };
    if (endpoint === '/email/bind' || endpoint === '/email/login') return {
      code: 0, data: { account: { ...account, email: 'user@example.com' }, login: endpoint === '/email/bind' ? login : relogin },
    };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    if (endpoint === '/account/consume-records') {
      const query = new URL(url).searchParams;
      return { code: 0, data: { current: query.get('current'), size: query.get('size'), total: '12', records: [headers.Authorization ? emailRecord : anonymousRecord] } };
    }
    return { code: 0, data: token('transactions-anonymous') };
  });
  const service = env.create();
  await service.start();
  assert.deepEqual(await service.getTransactions(2), { current: 2, size: 5, total: 12, records: [anonymousRecord] });
  const anonymousRequest = env.requests.findLast(item => item.endpoint === '/account/consume-records');
  assert.equal(anonymousRequest.url, 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/open/account/consume-records?current=2&size=5');
  assert.equal(anonymousRequest.method, 'GET');
  assert.equal(anonymousRequest.headers['X-Yibiao-Open-Token'], 'transactions-anonymous');
  assert.equal(anonymousRequest.headers.Authorization, undefined);
  await service.bindEmail({ email: 'user@example.com', code: '123456' });
  assert.deepEqual(await service.getTransactions(1), { current: 1, size: 5, total: 12, records: [emailRecord] });
  const emailRequest = env.requests.findLast(item => item.endpoint === '/account/consume-records');
  assert.equal(emailRequest.url, 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/open/account/consume-records?current=1&size=5');
  assert.equal(emailRequest.method, 'GET');
  assert.equal(emailRequest.headers.Authorization, `Bearer ${login.token}`);
  assert.equal(emailRequest.headers['X-Yibiao-Open-Token'], undefined);
  await service.loginWithEmail({ email: 'user@example.com', code: '123456' });
  assert.deepEqual(await service.getTransactions(2), { current: 2, size: 5, total: 12, records: [emailRecord] });
  const reloginRequest = env.requests.findLast(item => item.endpoint === '/account/consume-records');
  assert.equal(reloginRequest.headers.Authorization, `Bearer ${relogin.token}`);
  assert.equal(reloginRequest.headers['X-Yibiao-Open-Token'], undefined);
  assert.equal(env.requests.some(item => item.endpoint === '/yibiao/point/consume-orders'), false);
});

test('流水查询区分空列表、接口失败和错误分页，会话失效后不请求', async (t) => {
  let response = { code: 0, data: { current: '1', size: '5', total: '0', records: [] } };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/account') return { code: 0, data: account };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    if (endpoint === '/account/consume-records') return response;
    return { code: 0, data: token('anonymous') };
  });
  const service = env.create();
  await assert.rejects(service.getTransactions(1), /请先登陆/);
  assert.equal(env.requests.length, 0);
  await service.start();
  assert.deepEqual((await service.getTransactions(1)).records, []);
  response = { code: -1, msg: '消费流水查询失败' };
  await assert.rejects(service.getTransactions(1), /消费流水查询失败/);
  assert.equal(service.getState().status, 'signed-in');
  response = { code: 0, data: { current: '1', size: '5', total: '0' } };
  await assert.rejects(service.getTransactions(1), /分页数据不完整/);
  response = { httpStatus: 401, code: -1, msg: '登录失效' };
  await assert.rejects(service.getTransactions(1), /登录失效/);
  const count = env.requests.length;
  await assert.rejects(service.getTransactions(1), /请先登陆/);
  assert.equal(env.requests.length, count);
});

test('刷新余额合并重叠请求，广播并保存最新 e 点，使用当前身份且不访问 Key', async (t) => {
  let finishRefresh;
  let delay = false;
  let currentAccount = account;
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/account') return delay
      ? new Promise(resolve => { finishRefresh = resolve; })
      : { code: 0, data: currentAccount };
    if (endpoint === '/email/login') return { code: 0, data: { account: currentAccount, login: emailLogin() } };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: token('anonymous') };
  });
  const service = env.create();
  await service.start();
  const keyRequests = env.requests.filter(item => item.endpoint === '/api-keys').length;
  const before = env.requests.filter(item => item.endpoint === '/account').length;
  const changes = [];
  service.onChanged(state => changes.push(state));
  delay = true;
  const first = service.refreshBalance();
  assert.equal(service.refreshBalance(), first);
  await settle();
  assert.equal(env.requests.filter(item => item.endpoint === '/account').length, before + 1);
  const request = env.requests.findLast(item => item.endpoint === '/account');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers['X-Yibiao-Open-Token'], 'anonymous');
  currentAccount = { ...account, availablePoint: '9007199254740993.12' };
  finishRefresh({ code: 0, data: currentAccount });
  assert.equal((await first).availablePoint, currentAccount.availablePoint);
  assert.equal(changes.at(-1).availablePoint, currentAccount.availablePoint);
  assert.equal(JSON.parse(fs.readFileSync(env.sessionFile, 'utf-8')).account.availablePoint, currentAccount.availablePoint);
  assert.equal(env.requests.filter(item => item.endpoint === '/api-keys').length, keyRequests);

  delay = false;
  currentAccount = { ...currentAccount, email: 'user@example.com' };
  await service.loginWithEmail({ email: currentAccount.email, code: '123456' });
  const configBefore = JSON.stringify(env.configStore.load());
  currentAccount = { ...currentAccount, availablePoint: '12.34' };
  const afterLogin = env.requests.length;
  await service.refreshBalance();
  const refreshed = env.requests.slice(afterLogin).filter(item => item.endpoint === '/account');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].headers.Authorization, `Bearer ${emailLogin().token}`);
  assert.equal(refreshed[0].headers['X-Yibiao-Open-Token'], undefined);
  assert.equal(service.getState().availablePoint, '12.34');
  assert.equal(JSON.stringify(env.configStore.load()), configBefore);
});

test('余额刷新失败保留原值，失败后可再刷新，未登录或会话过期时不查询', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let response = { code: 0, data: { ...account, availablePoint: '88.80' } };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/account') return response;
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: token('anonymous') };
  });
  const service = env.create();
  await assert.rejects(service.refreshBalance(), /请先登陆/);
  assert.equal(env.requests.length, 0);
  await service.start();
  response = { httpStatus: 503, code: -1, msg: '余额查询失败' };
  await assert.rejects(service.refreshBalance(), /余额查询失败/);
  assert.equal(service.getState().availablePoint, '88.80');
  assert.equal(service.getState().status, 'signed-in');
  response = { code: 0, data: { ...account, availablePoint: '66.60' } };
  await service.refreshBalance();
  assert.equal(service.getState().availablePoint, '66.60');
  const savedKey = env.configStore.load().api_key;
  t.mock.timers.setTime(Date.now() + 901000);
  const count = env.requests.length;
  await assert.rejects(service.refreshBalance(), /请先登陆/);
  assert.equal(env.requests.length, count);
  assert.equal(service.getState().status, 'signed-out');
  assert.match(service.getState().error, /重新登录/);
  assert.equal(env.configStore.load().api_key, savedKey);
});

test('注册、绑定、登录及邮箱启动恢复同步有效 Key，切换第三方不受影响', async (t) => {
  let currentKey = 'anonymous-key';
  const bound = { ...account, email: 'user@example.com' };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/email/bind' || endpoint === '/email/login') {
      currentKey = endpoint === '/email/bind' ? 'bound-key' : 'login-key';
      return { code: 0, data: { account: bound, login: emailLogin(endpoint) } };
    }
    if (endpoint === '/openUser/refresh-token') return { code: 0, data: emailLogin('restart') };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? bound : token('anonymous') };
  }, () => ({ code: 0, data: [
    validKey('other-name', { name: '其他应用' }),
    validKey('revoked', { status: 'REVOKED' }),
    validKey('expired', { expireTime: new Date(Date.now() - 1000).toISOString() }),
    validKey(currentKey), validKey('older-key'),
  ] }));
  env.configStore.save({ text_model_provider: 'custom', api_key: 'custom-key', model_name: 'custom-model' });
  const service = env.create();
  await service.start();
  assert.equal(env.configStore.load().text_model_profiles.official.api_key, 'anonymous-key');
  assert.equal(env.requests.find(item => item.endpoint === '/api-keys').headers['X-Yibiao-Open-Token'], 'anonymous');
  await service.bindEmail({ email: bound.email, code: '123456' });
  assert.equal(env.configStore.load().text_model_profiles.official.api_key, 'bound-key');
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${emailLogin('/email/bind').token}`);
  await service.loginWithEmail({ email: bound.email, code: '123456' });
  assert.equal(env.configStore.load().text_model_profiles.official.api_key, 'login-key');
  assert.equal(env.configStore.load().text_model_provider, 'custom');
  assert.equal(env.configStore.load().api_key, 'custom-key');
  assert.equal(env.requests.filter(item => item.endpoint === '/api-keys' && item.method === 'POST').length, 0);
  await service.close();
  currentKey = 'restart-key';
  const restarted = env.create();
  await restarted.start();
  assert.equal(env.configStore.load().text_model_profiles.official.api_key, 'restart-key');
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${emailLogin('restart').token}`);
  assert.equal(JSON.stringify(restarted.getState()).includes('restart-key'), false);
  assert.equal(fs.readFileSync(env.sessionFile, 'utf-8').includes('restart-key'), false);
});

test('没有有效同名 Key 时创建不过期 Key，查询或创建失败提示重试且不清空配置', async (t) => {
  let failure = '';
  let keys = [];
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/email/login') return { code: 0, data: { account, login: emailLogin() } };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? account : token('anonymous') };
  }, ({ method }) => {
    if (method === failure) return { code: -1, msg: '请求失败' };
    return { code: 0, data: method === 'GET' ? keys : validKey('created-key') };
  });
  const service = env.create();
  await service.start();
  assert.equal(env.configStore.load().api_key, 'created-key');
  const creation = env.requests.find(item => item.endpoint === '/api-keys' && item.method === 'POST');
  assert.deepEqual(creation.body, { name: '易标开源版' });
  keys = [validKey('revoked', { status: 'REVOKED' }), validKey('expired', { expireTime: '2000-01-01T00:00:00' })];
  await service.loginWithEmail({ email: 'user@example.com', code: '123456' });
  const count = env.requests.filter(item => item.endpoint === '/api-keys' && item.method === 'POST').length;
  assert.equal(count, 2);
  failure = 'GET';
  await assert.rejects(service.loginWithEmail({ email: 'user@example.com', code: '123456' }), /获取官方 API Key 失败，请重启软件或重新登录/);
  assert.equal(env.requests.filter(item => item.endpoint === '/api-keys' && item.method === 'POST').length, count);
  assert.match(service.getState().error, /重启软件或重新登录/);
  failure = 'POST';
  await assert.rejects(service.loginWithEmail({ email: 'user@example.com', code: '123456' }), /重启软件或重新登录/);
  assert.equal(env.configStore.load().api_key, 'created-key');
  failure = '';
  await service.loginWithEmail({ email: 'user@example.com', code: '123456' });
  assert.equal(service.getState().error, '');
});

test('自动获取 Key 失败可在重启后重试，会话失效不删除已保存 Key', async (t) => {
  let denied = true;
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/recharge/options') return { httpStatus: 401, code: -1, msg: '会话失效' };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? account : token('anonymous') };
  }, () => denied ? { code: -1, msg: '暂时失败' } : { code: 0, data: [validKey('recovered-key')] });
  const first = env.create();
  await first.start();
  assert.match(first.getState().error, /重启软件或重新登录/);
  await first.close();
  denied = false;
  const second = env.create();
  await second.start();
  assert.equal(env.configStore.load().api_key, 'recovered-key');
  await assert.rejects(second.getRechargeOptions(), /会话失效/);
  assert.equal(second.getState().status, 'signed-out');
  assert.equal(env.configStore.load().api_key, 'recovered-key');
});

test('匿名账户每次启动重新注册，绑定过的 Client 拒绝匿名登录', async (t) => {
  let denied = false;
  const env = setup(t, ({ endpoint }) => {
    if (denied) return { code: -10, msg: '请使用邮箱登陆' };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 200, data: endpoint === '/account' ? account : token(endpoint) };
  });
  const first = env.create();
  await first.start();
  assert.deepEqual(first.getState(), { status: 'signed-in', clientId, identityType: 'anonymous', error: '', email: null, accountId: account.accountId, availablePoint: '0' });
  assert.deepEqual(env.requests[0].body, { clientId });
  assert.equal(env.requests[1].method, 'GET');
  assert.equal(env.requests[1].headers['X-Yibiao-Open-Token'], '/clients/register');
  assert.equal(JSON.stringify(first.getState()).includes('token'), false);
  await first.close();

  const second = env.create();
  await second.start();
  assert.equal(env.requests[3].endpoint, '/clients/register');
  assert.equal(env.requests[3].headers['X-Yibiao-Open-Token'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(env.sessionFile, 'utf-8')).token, '/clients/register');
  assert.equal(second.getState().availablePoint, '0');
  await second.close();

  denied = true;
  const third = env.create();
  await third.start();
  assert.equal(third.getState().status, 'signed-out');
  assert.equal(third.getState().availablePoint, null);
  assert.equal(fs.existsSync(env.sessionFile), false);
  const fourth = env.create();
  await fourth.start();
  assert.equal(env.requests.at(-1).endpoint, '/clients/register');
  assert.equal(fourth.getState().status, 'signed-out');
});

test('充值商品使用当前开放令牌，保留价格精度及顺序，重开重查且失败可重试', async (t) => {
  const products = [
    { id: '2087000000000000502', name: '大额商品', price: '9007199254740993.12', pointValue: '900719925474099312' },
    { id: '2087000000000000501', name: '入门商品', price: '9.90', pointValue: '990' },
  ];
  let response = { code: 200, data: products.map((item) => ({ ...item, status: 'ENABLED', sortValue: 10 })) };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/recharge/options') return response;
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? account : token(endpoint) };
  });
  const service = env.create();
  await assert.rejects(service.getRechargeOptions(), /请先登陆/);
  assert.equal(env.requests.length, 0);
  await service.start();
  const sessionBefore = fs.readFileSync(env.sessionFile, 'utf-8');
  assert.deepEqual(await service.getRechargeOptions(), products);
  const request = env.requests.at(-1);
  assert.equal(request.url, 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/open/recharge/options');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, undefined);
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', 'X-Yibiao-Open-Token': '/clients/register' });
  assert.equal(fs.readFileSync(env.sessionFile, 'utf-8'), sessionBefore);
  await service.close();

  const resumed = env.create();
  await resumed.start();
  response = { code: 0, data: [] };
  assert.deepEqual(await resumed.getRechargeOptions(), []);
  assert.equal(env.requests.at(-1).headers['X-Yibiao-Open-Token'], '/clients/register');
  response = { code: -1, msg: '商品暂不可用' };
  await assert.rejects(resumed.getRechargeOptions(), /商品暂不可用/);
  response = { httpStatus: 503, code: 0, msg: '服务暂不可用' };
  await assert.rejects(resumed.getRechargeOptions(), /服务暂不可用/);
  response = { code: 0, data: products };
  assert.deepEqual(await resumed.getRechargeOptions(), products);
  assert.equal(resumed.getState().status, 'signed-in');
});

test('邮箱登陆与绑定使用正确凭据，绑定等待旧刷新结束并原子替换账户', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let finishRefresh;
  let denyRegistration = true;
  const boundAccount = { accountId: '2087000000000000002', email: 'user@example.com', availablePoint: '9007199254740993.12' };
  const env = setup(t, async ({ endpoint }) => {
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    if (endpoint === '/clients/register' && denyRegistration) return { code: -10, msg: '请使用邮箱登陆' };
    if (endpoint === '/tokens/refresh') return new Promise(resolve => { finishRefresh = resolve; });
    if (endpoint === '/email-codes') return { code: 0, data: true };
    if (endpoint === '/email/login' || endpoint === '/email/bind') return { code: 0, data: { account: boundAccount, login: emailLogin(endpoint) } };
    return { code: 0, data: endpoint === '/account' ? account : token('anonymous') };
  });
  const service = env.create();
  await service.start();
  await service.sendEmailCode({ email: boundAccount.email, purpose: 'LOGIN' });
  assert.deepEqual(env.requests.at(-1).body, { email: boundAccount.email, purpose: 'LOGIN' });
  await service.loginWithEmail({ email: boundAccount.email, code: '123456' });
  assert.deepEqual(env.requests.findLast(item => item.endpoint === '/email/login').body, { email: boundAccount.email, code: '123456' });
  assert.equal(service.getState().email, boundAccount.email);
  assert.equal(service.getState().availablePoint, boundAccount.availablePoint);
  await service.close();

  fs.rmSync(env.sessionFile);
  denyRegistration = false;
  const anonymous = env.create();
  await anonymous.start();
  await anonymous.sendEmailCode({ email: boundAccount.email, purpose: 'BIND' });
  assert.deepEqual(env.requests.at(-1).body, { email: boundAccount.email, purpose: 'BIND' });
  await anonymous.close();

  const resumed = env.create();
  await resumed.start();
  t.mock.timers.tick(720000);
  await settle();
  const binding = resumed.bindEmail({ email: boundAccount.email, code: '654321' });
  await settle();
  assert.equal(env.requests.at(-1).endpoint, '/tokens/refresh');
  finishRefresh({ code: 0, data: token('refreshed') });
  await binding;
  const bindRequest = env.requests.findLast(item => item.endpoint === '/email/bind');
  assert.equal(bindRequest.headers['X-Yibiao-Open-Token'], 'refreshed');
  assert.deepEqual(bindRequest.body, { email: boundAccount.email, code: '654321' });
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${emailLogin('/email/bind').token}`);
  const saved = JSON.parse(fs.readFileSync(env.sessionFile, 'utf-8'));
  assert.equal(saved.kind, 'email');
  assert.equal(saved.token, emailLogin('/email/bind').token);
  assert.deepEqual(saved.account, boundAccount);
  assert.equal(resumed.getState().email, boundAccount.email);
  assert.equal(resumed.getState().availablePoint, boundAccount.availablePoint);
});

test('有效期 80% 自动刷新余额、断网重试、过期及休眠恢复不会重新注册', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let offline = false;
  let availablePoint = '0';
  const env = setup(t, ({ endpoint }) => {
    if (offline) throw new TypeError('network offline');
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? { ...account, availablePoint } : token('current') };
  });
  const service = env.create();
  await service.start();
  t.mock.timers.tick(719999);
  await settle();
  assert.equal(env.requests.length, 4);
  availablePoint = '123.45';
  t.mock.timers.tick(1);
  await settle();
  assert.equal(env.requests.at(-2).endpoint, '/tokens/refresh');
  assert.equal(env.requests.at(-1).endpoint, '/account');
  assert.equal(env.requests.at(-1).headers['X-Yibiao-Open-Token'], 'current');
  assert.equal(service.getState().availablePoint, '123.45');
  assert.equal(JSON.parse(fs.readFileSync(env.sessionFile, 'utf-8')).account.availablePoint, '123.45');

  offline = true;
  t.mock.timers.tick(720000);
  await settle();
  assert.equal(service.getState().status, 'signed-in');
  const requestCount = env.requests.length;
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(env.requests.length, requestCount + 1);
  t.mock.timers.setTime(Date.now() + 151000);
  env.powerMonitor.emit('resume');
  await settle();
  assert.equal(service.getState().status, 'signed-out');
  assert.equal(service.getState().availablePoint, null);
  assert.equal(fs.existsSync(env.sessionFile), false);
  assert.equal(env.requests.filter(request => request.endpoint === '/clients/register').length, 1);
  await service.close();
  assert.equal(env.powerMonitor.listenerCount('resume'), 0);
});

test('下单防重复、二维码不广播，后台确认成功立即刷新余额并停止轮询', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let finishCreate;
  let payStatus = 'WAITING';
  const order = { id: 'order-one', orderNo: 'YBOR1', optionId: 'option-one', optionName: '充值商品', payPrice: '9.90', totalPoint: '900719925474099312', quantity: 1, refundStatus: 'NONE', qrCode: null };
  const env = setup(t, ({ endpoint, method }) => {
    if (endpoint === '/recharge/orders' && method === 'POST') return new Promise(resolve => { finishCreate = resolve; });
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    if (endpoint === '/recharge/orders/order-one') return { code: 0, data: { ...order, payStatus } };
    return { code: 0, data: endpoint === '/account' ? { ...account, availablePoint: payStatus === 'SUCCESS' ? order.totalPoint : '0' } : token('open-token') };
  });
  const service = env.create();
  const changes = [];
  service.onRechargeOrderChanged(item => changes.push(item));
  await service.start();
  t.mock.timers.tick(1); await settle();
  const first = service.createRechargeOrder({ optionId: order.optionId });
  const duplicate = service.createRechargeOrder({ optionId: order.optionId });
  assert.equal(first, duplicate);
  await settle();
  finishCreate({ code: 0, data: { ...order, payStatus, qrCode: 'data:image/png;base64,test' } });
  const created = await first;
  assert.equal(created.qrCode, 'data:image/png;base64,test');
  const requests = env.requests.filter(item => item.endpoint === '/recharge/orders' && item.method === 'POST');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { optionId: 'option-one', quantity: 1 });
  assert.equal(requests[0].headers['X-Yibiao-Open-Token'], 'open-token');
  assert.equal(changes.at(-1).qrCode, null);
  t.mock.timers.tick(5000); await settle();
  assert.equal(changes.at(-1).payStatus, 'WAITING');
  payStatus = 'SUCCESS';
  t.mock.timers.tick(5000); await settle();
  assert.equal(changes.at(-1).payStatus, 'SUCCESS');
  assert.deepEqual(env.requests.slice(-2).map(item => item.endpoint), ['/recharge/orders/order-one', '/account']);
  assert.equal(service.getState().availablePoint, order.totalPoint);
  assert.equal(fs.readFileSync(env.sessionFile, 'utf-8').includes(order.id), false);
  const count = env.requests.length;
  t.mock.timers.tick(30000); await settle();
  assert.equal(env.requests.length, count);
});

test('重启恢复待支付订单，断网和余额失败按 30 秒重试，成功状态保持不变', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let payStatus = 'WAITING';
  let detailOffline = false;
  let balanceOffline = false;
  const order = () => ({ id: 'pending', payStatus, qrCode: null });
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/recharge/orders') return { code: 0, data: [order()] };
    if (endpoint === '/recharge/orders/pending') {
      if (detailOffline) throw new TypeError('offline');
      return { code: 0, data: order() };
    }
    if (endpoint === '/account' && balanceOffline) throw new TypeError('offline');
    return { code: 0, data: endpoint === '/account' ? { ...account, availablePoint: payStatus === 'SUCCESS' ? '123.45' : '0' } : token('current') };
  });
  const first = env.create();
  await first.start();
  await first.close();
  const service = env.create();
  const changes = [];
  service.onRechargeOrderChanged(order => changes.push(order));
  await service.start();
  t.mock.timers.tick(1); await settle();
  assert.equal(changes.at(-1).payStatus, 'WAITING');
  detailOffline = true;
  t.mock.timers.tick(5000); await settle();
  const count = env.requests.length;
  t.mock.timers.tick(29999); await settle();
  assert.equal(env.requests.length, count);
  detailOffline = false;
  balanceOffline = true;
  payStatus = 'SUCCESS';
  t.mock.timers.tick(1); await settle();
  assert.equal(changes.at(-1).payStatus, 'SUCCESS');
  assert.equal(service.getState().availablePoint, '0');
  assert.deepEqual(env.requests.slice(-2).map(item => item.endpoint), ['/recharge/orders/pending', '/account']);
  const afterSuccess = env.requests.length;
  t.mock.timers.tick(29999); await settle();
  assert.equal(env.requests.length, afterSuccess);
  balanceOffline = false;
  t.mock.timers.tick(1); await settle();
  assert.equal(env.requests.at(-1).endpoint, '/account');
  assert.equal(service.getState().availablePoint, '123.45');
  assert.equal(changes.at(-1).payStatus, 'SUCCESS');
});

test('邮箱启动刷新、每小时刷新及断网恢复均使用 JWT，并恢复订单监控', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let offline = false;
  let payStatus = 'WAITING';
  const bound = { ...account, email: 'user@example.com' };
  const env = setup(t, ({ endpoint }) => {
    if (offline) throw new TypeError('offline');
    if (endpoint === '/email/login') return { code: 0, data: { account: bound, login: emailLogin() } };
    if (endpoint === '/openUser/refresh-token') return { code: 0, data: emailLogin('refreshed') };
    if (endpoint === '/recharge/orders') return { code: 0, data: [{ id: 'pending', payStatus }] };
    if (endpoint === '/recharge/orders/pending') return { code: 0, data: { id: 'pending', payStatus } };
    return { code: 0, data: endpoint === '/account' ? { ...bound, availablePoint: payStatus === 'SUCCESS' ? '123.45' : '0' } : token('current') };
  });
  const first = env.create();
  await first.start();
  await first.loginWithEmail({ email: bound.email, code: '123456' });
  await first.close();
  const beforeRestart = env.requests.length;
  offline = true;
  const service = env.create();
  await service.start();
  assert.equal(service.getState().identityType, 'email');
  const refreshRequest = env.requests[beforeRestart];
  assert.equal(refreshRequest.url, 'https://v3.yibiao.pro/qhp-yibiao/openUser/refresh-token');
  assert.equal(refreshRequest.method, 'GET');
  assert.equal(refreshRequest.headers.Authorization, `Bearer ${emailLogin().token}`);
  assert.equal(refreshRequest.headers['X-Yibiao-Open-Token'], undefined);
  const retryStart = env.requests.length;
  offline = false;
  t.mock.timers.tick(30000); await settle();
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(env.requests.slice(retryStart).map(item => item.endpoint), ['/openUser/refresh-token', '/account', '/recharge/orders']);
  payStatus = 'SUCCESS';
  t.mock.timers.tick(5000); await settle();
  assert.equal(service.getState().availablePoint, '123.45');
  const count = env.requests.filter(item => item.endpoint === '/openUser/refresh-token').length;
  t.mock.timers.tick(3594998); await settle();
  assert.equal(env.requests.filter(item => item.endpoint === '/openUser/refresh-token').length, count);
  t.mock.timers.tick(1); await settle();
  assert.equal(env.requests.filter(item => item.endpoint === '/openUser/refresh-token').length, count + 1);
  assert.equal(env.requests.filter(item => item.endpoint === '/tokens/refresh').length, 0);
  assert.equal(env.requests.filter(item => item.endpoint === '/clients/register').length, 1);
});

test('关单以服务端为准，拒绝后重新查支付结果，下单失败只查询不重发', async (t) => {
  let payStatus = 'WAITING';
  let closeRejected = false;
  const order = () => ({ id: 'close-me', payStatus, qrCode: null });
  const env = setup(t, ({ endpoint, method }) => {
    if (endpoint === '/recharge/orders' && method === 'POST') return { code: -1, msg: '预下单失败' };
    if (endpoint === '/recharge/orders') return { code: 0, data: [order()] };
    if (endpoint === '/recharge/orders/close-me/close') {
      if (closeRejected) { payStatus = 'SUCCESS'; return { code: -1, msg: '已支付，不能关闭' }; }
      payStatus = 'CLOSED'; return { code: 0, data: true };
    }
    if (endpoint === '/recharge/orders/close-me') return { code: 0, data: order() };
    return { code: 0, data: endpoint === '/account' ? account : token('current') };
  });
  const service = env.create();
  const changes = [];
  service.onRechargeOrderChanged(order => changes.push(order));
  await service.start();
  assert.equal((await service.closeRechargeOrder('close-me')).payStatus, 'CLOSED');
  assert.equal(env.requests.find(item => item.endpoint.endsWith('/close')).method, 'POST');
  closeRejected = true;
  await assert.rejects(service.closeRechargeOrder('close-me'), /已支付/);
  assert.equal(changes.at(-1).payStatus, 'SUCCESS');
  assert.equal(env.requests.at(-1).endpoint, '/account');
  payStatus = 'WAITING';
  await assert.rejects(service.createRechargeOrder({ optionId: 'one' }), /预下单失败/);
  assert.equal(env.requests.filter(item => item.endpoint === '/recharge/orders' && item.method === 'POST').length, 1);
  assert.equal(env.requests.at(-1).endpoint, '/recharge/orders');
  assert.equal(env.requests.at(-1).method, 'GET');
});

test('preload 转发订单字段并去除内部 IPC 错误前缀', async () => {
  let bridge;
  let fail = false;
  const calls = [];
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf-8'), {
    process: { platform: 'darwin' },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'yibiao') bridge = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        if (fail) throw new Error(`Error invoking remote method '${channel}': Error: 商品暂不可用`);
        return { id: 'order-one' };
      } },
    }),
  });
  assert.equal((await bridge.officialAccount.createRechargeOrder({ optionId: 'one' })).id, 'order-one');
  assert.equal(calls[0].channel, 'official-account:create-recharge-order');
  assert.equal(calls[0].args[0].optionId, 'one');
  await bridge.officialAccount.refreshBalance();
  assert.equal(calls.at(-1).channel, 'official-account:refresh-balance');
  assert.deepEqual(calls.at(-1).args, []);
  await bridge.officialAccount.getTransactions(2);
  assert.equal(calls.at(-1).channel, 'official-account:get-transactions');
  assert.deepEqual(calls.at(-1).args, [2]);
  fail = true;
  await assert.rejects(bridge.officialAccount.getRechargeOrders(), error => error.message === '商品暂不可用');
});

test('二维码按账户持久化，重启可继续支付，完成订单和过期缓存自动清理', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  let currentAccount = account;
  const orders = [];
  const qrCode = 'data:image/png;base64,local-payment-qr';
  const env = setup(t, ({ endpoint, method }) => {
    const longToken = { ...token('current'), expiresInSeconds: '604800' };
    if (endpoint === '/account') return { code: 0, data: currentAccount };
    if (endpoint === '/email/login') return { code: 0, data: { account: currentAccount, login: emailLogin() } };
    if (endpoint === '/openUser/refresh-token') return { code: 0, data: emailLogin() };
    if (endpoint === '/recharge/orders' && method === 'POST') {
      const order = { id: String(orders.length + 1), payStatus: 'WAITING', qrCode: null };
      orders.push(order);
      return { code: 0, data: { ...order, qrCode } };
    }
    if (endpoint === '/recharge/orders') return { code: 0, data: orders };
    if (endpoint.startsWith('/recharge/orders/')) {
      const order = orders.find((item) => item.id === endpoint.split('/')[3]);
      if (endpoint.endsWith('/close')) order.payStatus = 'CLOSED';
      return { code: 0, data: { ...order } };
    }
    return { code: 0, data: longToken };
  });
  const first = env.create();
  await first.start();
  const one = await first.createRechargeOrder({ optionId: 'one' });
  const two = await first.createRechargeOrder({ optionId: 'two' });
  await first.createRechargeOrder({ optionId: 'three' });
  const saved = JSON.parse(fs.readFileSync(env.qrCacheFile, 'utf-8'));
  assert.deepEqual(saved[0], { accountId: account.accountId, orderId: one.id, qrCode, cachedAt: Date.now() });
  assert.equal(fs.readFileSync(env.sessionFile, 'utf-8').includes(qrCode), false);
  await first.close();

  const resumed = env.create();
  await resumed.start();
  const postCount = env.requests.filter((item) => item.endpoint === '/recharge/orders' && item.method === 'POST').length;
  assert.equal((await resumed.getRechargeOrder(one.id)).qrCode, qrCode);
  assert.equal(env.requests.at(-1).method, 'GET');
  assert.equal(env.requests.at(-1).endpoint, `/recharge/orders/${one.id}`);
  assert.equal(env.requests.filter((item) => item.endpoint === '/recharge/orders' && item.method === 'POST').length, postCount);

  currentAccount = { ...account, accountId: 'another-account', email: 'another@example.com' };
  await resumed.loginWithEmail({ email: currentAccount.email, code: '123456' });
  assert.equal((await resumed.getRechargeOrder(one.id)).qrCode, null);
  currentAccount = account;
  await resumed.loginWithEmail({ email: 'first@example.com', code: '123456' });
  assert.equal((await resumed.getRechargeOrder(one.id)).qrCode, qrCode);
  await resumed.closeRechargeOrder(two.id);
  orders[0].payStatus = 'SUCCESS';
  assert.equal((await resumed.getRechargeOrder(one.id)).qrCode, null);
  assert.equal(env.requests.at(-1).endpoint, '/account');
  assert.deepEqual(JSON.parse(fs.readFileSync(env.qrCacheFile, 'utf-8')).map((item) => item.orderId), ['3']);

  // 即使仍待支付，达到 24 小时保留上限也删除，不改变服务端状态。
  t.mock.timers.setTime(Date.now() + 23.5 * 60 * 60 * 1000);
  t.mock.timers.tick(30 * 60 * 1000); await settle();
  assert.equal(fs.existsSync(env.qrCacheFile), false);
  assert.equal((await resumed.getRechargeOrder('3')).qrCode, null);
  assert.equal(orders[2].payStatus, 'WAITING');

  await resumed.createRechargeOrder({ optionId: 'four' });
  t.mock.timers.setTime(Date.now() + 24 * 60 * 60 * 1000);
  env.powerMonitor.emit('resume'); await settle();
  assert.equal(fs.existsSync(env.qrCacheFile), false);
  await resumed.createRechargeOrder({ optionId: 'five' });
  await resumed.close();
  t.mock.timers.setTime(Date.now() + 24 * 60 * 60 * 1000);
  const restarted = env.create();
  await restarted.start();
  assert.equal(fs.existsSync(env.qrCacheFile), false);
  assert.equal((await restarted.getRechargeOrder('5')).qrCode, null);
});

test('开票申请使用当前认证信息和准确请求体，拒绝时不自动重发', async (t) => {
  let reject = false;
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/invoice-applications') return reject
      ? { code: -10, msg: '该订单已申请开票' }
      : { code: 0, data: { id: '100', status: 'PENDING' } };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    if (endpoint === '/email/login') return { code: 0, data: { account: { ...account, email: 'invoice@example.com' }, login: emailLogin() } };
    return { code: 0, data: endpoint === '/account' ? account : token(endpoint) };
  });
  const service = env.create();
  await service.start();
  await service.loginWithEmail({ email: 'invoice@example.com', code: '123456' });
  const input = { rechargeOrderId: '2087000000000000502', titleType: 'PERSONAL', invoiceTitle: '张三', taxpayerNo: '', receiverEmail: 'invoice@example.com', remark: '' };
  await service.createInvoiceApplication(input);
  const sent = env.requests.find((request) => request.endpoint === '/invoice-applications');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.Authorization, `Bearer ${emailLogin().token}`);
  assert.equal(sent.headers['X-Yibiao-Open-Token'], undefined);
  assert.deepEqual(sent.body, input);
  reject = true;
  await assert.rejects(service.createInvoiceApplication({ ...input, titleType: 'ENTERPRISE', taxpayerNo: '91310000TEST1234567', remark: '项目报销' }), /该订单已申请开票/);
  assert.equal(env.requests.filter((request) => request.endpoint === '/invoice-applications').length, 2);
});

test('权限不足、业务错误和服务异常保留邮箱会话，仅 401 清除会话', async (t) => {
  const bound = { ...account, email: 'user@example.com' };
  let response = { code: 0, data: [] };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/email/login') return { code: 0, data: { account: bound, login: emailLogin() } };
    if (endpoint === '/recharge/options') return response;
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? account : token('anonymous') };
  });
  const service = env.create();
  await service.start();
  await service.loginWithEmail({ email: bound.email, code: '123456' });
  for (const httpStatus of [403, 503, 200]) {
    response = { httpStatus, code: -10, msg: '本次操作失败' };
    await assert.rejects(service.getRechargeOptions(), /本次操作失败/);
    assert.equal(service.getState().identityType, 'email');
    assert.equal(fs.existsSync(env.sessionFile), true);
  }
  response = { httpStatus: 401, code: -10, msg: '令牌已撤销' };
  await assert.rejects(service.getRechargeOptions(), /令牌已撤销/);
  assert.equal(service.getState().status, 'signed-out');
  assert.match(service.getState().error, /重新登录/);
  assert.equal(fs.existsSync(env.sessionFile), false);
  await service.loginWithEmail({ email: bound.email, code: '123456' });
  response = { httpStatus: 401, invalidJson: true };
  await assert.rejects(service.getRechargeOptions(), /响应读取失败/);
  assert.equal(service.getState().status, 'signed-out');
  assert.equal(fs.existsSync(env.sessionFile), false);
});

test('过期邮箱会话启动后要求重新登录，不注册匿名身份或调用匿名刷新', async (t) => {
  const env = setup(t, () => { throw new Error('不应发起请求'); });
  fs.writeFileSync(env.sessionFile, JSON.stringify({ kind: 'email', token: 'expired', expiresAt: Date.now() - 1, account: { ...account, email: 'user@example.com' } }), 'utf-8');
  const service = env.create();
  await service.start();
  assert.equal(env.requests.length, 0);
  assert.equal(service.getState().status, 'signed-out');
  assert.match(service.getState().error, /重新登录/);
});

// 覆盖兑换认证、失败重试请求号和最新余额，避免使用首次入账快照。
test('兑换失败不自动重发，重试沿用请求号，成功刷新当前余额', async (t) => {
  let failed = true;
  const bound = { ...account, email: 'redeem@example.com', availablePoint: '180' };
  const env = setup(t, ({ endpoint }) => {
    if (endpoint === '/redemptions') {
      if (failed) throw new TypeError('network disconnected');
      return { code: 0, data: { redeemedPoint: '100', availablePoint: '100' } };
    }
    if (endpoint === '/email/login') return { code: 0, data: { account: { ...bound, availablePoint: '0' }, login: emailLogin() } };
    if (endpoint === '/recharge/orders') return { code: 0, data: [] };
    return { code: 0, data: endpoint === '/account' ? bound : token('anonymous') };
  });
  const service = env.create();
  await service.start();
  await service.loginWithEmail({ email: bound.email, code: '123456' });
  const input = { code: 'DEMO_123', requestNo: 'redeem-test-request' };
  await assert.rejects(service.redeemCode(input), /暂时无法连接/);
  assert.equal(env.requests.filter(item => item.endpoint === '/redemptions').length, 1);
  failed = false;
  assert.deepEqual(await service.redeemCode(input), { redeemedPoint: '100' });
  const sent = env.requests.filter(item => item.endpoint === '/redemptions');
  assert.equal(sent.length, 2);
  for (const item of sent) {
    assert.deepEqual(item.body, input);
    assert.equal(item.method, 'POST');
    assert.ok(item.headers.Authorization.startsWith('Bearer '));
    assert.equal(item.headers['X-Yibiao-Open-Token'], undefined);
  }
  assert.equal(service.getState().availablePoint, '180');
});
