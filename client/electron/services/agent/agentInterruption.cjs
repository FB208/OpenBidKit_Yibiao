const EXPECTED_INTERRUPTION_CODES = new Set([
  'AGENT_DISCONNECTED',
  'AI_QUEUE_SCOPE_PAUSED',
  'CONTENT_GENERATION_PAUSED',
  'TASK_CANCELLED',
]);

// 将父任务的默认 AbortError 转为带稳定错误码的任务取消错误。
function resolveAgentAbortReason(signal, fallbackMessage = 'Agent 任务已取消') {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  const error = new Error(reason && reason.name !== 'AbortError' ? String(reason) : fallbackMessage);
  error.code = 'TASK_CANCELLED';
  return error;
}

// 识别用户操作或应用生命周期导致的正常中断，避免计入 Agent 失败统计。
function isExpectedAgentInterruption(error) {
  const code = String(error?.code || error?.cause?.code || '');
  const message = String(error?.message || error || '');
  return EXPECTED_INTERRUPTION_CODES.has(code)
    || message === 'CONTENT_GENERATION_PAUSED'
    || message.includes('请求已取消')
    || message.includes('任务已取消')
    || message.includes('服务正在关闭')
    || message.includes('队列已暂停');
}

module.exports = {
  isExpectedAgentInterruption,
  resolveAgentAbortReason,
};
