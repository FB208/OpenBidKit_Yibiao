const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BUNDLED_COMMANDS,
  SHIM_COMMANDS,
} = require('../agent/agentToolEnvironment.cjs');

const EXPECTED_PI_TOOLS = ['read', 'bash', 'edit', 'write', 'find', 'ls'];
const CRITICAL_COMMANDS = new Set(['node', ...BUNDLED_COMMANDS]);
const COMMANDS = ['node', ...BUNDLED_COMMANDS, ...SHIM_COMMANDS];
const MODEL_CHECK_TIMEOUT_MS = 30000;
const LOOPBACK_CHECK_TIMEOUT_MS = 5000;
const REPORT_VERSION = 2;

const SAFE_REPAIR_ACTIONS = [
  { id: 'apply-loopback-no-proxy', label: '为当前进程补充 loopback NO_PROXY', changes: '仅修改当前客户端进程环境变量' },
  { id: 'restart-pi-runtime', label: '重启 Pi Runtime 和本地 AI Proxy', changes: '重启应用内部运行时' },
  { id: 'rebuild-pi-tool-environment', label: '重建 Pi 集成工具环境', changes: '重写应用专用运行目录中的命令 shim' },
  { id: 'reset-pi-self-check-workspace', label: '清理 Pi 自检临时工作区', changes: '仅清理 Pi 自检 workspace' },
  { id: 'retry-pi-session', label: '重新创建 Pi Session 并复检', changes: '不修改持久化配置' },
];

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（已截断，原始长度 ${text.length}）` : text;
}

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '/');
  } catch {
    return clipText(raw.replace(/\/\/[^/@\s]+@/g, '//***@'), 500);
  }
}

function summarizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return { protocol: '', host: '', pathname: '' };
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return {
      protocol: url.protocol.replace(/:$/, ''),
      host: url.hostname.toLowerCase(),
      port: url.port || '',
      pathname: url.pathname || '/',
    };
  } catch {
    return { protocol: '', host: '', port: '', pathname: '' };
  }
}

// 输出可定位模型配置，但不暴露 API Key。
function summarizeTextModelConfig(config = {}) {
  return {
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint: summarizeEndpoint(config.base_url),
    base_url: sanitizeUrl(config.base_url),
    has_api_key: Boolean(config.api_key),
    request_mode: config.request_mode || '',
    context_length_limit: Number(config.context_length_limit || 0),
    concurrency_limit: Number(config.concurrency_limit || 0),
  };
}

function serializeDiagnosticError(error, seen = new Set(), depth = 0) {
  if (!error) return null;
  if (depth > 6) return { message: '错误链超过最大深度' };
  if (typeof error !== 'object') return { message: clipText(error, 2000) };
  if (seen.has(error)) return { message: '循环错误引用' };
  seen.add(error);
  const result = {
    name: error.name || error.constructor?.name || 'Error',
    message: clipText(error.message || String(error), 4000),
    stack: clipText(error.stack || '', 8000),
    code: error.code || '',
    status: Number(error.status || error.statusCode || 0),
  };
  for (const key of ['errno', 'syscall', 'address', 'port', 'type']) {
    if (error[key] !== undefined && error[key] !== '') result[key] = error[key];
  }
  if (error.cause) result.cause = serializeDiagnosticError(error.cause, seen, depth + 1);
  if (Array.isArray(error.errors)) {
    result.errors = error.errors.slice(0, 10).map((item) => serializeDiagnosticError(item, seen, depth + 1));
  }
  return result;
}

function redactProxyText(value) {
  return clipText(String(value || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1***:***@')
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, '$1***'), 4000);
}

function sanitizeProxyEnvironment(env = process.env) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS'];
  return Object.fromEntries(keys
    .filter((key) => env[key] !== undefined && env[key] !== '')
    .map((key) => [key, /^(http|https|all)_proxy$/i.test(key)
      ? sanitizeUrl(env[key])
      : redactProxyText(env[key])]));
}

function runPowerShellSnapshot(script) {
  if (process.platform !== 'win32') return { supported: false };
  const prefix = [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  ].join('; ');
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${prefix}; ${script}`], {
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
  });
  return {
    exit_code: child.status ?? (child.error ? 1 : 0),
    stdout: redactProxyText(child.stdout),
    stderr: redactProxyText(child.stderr || child.error?.message),
    timed_out: child.error?.code === 'ETIMEDOUT',
  };
}

