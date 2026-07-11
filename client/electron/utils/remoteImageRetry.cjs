const REMOTE_IMAGE_RETRY_ATTEMPTS = 2;
const REMOTE_IMAGE_RETRY_DELAY_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 按统一的远程转图策略执行首次请求和后续重试。
async function runWithRemoteImageRetry(operation, options = {}) {
  const retryAttempts = Math.max(0, Number(options.retryAttempts ?? REMOTE_IMAGE_RETRY_ATTEMPTS) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? REMOTE_IMAGE_RETRY_DELAY_MS) || 0);
  let attempt = 0;

  while (attempt <= retryAttempts) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      if (attempt >= retryAttempts) throw error;
      attempt += 1;
      options.onRetry?.(attempt, error);
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }

  return null;
}

module.exports = {
  REMOTE_IMAGE_RETRY_ATTEMPTS,
  REMOTE_IMAGE_RETRY_DELAY_MS,
  runWithRemoteImageRetry,
};
