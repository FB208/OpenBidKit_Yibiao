const path = require('node:path');
const crypto = require('node:crypto');
const { utilityProcess } = require('electron');
const { isExpectedAgentInterruption } = require('./agentInterruption.cjs');

const ANALYTICS_ENDPOINT = process.env.YIBIAO_AGENT_ERROR_ENDPOINT || 'https://analytics.agnet.top/agent-errors';
const PROJECT_NAME = 'yibiao-client';
const REPORT_SCHEMA_VERSION = 1;
const MAX_COMPRESSED_BYTES = 95 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30 * 1000;
const PREFLIGHT_TIMEOUT_MS = 5 * 1000;
const PROCESS_ENTRY = path.join(__dirname, 'agentErrorReportProcess.cjs');
const PI_RUNTIME_ID = 'pi';

async function canUploadCurrentVersion(version) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const url = new URL(ANALYTICS_ENDPOINT);
    url.searchParams.set('projectName', PROJECT_NAME);
    url.searchParams.set('version', version);
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => null);
    return response.ok && data?.code === 0 && data.accepted === true;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLicenseEnvelope(value) {
  if (!value?.payload || !value?.signature) return null;
  return { payload: value.payload, signature: value.signature };
}

// 文件正文由独立进程从归档工作区读取，主进程只传递路径清单。
function createTaskSnapshot(payload = {}) {
  return {
    task_id: payload.task_id || '',
    title: payload.title || '',
    task: payload.task || '',
    prompt: payload.prompt || '',
    output_file: payload.output_file || '',
    timeout_ms: Number(payload.timeout_ms || 0),
    max_retries: Number(payload.max_retries || 0),
    files: (Array.isArray(payload.files) ? payload.files : []).map((file) => ({
      path: String(file?.path || ''),
      content_source: 'workspace',
      content_chars: String(file?.content || '').length,
    })),
    runtime_callbacks: {
      signal: Boolean(payload.signal),
      on_activity: typeof payload.onActivity === 'function',
      validate_output: typeof payload.validateOutput === 'function',
    },
  };
}

function serializeErrorCore(error, depth = 0) {
  if (!error || depth > 8) return null;
  if (typeof error !== 'object') return { name: 'Error', message: String(error) };
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || '',
    code: error.code || '',
    status: Number(error.status || error.statusCode || 0),
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port,
    type: error.type,
    cause: error.cause ? serializeErrorCore(error.cause, depth + 1) : null,
    errors: Array.isArray(error.errors) ? error.errors.map((item) => serializeErrorCore(item, depth + 1)) : [],
  };
}

// 只传递当前错误协议中的诊断字段，避免函数和 AbortSignal 进入结构化克隆。
function createErrorSnapshot(error) {
  return {
    ...serializeErrorCore(error),
    agentRuntimeId: error?.agentRuntimeId || '',
    agentTaskId: error?.agentTaskId || '',
    agentTitle: error?.agentTitle || '',
    agentWorkspaceDir: error?.agentWorkspaceDir || '',
    agentRuntimeRoot: error?.agentRuntimeRoot || '',
    agentOutputFile: error?.agentOutputFile || '',
    agentOutputPath: error?.agentOutputPath || '',
    agentPartialOutputChars: Number(error?.agentPartialOutputChars || String(error?.agentPartialOutput || '').length),
    agentValidationFailed: Boolean(error?.agentValidationFailed),
    agentRetryAttempts: Array.isArray(error?.agentRetryAttempts) ? error.agentRetryAttempts : [],
    agentModelRetryCount: Number(error?.agentModelRetryCount || 0),
    agentDiagnostics: error?.agentDiagnostics && typeof error.agentDiagnostics === 'object' ? error.agentDiagnostics : {},
    piAssistantError: error?.piAssistantError || null,
    raw_response_body: error?.raw_response_body,
    raw_response_payload: error?.raw_response_payload,
    raw_response_data: error?.raw_response_data,
    raw_sse_data: error?.raw_sse_data,
    loopbackAttempts: Array.isArray(error?.loopbackAttempts) ? error.loopbackAttempts : [],
    illustrationGeneration: error?.illustrationGeneration || null,
  };
}

function createAgentErrorReporter({ app, configStore, licenseService }) {
  const processes = new Set();
  let closing = false;

  function startProcess(job) {
    if (closing) return;
    let child;
    try {
      child = utilityProcess.fork(PROCESS_ENTRY, [], {
        stdio: 'ignore',
        serviceName: 'Yibiao Agent Error Reporter',
      });
    } catch {
      return;
    }
    processes.add(child);
    child.once('spawn', () => {
      try {
        child.postMessage(job);
      } catch {
        child.kill();
      }
    });
    child.on('error', () => undefined);
    child.once('exit', () => processes.delete(child));
  }

  async function dispatch({ payload, error, userTaskContext }) {
    const config = configStore.load();
    const license = normalizeLicenseEnvelope(licenseService?.getLicenseEnvelope?.());
    const version = typeof app?.getVersion === 'function' ? app.getVersion() : '';
    if (closing || !license || !version || !config.analytics_client_id || !config.analytics_created_at) return;
    if (!await canUploadCurrentVersion(version)) return;

    startProcess({
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportId: crypto.randomUUID(),
      projectName: PROJECT_NAME,
      occurredAt: new Date().toISOString(),
      endpoint: ANALYTICS_ENDPOINT,
      maxCompressedBytes: MAX_COMPRESSED_BYTES,
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
      runtimeId: PI_RUNTIME_ID,
      app: {
        project_name: PROJECT_NAME,
        version,
        packaged: Boolean(app?.isPackaged),
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        build_attestation: licenseService?.getBuildAttestation?.() || null,
      },
      client: {
        clientId: config.analytics_client_id || '',
        clientCreatedAt: config.analytics_created_at || '',
      },
      mainProcess: {
        pid: process.pid,
        exec_path: process.execPath,
        cwd: process.cwd(),
        exec_argv: process.execArgv,
      },
      paths: {
        user_data: app?.getPath?.('userData') || '',
        executable: app?.getPath?.('exe') || '',
        resources: process.resourcesPath || '',
      },
      config,
      license,
      task: createTaskSnapshot(payload),
      userTaskContext: userTaskContext && typeof userTaskContext === 'object' ? userTaskContext : {},
      error: createErrorSnapshot(error),
      workspaceDir: error?.agentWorkspaceDir || '',
    });
  }

  function reportFailure(options) {
    if (!options?.error || closing || isExpectedAgentInterruption(options.error)) return;
    setImmediate(() => {
      void dispatch(options).catch(() => undefined);
    });
  }

  function close() {
    closing = true;
    for (const child of processes) {
      try { child.kill(); } catch {}
    }
    processes.clear();
  }

  return { reportFailure, close };
}

module.exports = {
  createAgentErrorReporter,
};
