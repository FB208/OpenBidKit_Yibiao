const path = require('node:path');
const crypto = require('node:crypto');
const { getDeveloperLogsDir } = require('./paths.cjs');
const { enqueueDailyJsonLine, enqueueJsonLine } = require('./silentFileLog.cjs');

const MAX_LOG_TITLE_LENGTH = 64;

function createDeveloperLogId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function sanitizeDeveloperLogTitle(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LOG_TITLE_LENGTH)
    .replace(/[. ]+$/g, '');
}

function sanitizeDeveloperLogModule(value) {
  return String(value || 'app')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

function buildDeveloperLogFileName(payload = {}) {
  const logId = String(payload.log_id || createDeveloperLogId()).trim();
  const logTitle = sanitizeDeveloperLogTitle(payload.log_title);
  if (!logTitle) {
    return `${logId}.jsonl`;
  }

  const match = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(logId);
  if (match) {
    return `${match[1]}-${logTitle}-${match[2]}.jsonl`;
  }
  return `${logId}-${logTitle}.jsonl`;
}

function createNoopDeveloperLogger() {
  return { enabled: false, filePath: '', logId: '', write() {} };
}

function compactErrorMessage(error) {
  return String(error?.message || error || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// 创建固定文件或按天追加的模块诊断日志。
function createDeveloperLogger({ app, moduleName, name, meta, daily = false } = {}) {
  const scope = sanitizeDeveloperLogModule(moduleName);
  const logName = sanitizeDeveloperLogTitle(name || scope);
  const logId = createDeveloperLogId();

  let filePath = '';
  try {
    const logsDir = getDeveloperLogsDir(app, scope);
    const fileName = daily ? `${scope}.jsonl` : buildDeveloperLogFileName({ log_id: logId, log_title: logName });
    filePath = path.join(logsDir, fileName);
  } catch {
    return createNoopDeveloperLogger();
  }

  // 统一保留事件字段，按日模式用同一时间选择文件。
  function write(event, payload = {}) {
    try {
      const at = new Date().toISOString();
      const entry = { at, scope, log_id: logId, event: String(event || 'event'), ...payload };
      if (daily) enqueueDailyJsonLine(filePath, at, entry);
      else enqueueJsonLine(filePath, entry);
    } catch {
      // 日志不能影响主流程。
    }
  }

  write('logger.created', { name: logName, meta: meta || {} });
  return { enabled: true, filePath, logId, write };
}

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function textMetrics(value) {
  const content = String(value || '');
  return {
    chars: content.length,
    hash: textHash(content),
  };
}

function compactLogError(error) {
  return {
    name: error?.name || 'Error',
    message: compactErrorMessage(error),
    stack: String(error?.stack || '').slice(0, 3000),
  };
}

module.exports = {
  buildDeveloperLogFileName,
  compactLogError,
  createDeveloperLogger,
  createDeveloperLogId,
  createNoopDeveloperLogger,
  sanitizeDeveloperLogModule,
  sanitizeDeveloperLogTitle,
  textHash,
  textMetrics,
};