// 采集报告所需的应用、系统和代理环境摘要。
function createPiEnvironmentSnapshot(app, layout, config) {
  return {
    app: {
      version: app?.getVersion?.() || '',
      is_packaged: Boolean(app?.isPackaged),
      executable: app?.getPath?.('exe') || '',
      user_data: app?.getPath?.('userData') || '',
      resources_path: process.resourcesPath || '',
    },
    process: {
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      exec_argv: process.execArgv.map((item) => redactProxyText(item)),
      versions: {
        node: process.versions.node,
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || '',
        v8: process.versions.v8 || '',
      },
    },
    os: {
      type: os.type(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    paths: {
      runtime_root: layout.runtimeRoot,
      service_root: layout.serviceRoot,
      workspace_dir: layout.workspaceDir,
      agent_dir: layout.agentDir,
      temp_dir: layout.tempDir,
    },
    text_model: summarizeTextModelConfig(config),
    proxy_environment: sanitizeProxyEnvironment(),
    windows_proxy: process.platform === 'win32' ? {
      winhttp: runPowerShellSnapshot('netsh winhttp show proxy'),
      internet_settings: runPowerShellSnapshot("Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json -Compress"),
    } : null,
  };
}

// 创建 Pi 自检的标准步骤列表。
function createPiSelfCheckSteps() {
  return [
    { id: 'environment', label: '环境快照', status: 'pending' },
    { id: 'sdk', label: 'Pi SDK', status: 'pending' },
    { id: 'runtime', label: '运行环境', status: 'pending' },
    { id: 'tools', label: '工具环境', status: 'pending' },
    { id: 'model-normal', label: '文本模型普通请求', status: 'pending' },
    { id: 'model-stream', label: '文本模型流式请求', status: 'pending' },
    { id: 'model-tools', label: '文本模型工具调用', status: 'pending' },
    { id: 'loopback', label: '本地 AI Proxy 链路', status: 'pending' },
    { id: 'agent', label: '智能体任务', status: 'pending' },
    { id: 'resources', label: '资源加载', status: 'pending' },
    { id: 'output', label: '输出校验', status: 'pending' },
    { id: 'diagnosis', label: '自动诊断', status: 'pending' },
    { id: 'repair', label: '安全自动修复', status: 'pending' },
    { id: 'recheck', label: '修复后复检', status: 'pending' },
  ];
}

function getExecutableName(command) {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function getExpectedCommandPath(environment, command) {
  if (command === 'node') {
    return path.join(environment.toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? 'node.cmd' : 'node');
  }
  if (BUNDLED_COMMANDS.includes(command)) {
    return path.join(environment.toolEnvironment.bundledToolsBinDir, getExecutableName(command));
  }
  return path.join(environment.toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? `${command}.cmd` : command);
}

function getCommandLine(command) {
  const windows = process.platform === 'win32';
  const commands = {
    basename: 'basename a/b/c.txt',
    cat: 'cat tool-check-input.txt',
    cp: 'cp tool-check-input.txt cp-output.txt',
    cut: 'cut -c 1-3 tool-check-input.txt',
    dirname: 'dirname a/b/c.txt',
    du: 'du -s .',
    fd: 'fd --version',
    find: 'find . -name tool-check-input.txt',
    grep: 'grep alpha tool-check-input.txt',
    head: 'head -n 1 tool-check-input.txt',
    jq: 'jq --version',
    ls: 'ls .',
    mkdir: 'mkdir mkdir-output',
    mv: 'mv mv-source.txt mv-output.txt',
    node: 'node -e "console.log(process.version)"',
    pwd: 'pwd',
    realpath: 'realpath .',
    rg: 'rg --version',
    rm: 'rm rm-source.txt',
    sed: 'sed s/alpha/ALPHA/ tool-check-input.txt',
    sort: 'sort tool-check-input.txt',
    stat: 'stat tool-check-input.txt',
    tail: 'tail -n 1 tool-check-input.txt',
    touch: 'touch touch-output.txt',
    tr: windows ? 'Get-Content -Raw tool-check-input.txt | tr a A' : 'tr a A < tool-check-input.txt',
    uniq: 'sort tool-check-input.txt | uniq',
    wc: 'wc -l tool-check-input.txt',
  };
  return commands[command] || `${command} --version`;
}

function prepareCommandFixture(checkDir, command) {
  if (command === 'cp') fs.rmSync(path.join(checkDir, 'cp-output.txt'), { force: true });
  if (command === 'mkdir') fs.rmSync(path.join(checkDir, 'mkdir-output'), { recursive: true, force: true });
  if (command === 'mv') {
    fs.writeFileSync(path.join(checkDir, 'mv-source.txt'), 'move me\n', 'utf-8');
    fs.rmSync(path.join(checkDir, 'mv-output.txt'), { force: true });
  }
  if (command === 'rm') fs.writeFileSync(path.join(checkDir, 'rm-source.txt'), 'remove me\n', 'utf-8');
  if (command === 'touch') fs.rmSync(path.join(checkDir, 'touch-output.txt'), { force: true });
}

function compactOutput(value, maxLength = 500) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function executeCommand(environment, command, cwd) {
  const commandLine = getCommandLine(command);
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${environment.shellCommandPrefix}\n${commandLine}`]
    : ['-c', commandLine];
  const startedAt = Date.now();
  const child = spawnSync(environment.shellPath, args, {
    cwd,
    env: environment.env,
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
  });
  return {
    exit_code: child.status ?? (child.error ? 1 : 0),
    duration_ms: Date.now() - startedAt,
    stdout: compactOutput(child.stdout),
    stderr: compactOutput(child.stderr || child.error?.message),
    timed_out: child.error?.code === 'ETIMEDOUT',
  };
}

// 在 Pi 实际 Shell 环境中逐项执行共享命令，关键命令失败时判定自检失败。
function runPiToolEnvironmentSelfCheck(environment) {
  const checkDir = path.join(environment.layout.tempDir, `pi-tool-check-${Date.now()}`);
  try {
    fs.mkdirSync(checkDir, { recursive: true });
    fs.writeFileSync(path.join(checkDir, 'tool-check-input.txt'), 'alpha\nbeta\nalpha\ngamma\n', 'utf-8');
    const items = COMMANDS.map((command) => {
      prepareCommandFixture(checkDir, command);
      const execution = executeCommand(environment, command, checkDir);
      const critical = CRITICAL_COMMANDS.has(command);
      const success = execution.exit_code === 0 && !execution.timed_out;
      return {
        id: command,
        label: command,
        status: success ? 'success' : critical ? 'error' : 'warning',
        message: success ? '可用' : execution.timed_out ? '执行超时' : execution.stderr || `执行失败，exit=${execution.exit_code}`,
        detail: getExpectedCommandPath(environment, command),
        ...execution,
      };
    });
    const successCount = items.filter((item) => item.status === 'success').length;
    const warningCount = items.filter((item) => item.status === 'warning').length;
    const errorCount = items.filter((item) => item.status === 'error').length;
    return {
      success: errorCount === 0,
      summary: `${successCount}/${items.length} 可用${warningCount ? `，${warningCount} 个警告` : ''}${errorCount ? `，${errorCount} 个失败` : ''}`,
      items,
    };
  } finally {
    try { fs.rmSync(checkDir, { recursive: true, force: true }); } catch {}
  }
}

function createTimeoutSignal(timeoutMs, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(message || '请求超时');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    },
  };
}

function parseSsePayloads(rawText) {
  return String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function summarizeModelPayloads(payloads, rawText) {
  const choices = payloads.flatMap((payload) => Array.isArray(payload?.choices) ? payload.choices : []);
  const content = choices.map((choice) => choice?.message?.content || choice?.delta?.content || choice?.text || '').filter(Boolean).join('');
  const toolCalls = new Map();
  choices.forEach((choice) => {
    const calls = choice?.message?.tool_calls || choice?.delta?.tool_calls || [];
    if (!Array.isArray(calls)) return;
    calls.forEach((call, position) => {
      const key = String(call?.index ?? call?.id ?? position);
      const current = toolCalls.get(key) || { name: '', arguments: '' };
      const namePart = call?.function?.name || '';
      const argumentsPart = call?.function?.arguments || '';
      if (namePart && !current.name.endsWith(namePart)) current.name += namePart;
      if (argumentsPart) current.arguments += argumentsPart;
      toolCalls.set(key, current);
    });
  });
  const toolCallValues = [...toolCalls.values()];
  return {
    payload_count: payloads.length,
    choices_count: choices.length,
    finish_reasons: choices.map((choice) => choice?.finish_reason).filter(Boolean),
    content_chars: content.length,
    content_preview: clipText(content, 500),
    tool_calls_count: toolCallValues.length,
    tool_names: [...new Set(toolCallValues.map((call) => call.name).filter(Boolean))],
    tool_arguments_preview: toolCallValues.map((call) => clipText(call.arguments, 500)),
    raw_chars: String(rawText || '').length,
    usage: payloads.map((payload) => payload?.usage).filter(Boolean).pop() || null,
  };
}

async function runTextModelProbe(config, options) {
  const startedAt = Date.now();
  const timeout = createTimeoutSignal(MODEL_CHECK_TIMEOUT_MS, `${options.label}超时`);
  const result = {
    id: options.id,
    label: options.label,
    success: false,
    started_at: nowIso(),
    duration_ms: 0,
    status: 0,
    stream: Boolean(options.stream),
    message: '',
    response: null,
    error: null,
  };

  try {
    if (!config?.api_key) throw new Error('未配置文本模型 API Key');
    if (!config?.model_name) throw new Error('未配置文本模型名称');
    if (!trimBaseUrl(config?.base_url)) throw new Error('未配置文本模型 Base URL');

    const body = {
      model: config.model_name,
      messages: [{ role: 'user', content: options.prompt || '只回复 OK' }],
      temperature: 0,
      stream: Boolean(options.stream),
    };
    if (options.requireToolCall) {
      body.tools = [{
        type: 'function',
        function: {
          name: 'diagnostic_echo',
          description: '用于验证模型工具调用能力',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      }];
      body.tool_choice = { type: 'function', function: { name: 'diagnostic_echo' } };
    }

    const response = await fetch(`${trimBaseUrl(config.base_url)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.api_key}`,
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    const rawText = await response.text();
    const payloads = options.stream
      ? parseSsePayloads(rawText)
      : (() => {
        try { return rawText ? [JSON.parse(rawText)] : []; } catch { return []; }
      })();
    const responseSummary = summarizeModelPayloads(payloads, rawText);
    result.status = response.status;
    result.response = responseSummary;
    result.duration_ms = Date.now() - startedAt;

    if (!response.ok) {
      let errorBody = null;
      try { errorBody = rawText ? JSON.parse(rawText) : null; } catch {}
      result.message = errorBody?.error?.message || errorBody?.message || clipText(rawText, 1000) || `HTTP ${response.status}`;
      result.error = { message: result.message, response_excerpt: clipText(rawText, 3000) };
      return result;
    }
    if (!payloads.length) {
      result.message = options.stream ? '流式响应中没有可解析的 SSE 数据' : '响应不是可解析的 JSON';
      result.error = { message: result.message, response_excerpt: clipText(rawText, 3000) };
      return result;
    }
    if (options.requireToolCall && (
      !responseSummary.tool_names.includes('diagnostic_echo')
      || !responseSummary.tool_arguments_preview.some((item) => item.includes('YIBIAO_PI_TOOL_OK'))
    )) {
      result.message = '模型未返回符合要求的 diagnostic_echo 工具调用';
      result.error = { message: result.message, response_excerpt: clipText(rawText, 3000) };
      return result;
    }

    result.success = true;
    result.message = `${options.label}成功`;
    return result;
  } catch (error) {
    result.duration_ms = Date.now() - startedAt;
    result.message = error?.message || String(error || `${options.label}失败`);
    result.error = serializeDiagnosticError(error);
    return result;
  } finally {
    timeout.clear();
  }
}

// 分别检测普通响应、流式响应和 Agent 必需的工具调用能力。
async function runPiTextModelSelfCheck(config, onProbe) {
  const reportProbe = (probe, status) => {
    try { onProbe?.(probe.id, status, probe); } catch {}
  };
  reportProbe({ id: 'normal', label: '普通文本请求' }, 'running');
  const normal = await runTextModelProbe(config, {
    id: 'normal',
    label: '普通文本请求',
    stream: false,
  });
  reportProbe(normal, normal.success ? 'success' : config?.request_mode === 'normal' ? 'error' : 'warning');
  reportProbe({ id: 'stream', label: '流式文本请求' }, 'running');
  const stream = await runTextModelProbe(config, {
    id: 'stream',
    label: '流式文本请求',
    stream: true,
  });
  reportProbe(stream, stream.success ? 'success' : 'error');
  reportProbe({ id: 'tools', label: '流式工具调用' }, 'running');
  const tools = await runTextModelProbe(config, {
    id: 'tools',
    label: '流式工具调用',
    stream: true,
    requireToolCall: true,
    prompt: '必须调用 diagnostic_echo 工具，参数 value 必须为 YIBIAO_PI_TOOL_OK，不要直接回答。',
  });
  reportProbe(tools, tools.success ? 'success' : 'error');
  const configuredMode = config?.request_mode === 'normal' ? normal : stream;
  return {
    success: configuredMode.success,
    agent_compatible: stream.success && tools.success,
    configured_mode: config?.request_mode === 'normal' ? 'normal' : 'stream',
    config: summarizeTextModelConfig(config),
    probes: { normal, stream, tools },
    checked_at: nowIso(),
  };
}

function runTcpProbe(host, port, timeoutMs = LOOPBACK_CHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (success, message, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        success,
        duration_ms: Date.now() - startedAt,
        message,
        error: error ? serializeDiagnosticError(error) : null,
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'TCP 连接成功'));
    socket.once('timeout', () => finish(false, 'TCP 连接超时', new Error('TCP 连接超时')));
    socket.once('error', (error) => finish(false, error?.message || 'TCP 连接失败', error));
  });
}

function runNativeHttpProbe(urlValue, headers = {}, timeoutMs = LOOPBACK_CHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const request = http.get(urlValue, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          success: response.statusCode >= 200 && response.statusCode < 300,
          duration_ms: Date.now() - startedAt,
          status: response.statusCode || 0,
          message: `HTTP ${response.statusCode || 0}`,
          response_excerpt: clipText(body, 1000),
          error: null,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('本地 HTTP 请求超时')));
    request.on('error', (error) => resolve({
      success: false,
      duration_ms: Date.now() - startedAt,
      status: 0,
      message: error?.message || '本地 HTTP 请求失败',
      response_excerpt: '',
      error: serializeDiagnosticError(error),
    }));
  });
}

async function runFetchProbe(urlValue, headers = {}, timeoutMs = LOOPBACK_CHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  const timeout = createTimeoutSignal(timeoutMs, '本地 fetch 请求超时');
  try {
    const response = await fetch(urlValue, { headers, signal: timeout.signal });
    const body = await response.text();
    return {
      success: response.ok,
      duration_ms: Date.now() - startedAt,
      status: response.status,
      message: `HTTP ${response.status}`,
      response_excerpt: clipText(body, 1000),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      duration_ms: Date.now() - startedAt,
      status: 0,
      message: error?.message || '本地 fetch 请求失败',
      response_excerpt: '',
      error: serializeDiagnosticError(error),
    };
  } finally {
    timeout.clear();
  }
}

// 使用多种 Node 网络路径检测 Pi SDK 前方的 loopback 链路。
async function runPiLoopbackSelfCheck(proxyInfo) {
  if (!proxyInfo?.baseUrl || !proxyInfo?.port) {
    return { success: false, message: 'Pi AI Proxy 未返回监听地址', checked_at: nowIso() };
  }
  const healthUrl = `${proxyInfo.baseUrl}/health`;
  const modelsUrl = `${proxyInfo.baseUrl}/v1/models`;
  const tcp = await runTcpProbe('127.0.0.1', proxyInfo.port);
  const nativeHealth = await runNativeHttpProbe(healthUrl);
  const fetchHealth = await runFetchProbe(healthUrl);
  const fetchModels = await runFetchProbe(modelsUrl, { Authorization: `Bearer ${proxyInfo.token}` });
  return {
    success: tcp.success && nativeHealth.success && fetchHealth.success && fetchModels.success,
    message: tcp.success && nativeHealth.success && fetchHealth.success && fetchModels.success ? '本地 AI Proxy loopback 链路正常' : '本地 AI Proxy loopback 链路存在异常',
    base_url: proxyInfo.baseUrl,
    port: proxyInfo.port,
    checked_at: nowIso(),
    probes: {
      tcp,
      native_http_health: nativeHealth,
      global_fetch_health: fetchHealth,
      authenticated_models: fetchModels,
    },
  };
}

function findLastEvent(events, eventName) {
  return [...(events || [])].reverse().find((event) => event?.event === eventName) || null;
}

// 基于阶段和事件给出不依赖模型的确定性定位结论。
function diagnosePiSelfCheck({ modelCheck, loopbackCheck, toolCheck, agentCheck, events = [], error }) {
  const evidence = [];
  const recommendedActionIds = [];
  let category = 'unknown';
  let summary = 'Pi 自检失败，尚未匹配到明确的内置诊断规则。';
  let confidence = 'low';
  const configuredProbe = modelCheck?.probes?.[modelCheck?.configured_mode];
  const proxyReceived = events.some((event) => event?.event === 'proxy.http.received');
  const upstreamStarted = events.some((event) => event?.event === 'proxy.upstream.started');
  const upstreamCompleted = findLastEvent(events, 'proxy.upstream.completed');
  const upstreamFailed = findLastEvent(events, 'proxy.upstream.failed');

  if (configuredProbe?.success === false) {
    category = 'text-model';
    summary = `当前文本模型的${configuredProbe.label || '配置模式请求'}失败，智能体无法稳定工作。`;
    confidence = 'high';
    evidence.push(configuredProbe.message || '文本模型检测失败');
  } else if (modelCheck?.probes?.stream?.success === false) {
    category = 'text-model-stream';
    summary = '当前文本模型普通请求可用，但流式响应检测失败；Pi Agent 固定依赖流式响应。';
    confidence = 'high';
    evidence.push(modelCheck.probes.stream.message || '流式文本请求失败');
  } else if (modelCheck?.probes?.tools?.success === false) {
    category = 'tool-calling';
    summary = '文本模型基础请求可用，但未通过 Pi Agent 必需的流式工具调用检测。';
    confidence = 'high';
    evidence.push(modelCheck.probes.tools.message || '工具调用检测失败');
  } else if (loopbackCheck?.success === false) {
    category = 'loopback';
    summary = '应用内部 AI Proxy 已启动，但本机 loopback 访问存在异常。';
    confidence = 'high';
    Object.entries(loopbackCheck.probes || {}).forEach(([id, probe]) => {
      if (!probe?.success) evidence.push(`${id}：${probe?.message || '失败'}`);
    });
    const nativeOk = loopbackCheck.probes?.native_http_health?.success;
    const fetchOk = loopbackCheck.probes?.global_fetch_health?.success;
    if (nativeOk && !fetchOk) recommendedActionIds.push('apply-loopback-no-proxy');
    recommendedActionIds.push('restart-pi-runtime', 'retry-pi-session');
  } else if (agentCheck?.success === false && !proxyReceived) {
    category = 'pi-sdk-transport';
    summary = '文本模型和本地 AI Proxy 正常，但 Pi SDK 请求没有到达本地 Proxy，问题位于 Pi SDK 到 loopback 的传输阶段。';
    confidence = 'high';
    evidence.push(`Agent 错误：${agentCheck?.message || error?.message || '未知'}`);
    evidence.push('本轮事件中不存在 proxy.http.received');
    recommendedActionIds.push('apply-loopback-no-proxy', 'restart-pi-runtime', 'retry-pi-session');
  } else if (upstreamFailed) {
    category = 'upstream';
    summary = 'Pi 已到达本地 AI Proxy，但上游文本模型请求失败。';
    confidence = 'high';
    evidence.push(upstreamFailed.error?.message || 'proxy.upstream.failed');
    recommendedActionIds.push('retry-pi-session');
  } else if (upstreamStarted && !upstreamCompleted) {
    category = 'upstream-incomplete';
    summary = '上游模型请求已经发出，但没有收到完整响应。';
    confidence = 'high';
    evidence.push('存在 proxy.upstream.started，但不存在 proxy.upstream.completed');
    recommendedActionIds.push('retry-pi-session');
  } else if (toolCheck?.success === false) {
    category = 'tool-environment';
    summary = 'Pi 集成工具环境存在不可用的关键命令。';
    confidence = 'high';
    evidence.push(toolCheck.summary || '工具环境检测失败');
    recommendedActionIds.push('rebuild-pi-tool-environment', 'reset-pi-self-check-workspace', 'retry-pi-session');
  } else if (agentCheck?.task_completed && agentCheck?.output_valid === false) {
    category = 'output';
    summary = 'Pi Agent 已完成任务，但输出文件缺失或内容不符合预期。';
    confidence = 'high';
    evidence.push(agentCheck.output_message || '输出校验失败');
    recommendedActionIds.push('reset-pi-self-check-workspace', 'retry-pi-session');
  } else if (agentCheck?.success === false) {
    category = 'pi-agent';
    summary = '文本模型与代理链路已有响应，故障位于 Pi Agent 会话或工具执行阶段。';
    confidence = 'medium';
    evidence.push(agentCheck.message || error?.message || 'Pi Agent 任务失败');
    recommendedActionIds.push('restart-pi-runtime', 'reset-pi-self-check-workspace', 'retry-pi-session');
  }

  return {
    source: 'rules',
    category,
    summary,
    confidence,
    evidence,
    recommended_action_ids: [...new Set(recommendedActionIds)],
    observed: {
      proxy_received: proxyReceived,
      upstream_started: upstreamStarted,
      upstream_completed: Boolean(upstreamCompleted),
      upstream_failed: Boolean(upstreamFailed),
    },
  };
}

function normalizeAiDiagnosis(value) {
  const actionIds = new Set(SAFE_REPAIR_ACTIONS.map((item) => item.id));
  return {
    source: 'text-model',
    summary: clipText(value?.summary || '', 1200),
    root_cause: clipText(value?.root_cause || '', 1200),
    confidence: ['high', 'medium', 'low'].includes(value?.confidence) ? value.confidence : 'low',
    evidence: Array.isArray(value?.evidence) ? value.evidence.slice(0, 10).map((item) => clipText(item, 800)) : [],
    recommended_action_ids: Array.isArray(value?.recommended_action_ids)
      ? value.recommended_action_ids.filter((item) => actionIds.has(item))
      : [],
    manual_actions: Array.isArray(value?.manual_actions) ? value.manual_actions.slice(0, 10).map((item) => clipText(item, 800)) : [],
  };
}

function sanitizeDiagnosisInput(value) {
  const text = JSON.stringify(value, (key, item) => {
    if (/api[_-]?key|authorization|token|password|secret|cookie/i.test(key)) return '[REDACTED]';
    return item;
  });
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/g, '%USERPROFILE%')
    .slice(0, 24000);
}

// 使用已通过检测的文本模型分析结构化错误，只允许推荐内置动作编号。
async function analyzePiSelfCheckWithModel(aiService, input) {
  const startedAt = Date.now();
  if (!aiService?.requestJson) {
    return { success: false, duration_ms: 0, error: { message: 'AI 服务不可用' } };
  }
  try {
    const actionCatalog = SAFE_REPAIR_ACTIONS.map((item) => ({ id: item.id, label: item.label, changes: item.changes }));
    const result = await aiService.requestJson({
      messages: [{
        role: 'user',
        content: `你是易标客户端 Pi Agent 自检诊断器。请根据诊断数据定位根因。\n\n约束：\n1. 只能从 action_catalog 中选择 recommended_action_ids。\n2. 不得生成脚本、命令或要求修改系统防火墙。\n3. 结论必须引用明确证据。\n4. 返回 JSON：{"summary":"","root_cause":"","confidence":"high|medium|low","evidence":[],"recommended_action_ids":[],"manual_actions":[]}。\n\naction_catalog：${JSON.stringify(actionCatalog)}\n\ndiagnostics：${sanitizeDiagnosisInput(input)}`,
      }],
      schemaName: 'Pi智能体自检诊断',
      max_retries: 1,
      timeout_ms: 60000,
      logTitle: 'Pi智能体自检诊断',
    });
    return {
      success: true,
      duration_ms: Date.now() - startedAt,
      result: normalizeAiDiagnosis(result),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      duration_ms: Date.now() - startedAt,
      result: null,
      error: serializeDiagnosticError(error),
    };
  }
}

function ensureLoopbackNoProxy(env = process.env) {
  const required = ['127.0.0.1', 'localhost', '::1'];
  const before = { NO_PROXY: env.NO_PROXY || '', no_proxy: env.no_proxy || '' };
  const merge = (value) => {
    const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    required.forEach((item) => { if (!items.includes(item)) items.push(item); });
    return items.join(',');
  };
  env.NO_PROXY = merge(env.NO_PROXY);
  env.no_proxy = merge(env.no_proxy);
  return {
    changed: before.NO_PROXY !== env.NO_PROXY || before.no_proxy !== env.no_proxy,
    before,
    after: { NO_PROXY: env.NO_PROXY, no_proxy: env.no_proxy },
  };
}

// 校验 Pi 只加载内置上下文，并精确启用方案指定工具。
function validatePiSessionSnapshot(snapshot = {}) {
  const activeTools = Array.isArray(snapshot.active_tools) ? snapshot.active_tools : [];
  const resourcesValid = snapshot.context_files?.length === 1
    && snapshot.context_files[0] === '<yibiao-agent-workspace>'
    && !snapshot.skills?.length
    && !snapshot.prompts?.length
    && !snapshot.extensions?.length;
  const toolsValid = activeTools.length === EXPECTED_PI_TOOLS.length
    && EXPECTED_PI_TOOLS.every((tool) => activeTools.includes(tool));
  return { resourcesValid, toolsValid };
}

// 将 Pi 自检信息转换为 Renderer 使用的公共诊断区。
function createPiDiagnosticSections({ layout, sdkVersion, sessionSnapshot = {}, toolCheck, modelCheck, loopbackCheck, diagnosis, repair } = {}) {
  const validation = validatePiSessionSnapshot(sessionSnapshot);
  const toolStatus = !toolCheck?.success || !validation.toolsValid
    ? 'error'
    : toolCheck.items?.some((item) => item.status === 'warning') ? 'warning' : 'success';
  const sections = [
    {
      id: 'pi-runtime',
      title: 'Pi 运行环境',
      status: sdkVersion ? 'success' : 'error',
      summary: 'Pi 使用应用专用目录和内存 Session',
      details: [
        { label: 'SDK 版本', value: sdkVersion || '-' },
        { label: '运行目录', value: layout.runtimeRoot },
        { label: 'Agent 配置目录', value: layout.agentDir },
        { label: '工作区', value: layout.workspaceDir },
      ],
    },
    {
      id: 'pi-resources',
      title: '资源加载',
      status: validation.resourcesValid ? 'success' : 'error',
      summary: validation.resourcesValid ? '仅加载易标内置工作区指令' : '资源加载结果不符合配置',
      details: [
        { label: '上下文文件', value: sessionSnapshot.context_files?.join('、') || '-' },
        { label: 'Skill', value: String(sessionSnapshot.skills?.length || 0) },
        { label: 'Prompt', value: String(sessionSnapshot.prompts?.length || 0) },
        { label: '扩展', value: String(sessionSnapshot.extensions?.length || 0) },
      ],
    },
    {
      id: 'pi-tools',
      title: '工具环境',
      status: toolStatus,
      summary: validation.toolsValid ? toolCheck?.summary || '共享命令检查完成' : 'Pi 工具注册结果不符合配置',
      items: [
        ...EXPECTED_PI_TOOLS.map((tool) => ({
          id: `tool-${tool}`,
          label: tool,
          status: sessionSnapshot.active_tools?.includes(tool) ? 'success' : 'error',
          message: sessionSnapshot.active_tools?.includes(tool) ? '已启用' : '未启用',
        })),
        ...(toolCheck?.items || []).map((item) => ({
          id: `command-${item.id}`,
          label: item.label,
          status: item.status,
          message: item.message,
          detail: item.detail,
        })),
      ],
    },
  ];
  if (modelCheck) {
    const allModelProbesPassed = Object.values(modelCheck.probes || {}).every((probe) => probe?.success);
    sections.push({
      id: 'pi-text-model',
      title: '当前文本模型',
      status: allModelProbesPassed ? 'success' : modelCheck.agent_compatible && modelCheck.success ? 'warning' : 'error',
      summary: allModelProbesPassed ? '普通、流式和工具调用能力均已通过' : modelCheck.agent_compatible && modelCheck.success ? 'Pi Agent 所需能力正常，但存在非关键探针警告' : '文本模型未完全满足 Pi Agent 能力要求',
      details: [
        { label: '服务商', value: modelCheck.config?.provider || '-' },
        { label: '模型', value: modelCheck.config?.model_name || '-' },
        { label: 'Base URL', value: modelCheck.config?.base_url || '-' },
        { label: '请求模式', value: modelCheck.config?.request_mode || '-' },
        { label: '上下文长度', value: String(modelCheck.config?.context_length_limit || 0) },
        { label: '并发数', value: String(modelCheck.config?.concurrency_limit || 0) },
        { label: 'API Key', value: modelCheck.config?.has_api_key ? '已配置（未导出）' : '未配置' },
      ],
      items: Object.values(modelCheck.probes || {}).map((probe) => ({
        id: `model-${probe.id}`,
        label: probe.label,
        status: probe.success ? 'success' : 'error',
        message: `${probe.message || (probe.success ? '成功' : '失败')}，${probe.duration_ms || 0} ms${probe.status ? `，HTTP ${probe.status}` : ''}`,
      })),
    });
  }
  if (loopbackCheck) {
    sections.push({
      id: 'pi-loopback',
      title: '本地 AI Proxy 链路',
      status: loopbackCheck.success ? 'success' : 'error',
      summary: loopbackCheck.message || '',
      details: [
        { label: '监听地址', value: loopbackCheck.base_url || '-' },
        { label: '端口', value: String(loopbackCheck.port || 0) },
      ],
      items: Object.entries(loopbackCheck.probes || {}).map(([id, probe]) => ({
        id: `loopback-${id}`,
        label: id,
        status: probe.success ? 'success' : 'error',
        message: `${probe.message || (probe.success ? '成功' : '失败')}，${probe.duration_ms || 0} ms`,
      })),
    });
  }
  if (diagnosis) {
    sections.push({
      id: 'pi-diagnosis',
      title: '自动诊断',
      status: diagnosis.resolved ? 'success' : diagnosis.rules?.confidence === 'low' ? 'warning' : 'error',
      summary: diagnosis.final_summary || diagnosis.ai?.result?.summary || diagnosis.rules?.summary || '',
      details: [
        { label: '根因分类', value: diagnosis.rules?.category || '-' },
        { label: '规则可信度', value: diagnosis.rules?.confidence || '-' },
        { label: '文本模型分析', value: diagnosis.ai?.success ? '完成' : diagnosis.ai ? '失败' : '未执行' },
      ],
      items: (diagnosis.rules?.evidence || []).map((item, index) => ({
        id: `diagnosis-evidence-${index}`,
        label: `证据 ${index + 1}`,
        status: 'warning',
        message: item,
      })),
    });
  }
  if (repair) {
    sections.push({
      id: 'pi-repair',
      title: '安全自动修复',
      status: repair.attempted ? repair.success ? 'success' : 'error' : repair.success ? 'success' : 'warning',
      summary: repair.attempted ? repair.success ? '自动修复后复检通过' : '已执行安全修复，但复检仍未通过' : repair.success ? '自检正常，无需修复' : '没有符合条件的安全修复动作',
      items: (repair.actions || []).map((action, index) => ({
        id: `repair-${index}-${action.id}`,
        label: action.label || action.id,
        status: action.success ? 'success' : 'error',
        message: action.message || '',
      })),
    });
  }
  return sections;
}

function redactSensitiveResult(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveResult(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (/api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|cookie/i.test(key)) {
      result[key] = item ? '[REDACTED]' : item;
      return;
    }
    result[key] = redactSensitiveResult(item, seen);
  });
  return result;
}

function markdownFence(value, language = '') {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const text = String(content || '').trim();
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text || '-'}\n${fence}`;
}

// 生成单文件、完整且脱敏的 Pi 自检报告。
function buildPiSelfCheckReportMarkdown(input = {}) {
  const result = redactSensitiveResult(input && typeof input === 'object' ? input : {});
  const lines = [
    '# Pi Agent 自检报告',
    '',
    `- 报告版本：${result.report_version || REPORT_VERSION}`,
    `- 检查 ID：${result.check_id || '-'}`,
    `- 结果：${result.success ? result.repaired ? '通过（已自动修复）' : '通过' : result.status === 'busy' ? '跳过' : '失败'}`,
    `- 信息：${result.message || '-'}`,
    `- 检查时间：${result.checked_at || '-'}`,
    `- 耗时：${result.duration_ms || 0} ms`,
    '',
    '## 自动诊断结论',
    '',
    result.conclusion || result.diagnosis?.final_summary || result.diagnosis?.rules?.summary || '-',
    '',
    '## 检查步骤',
    '',
    '| 步骤 | 状态 | 信息 | 耗时 |',
    '| --- | --- | --- | --- |',
  ];
  (result.steps || []).forEach((step) => {
    const clean = (value) => String(value || '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push(`| ${clean(step.label)} | ${clean(step.status)} | ${clean(step.message)} | ${step.duration_ms === undefined ? '-' : `${step.duration_ms} ms`} |`);
  });
  lines.push('', '## 当前文本模型', '', markdownFence({ config: result.model_config, check: result.model_check }, 'json'));
  lines.push('', '## 应用与系统环境', '', markdownFence(result.environment || {}, 'json'));
  lines.push('', '## 本地 AI Proxy 探针', '', markdownFence(result.loopback_check || {}, 'json'));
  lines.push('', '## Pi SDK 与资源', '', markdownFence({ sdk_version: result.sdk_version, session: result.session_snapshot }, 'json'));
  lines.push('', '## 工具环境', '', markdownFence(result.tool_check || {}, 'json'));
  lines.push('', '## 智能体任务', '', markdownFence(result.agent_check || {}, 'json'));
  lines.push('', '## 规则诊断与文本模型分析', '', markdownFence(result.diagnosis || {}, 'json'));
  lines.push('', '## 自动修复与复检', '', markdownFence(result.repair || {}, 'json'));
  lines.push('', '## 当前任务事件时间线', '', markdownFence(result.diagnostics?.events || [], 'json'));
  lines.push('', '## 完整错误链', '', markdownFence(result.diagnostics?.error || result.error || {}, 'json'));
  lines.push('', '## Runtime 状态', '', markdownFence(result.runtime_status || {}, 'json'));
  lines.push('', '## 完整结构化结果', '', markdownFence(result, 'json'));
  return `${lines.join('\n')}\n`;
}

module.exports = {
  EXPECTED_PI_TOOLS,
  SAFE_REPAIR_ACTIONS,
  analyzePiSelfCheckWithModel,
  buildPiSelfCheckReportMarkdown,
  createPiEnvironmentSnapshot,
  createPiDiagnosticSections,
  createPiSelfCheckSteps,
  diagnosePiSelfCheck,
  ensureLoopbackNoProxy,
  runPiLoopbackSelfCheck,
  runPiTextModelSelfCheck,
  runPiToolEnvironmentSelfCheck,
  serializeDiagnosticError,
  summarizeTextModelConfig,
  validatePiSessionSnapshot,
};
