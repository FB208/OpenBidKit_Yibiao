const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAiLogsDir } = require('./paths.cjs');

const MAX_AI_LOG_TITLE_LENGTH = 64;

function createAiRequestId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function sanitizeAiLogTitle(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AI_LOG_TITLE_LENGTH)
    .replace(/[. ]+$/g, '');
}

function resolveAiLogTitle(request, fallback = '') {
  return sanitizeAiLogTitle(request?.logTitle || request?.log_title || request?.progressLabel || request?.schemaName || fallback);
}

function buildAiLogFileName(payload) {
  const requestId = String(payload.request_id || createAiRequestId()).trim();
  const logTitle = sanitizeAiLogTitle(payload.log_title);
  if (!logTitle) {
    return `${requestId}.json`;
  }

  const match = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(requestId);
  if (match) {
    return `${match[1]}-${logTitle}-${match[2]}.json`;
  }
  return `${requestId}-${logTitle}.json`;
}

function writeAiLog(app, config, payload) {
  if (!config?.developer_mode) {
    return;
  }

  const logsDir = getAiLogsDir(app);
  fs.mkdirSync(logsDir, { recursive: true });
  const logTitle = sanitizeAiLogTitle(payload.log_title);
  const logPayload = logTitle ? { ...payload, log_title: logTitle } : payload;
  const fileName = buildAiLogFileName(logPayload);
  fs.writeFileSync(path.join(logsDir, fileName), JSON.stringify(logPayload, null, 2), 'utf-8');
}

function getRawAiErrorResponse(error) {
  for (const key of ['raw_response_body', 'raw_response_payload', 'raw_response_data']) {
    if (Object.prototype.hasOwnProperty.call(error || {}, key)) {
      return error[key];
    }
  }
  return undefined;
}

function getAiErrorLogResponse(error, fallbackResponse) {
  const rawResponse = getRawAiErrorResponse(error);
  return rawResponse === undefined ? fallbackResponse : rawResponse;
}

function getAiErrorLogError(error, fallbackMessage) {
  const rawResponse = getRawAiErrorResponse(error);
  return rawResponse === undefined || rawResponse === '' ? fallbackMessage : rawResponse;
}

module.exports = {
  buildAiLogFileName,
  createAiRequestId,
  getAiErrorLogError,
  getAiErrorLogResponse,
  resolveAiLogTitle,
  sanitizeAiLogTitle,
  writeAiLog,
};
