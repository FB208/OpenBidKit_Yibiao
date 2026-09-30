const { AI_QUEUE_SCOPE_PAUSED } = require('./aiRequestQueue.cjs');

const AI_UPSTREAM_UNAVAILABLE = 'AI_UPSTREAM_UNAVAILABLE';
const AI_UPSTREAM_FAILURE_LIMIT = 10;

// 暂停时队列丢弃的请求与信号中止一样按已中断处理，不计为失败。
function isBatchCancelled(error, signal) {
  return Boolean(signal?.aborted) || error?.code === AI_QUEUE_SCOPE_PAUSED;
}

// 批量程序步骤中连续多项 AI 请求本身失败（未拿到可用回复）且期间无成功时，判定服务不可用并停止派发剩余项。
// 服务有响应的校验失败会清零计数；暂停、取消及本批已停止后的结果不计入。
function createAiBatchGuard({ signal, limit = AI_UPSTREAM_FAILURE_LIMIT } = {}) {
  const controller = new AbortController();
  const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let failures = 0;
  let tripped = null;
  return {
    signal: batchSignal,
    get error() { return tripped; },
    success() {
      if (!tripped) failures = 0;
    },
    failure(error) {
      if (tripped || isBatchCancelled(error, batchSignal)) return;
      if (error?.isAiRequestError !== true) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < limit) return;
      tripped = new Error(`AI 服务连续 ${limit} 个请求失败，已停止派发剩余请求，已完成结果已保留，服务恢复后点击继续即可接着处理。最后一次错误：${error.message || error}`);
      tripped.code = AI_UPSTREAM_UNAVAILABLE;
      tripped.cause = error;
      controller.abort(tripped);
    },
  };
}

module.exports = {
  AI_UPSTREAM_FAILURE_LIMIT,
  AI_UPSTREAM_UNAVAILABLE,
  createAiBatchGuard,
  isBatchCancelled,
};
