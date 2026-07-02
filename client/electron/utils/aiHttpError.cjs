const {
  isRetryableHttpStatus,
  markAiRequestError,
} = require('./aiRetry.cjs');

function getBrowserWindow() {
  try {
    return require('electron').BrowserWindow;
  } catch {
    return null;
  }
}

function getHeaderValue(headers, name) {
  if (!headers?.get) return '';
  return headers.get(name) || '';
}

function parseResponseDetail(rawText) {
  try {
    const body = rawText ? JSON.parse(rawText) : null;
    return body?.error?.message || body?.message || '';
  } catch {
    return '';
  }
}

function createAiHttpErrorPayload(response, rawText, source) {
  return {
    status: Number(response?.status || 0),
    statusText: response?.statusText || '',
    contentType: getHeaderValue(response?.headers, 'content-type'),
    body: String(rawText || ''),
    source: source || 'ai-service',
    createdAt: new Date().toISOString(),
  };
}

function isAiHttpErrorHtmlPayload(payload) {
  if (!payload) return false;
  const contentType = String(payload.contentType || '').toLowerCase();
  if (contentType.includes('html')) return true;
  return /<!doctype\s+html|<html[\s>]/i.test(String(payload.body || ''));
}

function formatAiHttpErrorMessage(payload) {
  const statusLabel = payload.status
    ? `HTTP ${payload.status}${payload.statusText ? ` ${payload.statusText}` : ''}`
    : 'HTTP 错误';
  return `AI 服务商返回 ${statusLabel} 错误，请查看弹窗中的原始返回内容。`;
}

async function createAiHttpErrorFromResponse(response, fallbackMessage = 'AI 请求失败', options = {}) {
  const rawText = await response.text().catch(() => '');
  const payload = createAiHttpErrorPayload(response, rawText, options.source);
  const detail = parseResponseDetail(rawText);
  const message = isAiHttpErrorHtmlPayload(payload)
    ? formatAiHttpErrorMessage(payload)
    : detail || String(rawText || '').trim() || fallbackMessage;
  const error = new Error(message);

  if (payload.status) {
    error.status = payload.status;
    error.statusCode = payload.status;
  }
  error.raw_response_body = rawText;
  error.aiHttpError = payload;
  error.ai_http_error = payload;
  error.aiHttpErrorDetail = detail;
  if (typeof options.responseFormatUnsupportedChecker === 'function') {
    error.responseFormatUnsupported = options.responseFormatUnsupportedChecker(detail || rawText);
  }

  return markAiRequestError(error, { retryable: isRetryableHttpStatus(payload.status) });
}

function getAiHttpError(error) {
  if (!error) return null;
  if (error.aiHttpError) return error.aiHttpError;
  if (error.ai_http_error) return error.ai_http_error;
  if (error.cause) return getAiHttpError(error.cause);
  return null;
}

function copyAiHttpError(source, target) {
  const payload = getAiHttpError(source);
  if (!payload || !target) return target;
  target.aiHttpError = payload;
  target.ai_http_error = payload;
  if (source.aiHttpErrorDetail) {
    target.aiHttpErrorDetail = source.aiHttpErrorDetail;
  }
  return target;
}

function emitAiHttpErrorToWindows(errorOrPayload, overrides = {}) {
  const payload = getAiHttpError(errorOrPayload) || errorOrPayload;
  if (!payload?.body && !payload?.status) return false;
  if (!isAiHttpErrorHtmlPayload(payload)) return false;
  const BrowserWindow = getBrowserWindow();
  if (!BrowserWindow?.getAllWindows) return false;

  const eventPayload = {
    ...payload,
    ...overrides,
  };

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('ai:http-error', eventPayload);
    }
  }
  return true;
}

module.exports = {
  copyAiHttpError,
  createAiHttpErrorFromResponse,
  emitAiHttpErrorToWindows,
  getAiHttpError,
  isAiHttpErrorHtmlPayload,
};
