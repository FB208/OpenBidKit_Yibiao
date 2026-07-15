const { execFile } = require('node:child_process');

const PING_TIMEOUT_MS = 5000;

// 当前无必须联网服务；保留注册表结构便于后续扩展。
const REQUIRED_ONLINE_SERVICES = Object.freeze({});

const serviceStatuses = new Map(Object.values(REQUIRED_ONLINE_SERVICES).map((service) => [service.id, {
  ...service,
  available: false,
  checked: false,
}]));

let startupCheckPromise = null;

class RequiredOnlineServiceUnavailableError extends Error {
  constructor(service) {
    super(`${service.label}当前不可用，已跳过本次操作`);
    this.name = 'RequiredOnlineServiceUnavailableError';
    this.code = 'REQUIRED_ONLINE_SERVICE_UNAVAILABLE';
    this.serviceId = service.id;
  }
}

// 使用系统 Ping 命令检测域名是否可达。
function pingDomain(domain) {
  const command = process.platform === 'darwin' ? '/sbin/ping' : 'ping';
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(PING_TIMEOUT_MS), domain]
    : ['-c', '1', domain];

  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: PING_TIMEOUT_MS,
    }, (error) => resolve(!error));
  });
}

// 在软件启动期间检查一次全部必须联网服务，并缓存本次运行状态。
function checkRequiredOnlineServices() {
  if (startupCheckPromise) return startupCheckPromise;

  startupCheckPromise = Promise.all(Object.values(REQUIRED_ONLINE_SERVICES).map(async (service) => {
    const available = await pingDomain(service.domain);
    const status = { ...service, available, checked: true };
    serviceStatuses.set(service.id, status);
    return status;
  }));

  return startupCheckPromise;
}

// 返回本次启动检查的完整服务状态。
async function getRequiredOnlineServiceStatus() {
  await checkRequiredOnlineServices();
  const services = Array.from(serviceStatuses.values()).map((service) => ({ ...service }));
  return {
    checked: services.every((service) => service.checked),
    services,
    unavailableServices: services.filter((service) => !service.available),
  };
}

// 统一执行必须联网的操作；服务不可用时立即跳过远程调用。
async function executeRequiredOnlineService(serviceId, operation) {
  await checkRequiredOnlineServices();
  const service = serviceStatuses.get(serviceId);
  if (!service) {
    throw new Error(`未知的必须联网服务：${serviceId}`);
  }
  if (!service.available) {
    throw new RequiredOnlineServiceUnavailableError(service);
  }
  return operation();
}

module.exports = {
  REQUIRED_ONLINE_SERVICES,
  RequiredOnlineServiceUnavailableError,
  checkRequiredOnlineServices,
  executeRequiredOnlineService,
  getRequiredOnlineServiceStatus,
};
