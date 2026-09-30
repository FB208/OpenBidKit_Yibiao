const test = require('node:test');
const assert = require('node:assert/strict');
const { AI_UPSTREAM_UNAVAILABLE, createAiBatchGuard, isBatchCancelled } = require('./aiBatchGuard.cjs');
const { createQueueScopePausedError } = require('./aiRequestQueue.cjs');
const { markAiRequestError } = require('./aiRetry.cjs');

const upstreamError = message => markAiRequestError(new Error(message), { retryable: false });

test('连续 AI 请求失败达到上限时停止本批并带服务端原因', () => {
  const guard = createAiBatchGuard({ limit: 3 });
  guard.failure(upstreamError('结算失败'));
  guard.failure(upstreamError('结算失败'));
  assert.equal(guard.error, null);
  assert.equal(guard.signal.aborted, false);
  guard.failure(upstreamError('AI请求结算失败，请求已结束'));
  assert.equal(guard.error.code, AI_UPSTREAM_UNAVAILABLE);
  assert.match(guard.error.message, /连续 3 个请求失败.*最后一次错误：AI请求结算失败，请求已结束/);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason, guard.error);
});

test('成功或服务有响应的校验失败清零计数', () => {
  const guard = createAiBatchGuard({ limit: 2 });
  guard.failure(upstreamError('超时'));
  guard.success();
  guard.failure(upstreamError('超时'));
  guard.failure(new Error('一致性核对结果无效：facts 每项须包含合法 category'));
  guard.failure(upstreamError('超时'));
  assert.equal(guard.error, null);
  guard.failure(upstreamError('超时'));
  assert.equal(guard.error.code, AI_UPSTREAM_UNAVAILABLE);
});

test('暂停丢弃和父任务中止不计入失败', () => {
  const parent = new AbortController();
  const guard = createAiBatchGuard({ signal: parent.signal, limit: 2 });
  guard.failure(createQueueScopePausedError());
  guard.failure(createQueueScopePausedError());
  assert.equal(guard.error, null);
  assert.equal(isBatchCancelled(createQueueScopePausedError(), guard.signal), true);
  parent.abort(new Error('暂停'));
  guard.failure(upstreamError('请求已取消'));
  guard.failure(upstreamError('请求已取消'));
  assert.equal(guard.error, null);
  assert.equal(isBatchCancelled(new Error('任意'), guard.signal), true);
});
