const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDeveloperLogsDir } = require('./paths.cjs');

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

function normalizeDeveloperConfig(config) {
  return config && typeof config === 'object' ? config : {};
}

function compactErrorMessage(error) {
  return String(error?.message || error || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function createDeveloperLogger({ app, config, moduleName, name, meta } = {}) {
  const normalizedConfig = normalizeDeveloperConfig(config);
  if (!normalizedConfig.developer_mode) {
    return createNoopDeveloperLogger();
  }

  const scope = sanitizeDeveloperLogModule(moduleName);
  const logName = sanitizeDeveloperLogTitle(name || scope);
  const logId = createDeveloperLogId();

  let filePath = '';
  try {
    const logsDir = getDeveloperLogsDir(app, scope);
    fs.mkdirSync(logsDir, { recursive: true });
    filePath = path.join(logsDir, buildDeveloperLogFileName({ log_id: logId, log_title: logName }));
  } catch (error) {
    console.warn(`[${scope}] 创建开发者日志失败`, error);
    return createNoopDeveloperLogger();
  }

  function write(event, payload = {}) {
    try {
      const entry = {
        at: new Date().toISOString(),
        scope,
        log_id: logId,
        event: String(event || 'event'),
        ...payload,
      };
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (error) {
      console.warn(`[${scope}] 写入开发者日志失败`, compactErrorMessage(error));
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
