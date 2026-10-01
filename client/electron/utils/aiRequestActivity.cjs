const { AsyncLocalStorage } = require('node:async_hooks');

const activityStorage = new AsyncLocalStorage();

// 获取当前异步调用链所属的 Agent；普通业务请求没有 Agent 上下文。
function getAiRequestActivity() {
  return activityStorage.getStore() || null;
}

// 在指定 Agent 上下文中执行，包括显式清除无归属请求的上下文。
function runWithAiRequestActivity(activity, runner) {
  return activityStorage.run(activity, runner);
}

// 入队时固定请求归属，出队或重试时恢复，避免继承驱动队列的其他请求。
function bindAiRequestActivity(runner) {
  const activity = getAiRequestActivity();
  return (...args) => runWithAiRequestActivity(activity, () => runner(...args));
}

// 仅报告真实 AI 响应，由所属 Agent 决定是否刷新并通知父任务。
function notifyAiResponse(activity = getAiRequestActivity()) {
  activity?.onResponse();
}

// 每次实际请求成功或失败都通知，保持原返回值和错误不变。
async function withAiResponseActivity(runner) {
  const activity = getAiRequestActivity();
  try {
    return await runner();
  } finally {
    notifyAiResponse(activity);
  }
}

module.exports = {
  getAiRequestActivity,
  runWithAiRequestActivity,
  bindAiRequestActivity,
  notifyAiResponse,
  withAiResponseActivity,
};
