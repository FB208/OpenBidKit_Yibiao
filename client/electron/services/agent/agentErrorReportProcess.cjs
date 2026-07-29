const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { gzip } = require('node:zlib');

const gzipAsync = promisify(gzip);
const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|mineru[_-]?token|password|passwd|secret|cookie|session[_-]?token/i;

// 收集配置中的全部凭据值，用于清除错误文本和任务正文中的已知密钥。
function collectConfiguredSecrets(value, secrets = new Set(), ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object' || ancestors.has(value)) return secrets;
  ancestors.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof item === 'string' && item.trim()) secrets.add(item);
      if (item && typeof item === 'object') collectConfiguredSecrets(item, secrets, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
  return secrets;
}

// 清除字符串中的已配置凭据和常见认证信息格式。
function redactText(value, configuredSecrets) {
  let text = String(value || '');
  for (const secret of configuredSecrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
}

function redactBinary(buffer, configuredSecrets) {
  const result = Buffer.from(buffer);
  for (const secret of configuredSecrets) {
    const secretBuffer = Buffer.from(secret, 'utf-8');
    if (!secretBuffer.length) continue;
    let offset = result.indexOf(secretBuffer);
    while (offset >= 0) {
      result.fill(42, offset, offset + secretBuffer.length);
      offset = result.indexOf(secretBuffer, offset + secretBuffer.length);
    }
  }
  return result;
}

// 将诊断数据转换为可序列化结构，并在独立进程中完成全部脱敏。
function sanitizeValue(value, configuredSecrets, ancestors = new WeakSet(), keyName = '') {
  if (SENSITIVE_KEY_PATTERN.test(keyName)) return value ? '[REDACTED]' : value;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactText(value, configuredSecrets);
  if (typeof value === 'function') return `[Function:${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'Buffer', encoding: 'base64', data: redactBinary(Buffer.from(value), configuredSecrets).toString('base64') };
  }
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, configuredSecrets, ancestors));
    const result = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        result[key] = sanitizeValue(value[key], configuredSecrets, ancestors, key);
      } catch (error) {
        result[key] = `[Unreadable:${redactText(error?.message || error, configuredSecrets)}]`;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isProbablyText(buffer) {
  if (!buffer.length) return true;
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

// 在独立进程中读取完整任务归档，不阻塞 Electron 主进程。
function collectWorkspaceFiles(rootDir, configuredSecrets) {
  const root = String(rootDir || '').trim();
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  function visit(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filePath);
      const buffer = fs.readFileSync(filePath);
      const textFile = isProbablyText(buffer);
      files.push({
        path: path.relative(root, filePath).replace(/\\/g, '/'),
        absolute_path: redactText(filePath, configuredSecrets),
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        encoding: textFile ? 'utf-8' : 'base64',
        content: textFile ? redactText(buffer.toString('utf-8'), configuredSecrets) : redactBinary(buffer, configuredSecrets).toString('base64'),
      });
    }
  }
  visit(root);
  return files;
}

function parseJsonObject(raw) {
  try {
    const value = JSON.parse(String(raw || ''));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// OpenCode 会话数据库只在独立进程读取，避免主进程同步扫描历史消息。
function readOpenCodeSession(reference = {}) {
  const sessionId = String(reference.session_id || '').trim();
  const databasePath = String(reference.database_path || '').trim();
  if (!sessionId || !databasePath || !fs.existsSync(databasePath)) return reference;
  let db = null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const messages = db.prepare('SELECT id, data FROM message ORDER BY id ASC').all()
      .map((row) => ({ id: row.id, data: parseJsonObject(row.data) || row.data }))
      .filter((row) => [row.data?.sessionID, row.data?.session_id].includes(sessionId));
    const events = db.prepare(`
      SELECT seq, type, data
      FROM event
      WHERE aggregate_id = ?
      ORDER BY seq ASC
    `).all(sessionId).map((row) => ({ seq: row.seq, type: row.type, data: parseJsonObject(row.data) || row.data }));
    return { session_id: sessionId, database_path: databasePath, messages, events };
  } catch (error) {
    return { ...reference, error: error?.message || String(error) };
  } finally {
    try { db?.close?.(); } catch {}
  }
}

function enrichRuntimeDiagnostics(job) {
  const diagnostics = job.error?.agentDiagnostics && typeof job.error.agentDiagnostics === 'object'
    ? { ...job.error.agentDiagnostics }
    : {};
  if (job.runtimeId === 'opencode' && diagnostics.session) diagnostics.session = readOpenCodeSession(diagnostics.session);
  return { ...job.error, agentDiagnostics: diagnostics };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function createReportMeta(job, error, originalBytes, compressedBytes, configuredSecrets) {
  return {
    schemaVersion: job.schemaVersion,
    reportId: job.reportId,
    projectName: job.projectName,
    occurredAt: job.occurredAt,
    version: job.app.version,
    platform: job.app.platform,
    arch: job.app.arch,
    clientId: job.client.clientId,
    clientCreatedAt: job.client.clientCreatedAt,
    runtime: job.runtimeId,
    errorName: redactText(error?.name || 'Error', configuredSecrets).slice(0, 120),
    errorCode: redactText(error?.code || error?.cause?.code || '', configuredSecrets).slice(0, 120),
    errorSummary: redactText(error?.message || 'Agent 执行失败', configuredSecrets).slice(0, 1000),
    originalBytes,
    compressedBytes,
  };
}

// 独立进程完成完整诊断包构造、压缩和上传。
async function runReport(job) {
  const configuredSecrets = [...collectConfiguredSecrets(job.config)].filter(Boolean).sort((left, right) => right.length - left.length);
  const error = enrichRuntimeDiagnostics(job);
  const report = {
    schema_version: job.schemaVersion,
    report_id: job.reportId,
    occurred_at: job.occurredAt,
    app: sanitizeValue(job.app, configuredSecrets),
    client: {
      client_id: job.client.clientId,
      client_created_at: job.client.clientCreatedAt,
      license_payload: sanitizeValue(job.license.payload, configuredSecrets),
    },
    system: {
      os: {
        type: os.type(),
        release: os.release(),
        version: os.version(),
        arch: os.arch(),
        hostname: os.hostname(),
        total_memory: os.totalmem(),
        free_memory: os.freemem(),
        cpus: os.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
      },
      process: sanitizeValue(job.mainProcess, configuredSecrets),
      report_process: { pid: process.pid },
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      paths: sanitizeValue(job.paths, configuredSecrets),
    },
    runtime: job.runtimeId,
    task: sanitizeValue(job.task, configuredSecrets),
    error: sanitizeValue(error, configuredSecrets),
    config: sanitizeValue(job.config, configuredSecrets),
    workspace: {
      root: redactText(job.workspaceDir, configuredSecrets),
      files: collectWorkspaceFiles(job.workspaceDir, configuredSecrets),
    },
  };
  const source = Buffer.from(JSON.stringify(report), 'utf-8');
  const compressed = await gzipAsync(source, { level: 6 });
  if (!compressed.length || compressed.length > job.maxCompressedBytes) return;
  const meta = createReportMeta(job, error, source.length, compressed.length, configuredSecrets);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.uploadTimeoutMs);
  try {
    const response = await fetch(job.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(compressed.length),
        'X-Yibiao-Report-Meta': base64UrlJson(meta),
        'X-Yibiao-License': base64UrlJson(job.license),
      },
      body: compressed,
      signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => undefined);
  } finally {
    clearTimeout(timeout);
  }
}

process.parentPort.once('message', (event) => {
  void runReport(event.data)
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
