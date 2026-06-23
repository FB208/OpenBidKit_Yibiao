const AI_REQUEST_MAX_ATTEMPTS = 3;
const AI_RETRY_BASE_DELAY_MS = 800;
const AI_RETRY_MAX_DELAY_MS = 4000;

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function normalizeHttpStatus(value) {
  const status = Number(value);
  return Number.isFinite(status) ? Math.floor(status) : 0;
}

function isRetryableHttpStatus(status) {
  const normalized = normalizeHttpStatus(status);
  return RETRYABLE_HTTP_STATUS_CODES.has(normalized) || (normalized >= 500 && normalized <= 599);
}

function getErrorStatus(error) {
  const status = normalizeHttpStatus(error?.status || error?.statusCode);
  if (status) {
    return status;
  }

  return error?.cause ? getErrorStatus(error.cause) : 0;
}

function walkErrorChain(error, visitor, seen = new Set()) {
  if (!error || seen.has(error)) {
    return false;
  }

  seen.add(error);
  if (visitor(error)) {
    return true;
  }

  if (Array.isArray(error.errors)) {
    for (const child of error.errors) {
      if (walkErrorChain(child, visitor, seen)) {
        return true;
      }
    }
  }

  return walkErrorChain(error.cause, visitor, seen);
}

function hasRetryableNetworkCode(error) {
  return walkErrorChain(error, (item) => RETRYABLE_NETWORK_ERROR_CODES.has(String(item?.code || '').toUpperCase()));
}

function isAbortLikeError(error) {
  return walkErrorChain(error, (item) => {
    const name = String(item?.name || '');
    return name === 'AbortError' || name === 'TimeoutError';
  });
}

function isFetchNetworkError(error) {
  return walkErrorChain(error, (item) => {
    const name = String(item?.name || '');
    const message = String(item?.message || '').toLowerCase();
    return name === 'TypeError' && (
      message.includes('fetch failed')
      || message.includes('network')
      || message.includes('socket')
    );
  });
}

function markAiRequestError(error, options = {}) {
  const target = error instanceof Error ? error : new Error(String(error || 'AI 请求失败'));
  target.isAiRequestError = true;

  if (Object.prototype.hasOwnProperty.call(options, 'retryable')) {
    target.aiRequestRetryable = Boolean(options.retryable);
  }

  return target;
}

function copyAiRequestErrorMeta(source, target) {
  if (!source || !target) {
    return target;
  }

  if (source.isAiRequestError) {
    target.isAiRequestError = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, 'aiRequestRetryable')) {
    target.aiRequestRetryable = Boolean(source.aiRequestRetryable);
  }

  if (source.cause && !target.cause) {
    target.cause = source.cause;
  }

  return target;
}

function isRetryableAiRequestError(error) {
  if (!error || error?.code === 'AI_QUEUE_SCOPE_PAUSED') {
    return false;
  }

  if (error.aiRequestRetryable === false) {
    return false;
  }

  if (error.aiRequestRetryable === true) {
    return true;
  }

  const status = getErrorStatus(error);
  if (status) {
    return isRetryableHttpStatus(status);
  }

  if (isAbortLikeError(error)) {
    return true;
  }

  return hasRetryableNetworkCode(error) || isFetchNetworkError(error);
}

function getAiRetryDelayMs(failedAttempt) {
  const attempt = Math.max(1, Number(failedAttempt) || 1);
  return Math.min(AI_RETRY_MAX_DELAY_MS, AI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
}

function getAbortReason(signal) {
  return signal?.reason || new Error('AI 请求已取消');
}

function delay(ms, signal) {
  if (!ms) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(getAbortReason(signal));
      return;
    }

    const cleanup = () => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(getAbortReason(signal));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function runWithAiRetry(runner, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || AI_REQUEST_MAX_ATTEMPTS));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw getAbortReason(options.signal);
    }

    try {
      return await runner({ attempt, maxAttempts });
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt >= maxAttempts || !isRetryableAiRequestError(error)) {
        throw error;
      }

      await Promise.resolve(options.onRetry?.({ error, attempt, nextAttempt: attempt + 1, maxAttempts }));
      const delayMs = typeof options.getDelayMs === 'function'
        ? options.getDelayMs({ error, attempt, nextAttempt: attempt + 1, maxAttempts })
        : getAiRetryDelayMs(attempt);
      await delay(delayMs, options.signal);
    }
  }

  throw lastError || new Error('AI 请求失败');
}

module.exports = {
  AI_REQUEST_MAX_ATTEMPTS,
  copyAiRequestErrorMeta,
  getAiRetryDelayMs,
  isRetryableAiRequestError,
  isRetryableHttpStatus,
  markAiRequestError,
  runWithAiRetry,
};
