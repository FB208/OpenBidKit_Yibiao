const RETRYABLE_ERROR_PREFIX = 'Provider returned error: ';
const UPSTREAM_TEMPORARILY_UNAVAILABLE_PATTERN = /\bupstream service temporarily unavailable\b/i;
const PI_RETRY_ERROR_NORMALIZER_NAME = 'yibiao-retry-error-normalizer';
const PI_RETRY_ERROR_NORMALIZER_PATH = `<inline:${PI_RETRY_ERROR_NORMALIZER_NAME}>`;

// 将已知网关瞬时错误转换为 Pi 原生重试能够识别的错误表达。
function normalizePiRetryableErrorMessage(value) {
  const message = String(value || '').trim();
  if (!message || message.startsWith(RETRYABLE_ERROR_PREFIX)) return message;
  if (!UPSTREAM_TEMPORARILY_UNAVAILABLE_PATTERN.test(message)) return message;
  return `${RETRYABLE_ERROR_PREFIX}${message}`;
}

// 对用户界面和业务状态恢复网关返回的原始错误文案。
function restorePiErrorMessage(value) {
  const message = String(value || '');
  return message.startsWith(RETRYABLE_ERROR_PREFIX)
    ? message.slice(RETRYABLE_ERROR_PREFIX.length)
    : message;
}

// 注册内联扩展，在 Pi 判定自动重试前规范化当前 Provider 的错误消息。
function createPiRetryErrorNormalizer() {
  return {
    name: PI_RETRY_ERROR_NORMALIZER_NAME,
    factory(pi) {
      pi.on('message_end', (event, context) => {
        const message = event.message;
        if (message?.role !== 'assistant' || message.stopReason !== 'error') return undefined;
        if (message.provider !== 'yibiao' && context.model?.provider !== 'yibiao') return undefined;
        const normalized = normalizePiRetryableErrorMessage(message.errorMessage);
        if (!normalized || normalized === message.errorMessage) return undefined;
        return { message: { ...message, errorMessage: normalized } };
      });
    },
  };
}

module.exports = {
  PI_RETRY_ERROR_NORMALIZER_PATH,
  createPiRetryErrorNormalizer,
  normalizePiRetryableErrorMessage,
  restorePiErrorMessage,
};
