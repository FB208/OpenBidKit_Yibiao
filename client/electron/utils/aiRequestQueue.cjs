const AI_QUEUE_SCOPE_PAUSED = 'AI_QUEUE_SCOPE_PAUSED';
const AI_QUEUE_MAX_RATE_LIMIT_RETRIES = 3;

function createQueueScopePausedError() {
  const error = new Error('AI 请求队列已暂停');
  error.code = AI_QUEUE_SCOPE_PAUSED;
  return error;
}

function isRateLimitError(error) {
  if (error?.status === 429 || error?.statusCode === 429) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('too many requests');
}

function normalizeLimit(value, fallback = 10) {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? Math.round(number) : fallback);
}

function createAiRequestQueue(options = {}) {
  let activeCount = 0;
  const queue = [];
  const pausedScopes = new Set();
  const getLimit = typeof options.getLimit === 'function'
    ? options.getLimit
    : () => options.limit || 10;
  const fallbackLimit = normalizeLimit(options.defaultLimit, 10);

  function currentLimit() {
    try {
      return normalizeLimit(getLimit(), fallbackLimit);
    } catch {
      return fallbackLimit;
    }
  }

  function rejectIfPaused(job) {
    if (!job.scopeId || !pausedScopes.has(job.scopeId)) {
      return false;
    }

    job.reject(createQueueScopePausedError());
    return true;
  }

  function pump() {
    while (activeCount < currentLimit() && queue.length) {
      const job = queue.shift();
      if (rejectIfPaused(job)) {
        continue;
      }

      activeCount += 1;
      void runJob(job);
    }
  }

  async function runJob(job) {
    try {
      if (rejectIfPaused(job)) {
        return;
      }

      const result = await job.runner();
      job.resolve(result);
    } catch (error) {
      if (isRateLimitError(error) && job.rateLimitRetries < AI_QUEUE_MAX_RATE_LIMIT_RETRIES) {
        job.rateLimitRetries += 1;
        queue.push(job);
      } else {
        job.reject(error);
      }
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      pump();
    }
  }

  function enqueue(runner, options = {}) {
    return new Promise((resolve, reject) => {
      const job = {
        runner,
        resolve,
        reject,
        scopeId: String(options.scopeId || options.queueScopeId || '').trim(),
        rateLimitRetries: 0,
      };

      if (rejectIfPaused(job)) {
        return;
      }

      queue.push(job);
      pump();
    });
  }

  function pauseScope(scopeId) {
    const normalizedScopeId = String(scopeId || '').trim();
    if (!normalizedScopeId) {
      return 0;
    }

    pausedScopes.add(normalizedScopeId);
    let discarded = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const job = queue[index];
      if (job.scopeId !== normalizedScopeId) {
        continue;
      }

      queue.splice(index, 1);
      job.reject(createQueueScopePausedError());
      discarded += 1;
    }

    return discarded;
  }

  function resumeScope(scopeId) {
    const normalizedScopeId = String(scopeId || '').trim();
    if (normalizedScopeId) {
      pausedScopes.delete(normalizedScopeId);
    }
  }

  function getStatus() {
    return {
      active: activeCount,
      queued: queue.length,
      limit: currentLimit(),
      pausedScopes: [...pausedScopes],
    };
  }

  return {
    enqueue,
    pauseScope,
    resumeScope,
    getStatus,
  };
}

module.exports = {
  AI_QUEUE_SCOPE_PAUSED,
  AI_QUEUE_MAX_RATE_LIMIT_RETRIES,
  createAiRequestQueue,
  createQueueScopePausedError,
};
