const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog } = require('electron');
const {
  getAgentRuntimeDir,
  getBundledOpencodeBinaryPath,
  getAgentCacheDir,
  getDeveloperLogsDir,
  getUserDataPath,
} = require('../utils/paths.cjs');
const { startIsolatedOpenCodeServer } = require('./opencode/opencodeServerRunner.cjs');
const { createSession, sendPrompt, getSessionDiff, runOpenCodeTask } = require('./opencode/opencodeHttpClient.cjs');

const SELF_CHECK_TASK_ID = 'agent-self-check-latest';
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_EXPECTED_MESSAGE = 'YIBIAO_AGENT_SELF_CHECK_OK';
const SELF_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const SELF_CHECK_DIRECT_MODEL_TIMEOUT_MS = 30 * 1000;
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';

function trackAgentRuntime(app, configStore, status) {
  const runtimeStatus = status === 'success' ? 'success' : 'failed';
  void Promise.resolve()
    .then(() => {
      const config = configStore.load();
      return fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: ANALYTICS_PROJECT_NAME,
          event: 'agent_runtime',
          version: typeof app?.getVersion === 'function' ? app.getVersion() : '',
          platform: process.platform,
          arch: process.arch,
          client_id: config.analytics_client_id || '',
          client_created_at: config.analytics_created_at || '',
          agent_runtime_status: runtimeStatus,
        }),
      });
    })
    .catch(() => undefined);
}

function safeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    throw new Error(`非法文件路径：${value}`);
  }
  const lower = raw.toLowerCase();
  const reserved =
    lower === 'opencode.json'
    || lower === 'opencode.jsonc'
    || lower === 'agents.md'
    || lower === 'claude.md'
    || lower.startsWith('.opencode/')
    || lower.startsWith('.config/opencode/')
    || lower.startsWith('.claude/');
  if (reserved) {
    throw new Error(`OpenCode 保留路径或指令文件不允许作为任务输入：${value}`);
  }
  return raw;
}

function writeWorkspaceFiles(workspaceDir, files = []) {
  fs.mkdirSync(workspaceDir, { recursive: true });

  files.forEach((file) => {
    const relativePath = safeRelativePath(file.path);
    const targetPath = path.join(workspaceDir, relativePath);
    const resolvedRoot = path.resolve(workspaceDir);
    const resolvedTarget = path.resolve(targetPath);

    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`文件路径越界：${file.path}`);
    }

    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    fs.writeFileSync(resolvedTarget, String(file.content || ''), 'utf-8');
  });
}

function createDefaultAgentPrompt({ task, outputFile }) {
  return `请只在当前工作目录内工作。

任务：
${task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 如需产出结果，请写入 ${outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复请包含：发现的问题、处理动作、输出文件路径。`;
}

function createTaskAbortController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason || new Error('Agent 任务已取消'));
    }
  };
  const onParentAbort = () => abort(parentSignal.reason);

  if (parentSignal?.aborted) {
    abort(parentSignal.reason);
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => abort(new Error('Agent 任务执行超时')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', onParentAbort); } catch {}
      }
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（已截断，原始长度 ${text.length}）` : text;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function endpointSummary(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return { protocol: '', host: '', pathname: '' };
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return {
      protocol: url.protocol.replace(/:$/, ''),
      host: url.hostname.toLowerCase(),
      pathname: url.pathname || '/',
    };
  } catch {
    return { protocol: '', host: '', pathname: '' };
  }
}

function summarizeTextModelConfig(config = {}) {
  return {
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint: endpointSummary(config.base_url),
    has_api_key: Boolean(config.api_key),
    request_mode: config.request_mode || '',
    context_length_limit: Number(config.context_length_limit || 0),
    concurrency_limit: Number(config.concurrency_limit || 0),
  };
}

function createSelfCheckCollector(limit = 300) {
  const events = [];
  return {
    events,
    record(event, payload = {}) {
      events.push({ at: nowIso(), event: String(event || 'event'), ...payload });
      if (events.length > limit) {
        events.splice(0, events.length - limit);
      }
    },
  };
}

function createTimeoutSignal(timeoutMs, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message || '请求超时')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
}

function summarizeDirectModelResponse(data, rawText) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const content = choices
    .map((choice) => choice?.message?.content || choice?.text || '')
    .filter(Boolean)
    .join('\n');
  return {
    choices_count: choices.length,
    finish_reasons: choices.map((choice) => choice?.finish_reason).filter(Boolean),
    content_chars: content.length,
    content_preview: clipText(content, 500),
    raw_chars: String(rawText || '').length,
    usage: data?.usage || null,
  };
}

async function runDirectModelSelfCheck(config) {
  const startedAt = Date.now();
  const timeout = createTimeoutSignal(SELF_CHECK_DIRECT_MODEL_TIMEOUT_MS, '直接模型测试超时');
  const result = {
    success: false,
    duration_ms: 0,
    status: 0,
    message: '',
    config: summarizeTextModelConfig(config),
    response: null,
    error: null,
  };

  try {
    if (!config?.api_key) throw new Error('请先配置文本模型 API Key');
    if (!config?.model_name) throw new Error('请先配置文本模型名称');
    if (!trimBaseUrl(config?.base_url)) throw new Error('请先配置文本模型 Base URL');

    const body = {
      model: config.model_name,
      messages: [{ role: 'user', content: '只回复 OK' }],
      temperature: 0,
      stream: false,
    };
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
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch {}

    result.status = response.status;
    result.duration_ms = Date.now() - startedAt;
    result.response = summarizeDirectModelResponse(data, rawText);
    if (!response.ok) {
      result.message = data?.error?.message || data?.message || rawText || `HTTP ${response.status}`;
      result.error = { message: clipText(result.message, 1000), response_excerpt: clipText(rawText, 2000) };
      return result;
    }

    result.success = true;
    result.message = '直接模型测试成功';
    return result;
  } catch (error) {
    result.duration_ms = Date.now() - startedAt;
    result.message = error?.message || String(error || '直接模型测试失败');
    result.error = {
      name: error?.name || 'Error',
      message: result.message,
      code: error?.code || '',
      cause_code: error?.cause?.code || '',
      cause_message: error?.cause?.message || '',
    };
    return result;
  } finally {
    timeout.cleanup();
  }
}

function readJsonFileIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return { read_error: error?.message || String(error) };
  }
}

function safeStat(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      is_file: stat.isFile(),
      is_directory: stat.isDirectory(),
    };
  } catch (error) {
    return { exists: false, error: error?.message || String(error) };
  }
}

function createEnvironmentSnapshot(app, opencodeBinaryPath, config) {
  const opencodeRoot = path.dirname(path.dirname(opencodeBinaryPath));
  return {
    app: {
      version: app?.getVersion?.() || '',
      is_packaged: Boolean(app?.isPackaged),
      user_data: getUserDataPath(app),
      resources_path: process.resourcesPath || '',
    },
    process: {
      platform: process.platform,
      arch: process.arch,
      versions: {
        node: process.versions.node,
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || '',
        v8: process.versions.v8 || '',
      },
    },
    paths: {
      agent_runtime_dir: getAgentRuntimeDir(app),
      agent_cache_dir: getAgentCacheDir(app),
      opencode_binary_path: opencodeBinaryPath,
    },
    opencode: {
      binary: safeStat(opencodeBinaryPath),
      version_file: fs.existsSync(path.join(opencodeRoot, 'VERSION')) ? clipText(fs.readFileSync(path.join(opencodeRoot, 'VERSION'), 'utf-8'), 200) : '',
      manifest: readJsonFileIfExists(path.join(opencodeRoot, 'manifest.json')),
    },
    text_model: summarizeTextModelConfig(config),
  };
}

function snapshotWorkspace(rootDir, maxFiles = 80) {
  const files = [];
  function walk(currentDir) {
    if (files.length >= maxFiles || !fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);
      if (entry.isDirectory()) {
        files.push({ path: `${relativePath}/`, type: 'directory', size: 0, mtime: stat.mtime.toISOString() });
        walk(fullPath);
        return;
      }
      const item = { path: relativePath, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() };
      if (stat.size <= 1024 * 1024) {
        try {
          const buffer = fs.readFileSync(fullPath);
          item.sha256_12 = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
        } catch {}
      }
      files.push(item);
    });
  }

  try {
    walk(rootDir);
    return { root: rootDir, files, truncated: files.length >= maxFiles };
  } catch (error) {
    return { root: rootDir, files, error: error?.message || String(error) };
  }
}

function parsePortFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return Number(url.port || 0);
  } catch {
    return 0;
  }
}

function hasProxyEvent(events, eventName) {
  return (events || []).some((event) => event?.event === eventName);
}

function findLastProxyEvent(events, eventName) {
  return [...(events || [])].reverse().find((event) => event?.event === eventName) || null;
}

function createSelfCheckConclusion(result) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const failedStep = steps.find((step) => step.status === 'error');
  const proxyEvents = result.proxy_diagnostics?.events || [];
  const direct = result.direct_model_test;
  const requestLog = result.opencode_request_log || result.diagnostics?.opencode_request_log || [];
  const lastProxyFailure = findLastProxyEvent(proxyEvents, 'proxy.upstream.failed');
  const lastProxySuccess = findLastProxyEvent(proxyEvents, 'proxy.upstream.completed');
  const lastHeaders = findLastProxyEvent(proxyEvents, 'proxy.upstream.headers');

  if (result.success) return '结论：智能体自检通过，OpenCode Server、AI proxy、上游模型和文件输出链路均正常。';
  if (failedStep?.id === 'binary-check') return '结论：OpenCode 程序文件缺失或不可访问，属于安装包资源问题。';
  if (failedStep?.id === 'runtime-write-check') return '结论：自检运行目录无法写入，属于本机用户目录权限或磁盘问题。';
  if (failedStep?.id === 'direct-model-test' || direct?.success === false) {
    const status = direct?.status ? `HTTP ${direct.status}` : '';
    return `结论：当前文本模型的普通请求失败${status ? `（${status}）` : ''}，优先检查 Base URL、API Key、模型名称、网络或服务商状态。`;
  }
  if (['ai-proxy-start', 'opencode-server-start', 'opencode-health'].includes(failedStep?.id)) {
    return `结论：${failedStep.label}失败，问题位于本机 OpenCode/AI proxy 启动链路。`;
  }
  if (requestLog.some((item) => item.route === '/session' && item.ok === true) && failedStep?.id === 'message-wait') {
    if (!hasProxyEvent(proxyEvents, 'proxy.chat.received')) {
      return '结论：OpenCode Server 和 Session 正常，但执行 message 时 AI proxy 没收到模型请求，问题位于 OpenCode Agent 内部执行阶段。';
    }
    if (lastProxyFailure) {
      const status = lastProxyFailure.error?.status || lastHeaders?.status || 0;
      const msg = lastProxyFailure.error?.message || '';
      return `结论：OpenCode 已请求 AI proxy，但上游模型请求失败${status ? `（HTTP ${status}）` : ''}${msg ? `：${msg}` : ''}。`;
    }
    if (hasProxyEvent(proxyEvents, 'proxy.upstream.started') && !lastProxySuccess) {
      return '结论：AI proxy 已开始请求上游模型，但没有收到完整响应，问题位于上游模型网络、服务商响应或超时。';
    }
    if (lastProxySuccess) {
      const toolCalls = Number(lastProxySuccess.response?.tool_calls_count || 0);
      return toolCalls
        ? '结论：上游模型已返回工具调用，但 Agent 未完成输出，问题可能位于 OpenCode 工具执行或文件写入阶段。'
        : '结论：上游模型有响应但未产生工具调用/输出文件，当前模型可能不支持 Agent 所需工具调用能力。';
    }
  }
  if (failedStep?.id === 'output-check') return '结论：OpenCode Agent 执行结束但输出文件缺失或内容不符合预期，问题位于模型工具调用或文件写入结果。';
  return `结论：自检失败于${failedStep?.label || '未知阶段'}，请查看阶段日志、AI proxy 事件和完整结构化结果。`;
}

function createStageError(stage, message) {
  const error = new Error(message);
  error.selfCheckStage = stage;
  return error;
}

function createSelfCheckSteps() {
  return [
    { id: 'prepare', label: '清理旧自检日志和运行目录', status: 'pending', message: '' },
    { id: 'environment-snapshot', label: '采集环境快照', status: 'pending', message: '' },
    { id: 'binary-check', label: '检查 OpenCode 程序文件', status: 'pending', message: '' },
    { id: 'runtime-write-check', label: '检查运行目录写入能力', status: 'pending', message: '' },
    { id: 'direct-model-test', label: '直接测试文本模型', status: 'pending', message: '' },
    { id: 'ai-proxy-start', label: '启动 OpenCode AI proxy', status: 'pending', message: '' },
    { id: 'opencode-config-write', label: '写入 OpenCode 临时配置', status: 'pending', message: '' },
    { id: 'opencode-server-start', label: '启动 OpenCode Server', status: 'pending', message: '' },
    { id: 'opencode-health', label: '检查 OpenCode Server 健康状态', status: 'pending', message: '' },
    { id: 'session-create', label: '创建 OpenCode Session', status: 'pending', message: '' },
    { id: 'message-wait', label: '执行极简智能体任务', status: 'pending', message: '' },
    { id: 'diff-fetch', label: '读取 OpenCode Diff', status: 'pending', message: '' },
    { id: 'output-check', label: '校验智能体输出', status: 'pending', message: '' },
    { id: 'workspace-snapshot', label: '采集工作目录快照', status: 'pending', message: '' },
  ];
}

function updateSelfCheckStep(steps, id, status, message) {
  const step = steps.find((item) => item.id === id);
  if (!step) return;
  step.status = status;
  step.message = message || '';
  step.updated_at = nowIso();
}

function getCurrentSelfCheckStage(steps) {
  return steps.find((step) => step.status === 'running')?.id || 'agent-run';
}

function createSelfCheckLogger(app) {
  const logDir = getDeveloperLogsDir(app, 'agent-self-check');
  const logFile = path.join(logDir, 'latest.jsonl');
  let setupError = '';

  try {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    setupError = error?.message || String(error);
  }

  return {
    logDir,
    logFile,
    setupError,
    write(event, payload = {}) {
      if (setupError) return;
      try {
        fs.appendFileSync(logFile, `${JSON.stringify({ at: nowIso(), event, ...payload })}\n`, 'utf-8');
      } catch (error) {
        setupError = error?.message || String(error);
      }
    },
    getSetupError() {
      return setupError;
    },
  };
}

function compactSelfCheckError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || '智能体自检失败'),
    stage: error?.selfCheckStage || '',
    stack: clipText(error?.stack || '', 3000),
    agent_task_id: error?.agentTaskId || '',
    agent_title: error?.agentTitle || '',
    agent_workspace_dir: error?.agentWorkspaceDir || error?.openCodeWorkspaceDir || '',
    agent_runtime_root: error?.agentRuntimeRoot || error?.openCodeRuntimeRoot || '',
    agent_output_file: error?.agentOutputFile || '',
    agent_output_path: error?.agentOutputPath || '',
    agent_partial_output_chars: error?.agentPartialOutputChars || 0,
    agent_partial_output: clipText(error?.agentPartialOutput || '', 2000),
    opencode_binary_path: error?.openCodeBinaryPath || '',
    opencode_base_url: error?.openCodeBaseUrl || '',
    opencode_port: error?.openCodePort || parsePortFromUrl(error?.openCodeBaseUrl),
    opencode_exit_code: error?.openCodeExitCode,
    opencode_exit_signal: error?.openCodeExitSignal || '',
    opencode_spawn_error: error?.openCodeSpawnError || '',
    opencode_last_health_error: error?.openCodeLastHealthError || '',
    opencode_last_health_cause: error?.openCodeLastHealthCause || '',
    opencode_stdout_tail: clipText(error?.openCodeStdoutTail || '', 4000),
    opencode_stderr_tail: clipText(error?.openCodeStderrTail || '', 4000),
    opencode_request_log: Array.isArray(error?.openCodeRequestLog) ? error.openCodeRequestLog : [],
  };
}

function buildSelfCheckPrompt() {
  return `请完成易标智能体自检。

要求：
1. 阅读 self-check-input.txt。
2. 必须把以下纯 JSON 写入 ${SELF_CHECK_OUTPUT_FILE}：
{"ok":true,"message":"${SELF_CHECK_EXPECTED_MESSAGE}"}
3. 不要写入 Markdown 代码块，不要添加解释文字。`;
}

function parseSelfCheckOutput(content) {
  const raw = String(content || '').trim();
  if (!raw) {
    throw createStageError('output-check', '智能体自检未生成输出文件内容');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw createStageError('output-check', `智能体自检输出不是合法 JSON：${error?.message || String(error)}`);
  }
}

function validateSelfCheckOutput(content) {
  const data = parseSelfCheckOutput(content);
  if (data?.ok !== true || data?.message !== SELF_CHECK_EXPECTED_MESSAGE) {
    throw createStageError('output-check', `智能体自检输出不符合预期：${clipText(content, 1000)}`);
  }
  return data;
}

function formatSelfCheckDetails(result) {
  const lines = [
    `状态：${result.success ? '正常' : '异常'}`,
    `自动诊断：${result.conclusion || '-'}`,
    `时间：${result.checked_at}`,
    `消息：${result.message}`,
    `OpenCode 路径：${result.opencode_binary_path || '-'}`,
    `运行目录：${result.runtime_root || '-'}`,
    `工作目录：${result.workspace_dir || '-'}`,
    `自检日志：${result.log_file || '-'}`,
  ];

  lines.push('');
  lines.push('阶段：');
  result.steps.forEach((step) => {
    lines.push(`- ${step.label}：${step.status}${step.message ? `，${step.message}` : ''}`);
  });

  if (result.error) {
    lines.push('');
    lines.push('错误：');
    lines.push(result.error.message || String(result.error));
  }

  if (result.model_config) {
    lines.push('');
    lines.push('模型配置摘要：');
    lines.push(JSON.stringify(result.model_config, null, 2));
  }

  if (result.direct_model_test) {
    lines.push('');
    lines.push('直接模型测试：');
    lines.push(JSON.stringify(result.direct_model_test, null, 2));
  }

  if (result.diagnostics?.opencode_last_health_cause) {
    lines.push(`health cause：${result.diagnostics.opencode_last_health_cause}`);
  }
  if (result.diagnostics?.opencode_spawn_error) {
    lines.push(`spawn error：${result.diagnostics.opencode_spawn_error}`);
  }
  if (result.diagnostics?.opencode_exit_code !== undefined || result.diagnostics?.opencode_exit_signal) {
    lines.push(`exit：code=${result.diagnostics.opencode_exit_code ?? 'null'} signal=${result.diagnostics.opencode_exit_signal || 'null'}`);
  }
  if (result.diagnostics?.opencode_stdout_tail) {
    lines.push('');
    lines.push('stdout tail：');
    lines.push(result.diagnostics.opencode_stdout_tail);
  }
  if (result.diagnostics?.opencode_stderr_tail) {
    lines.push('');
    lines.push('stderr tail：');
    lines.push(result.diagnostics.opencode_stderr_tail);
  }
  if (result.diagnostics?.opencode_request_log?.length) {
    lines.push('');
    lines.push('OpenCode request log：');
    lines.push(JSON.stringify(result.diagnostics.opencode_request_log, null, 2));
  }
  if (result.proxy_diagnostics?.events?.length) {
    lines.push('');
    lines.push('AI proxy 事件：');
    lines.push(JSON.stringify(result.proxy_diagnostics.events, null, 2));
  }
  if (result.workspace_snapshot) {
    lines.push('');
    lines.push('工作目录快照：');
    lines.push(JSON.stringify(result.workspace_snapshot, null, 2));
  }
  if (result.output_content) {
    lines.push('');
    lines.push('输出：');
    lines.push(clipText(result.output_content, 1000));
  }

  return lines.join('\n');
}

function sanitizeReportFilename(value) {
  return String(value || '智能体自检报告')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '') || '智能体自检报告';
}

function formatTimestampForFilename(value) {
  const date = value ? new Date(value) : new Date();
  const source = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, '0');
  return [
    source.getFullYear(),
    pad(source.getMonth() + 1),
    pad(source.getDate()),
    '-',
    pad(source.getHours()),
    pad(source.getMinutes()),
    pad(source.getSeconds()),
  ].join('');
}

function markdownValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function markdownFence(value, language = '') {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const text = String(content || '').trim();
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text || '-'}\n${fence}`;
}

function buildSelfCheckReportMarkdown(input = {}) {
  const result = input && typeof input === 'object' ? input : {};
  const diagnostics = result.diagnostics || result.error || {};
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const lines = [
    '# 易标智能体自检报告',
    '',
    '## 自动诊断结论',
    '',
    markdownValue(result.conclusion),
    '',
    '## 基本信息',
    '',
    `- 状态：${result.success ? '正常' : '异常'}`,
    `- 消息：${markdownValue(result.message)}`,
    `- 检测时间：${markdownValue(result.checked_at)}`,
    `- 耗时：${result.duration_ms ? `${result.duration_ms} ms` : '-'}`,
    `- OpenCode 路径：${markdownValue(result.opencode_binary_path || diagnostics.opencode_binary_path)}`,
    `- Runtime 目录：${markdownValue(result.runtime_root || diagnostics.agent_runtime_root)}`,
    `- Workspace 目录：${markdownValue(result.workspace_dir || diagnostics.agent_workspace_dir)}`,
    `- 输出文件：${markdownValue(result.output_path || diagnostics.agent_output_path)}`,
    `- 自检日志：${markdownValue(result.log_file)}`,
    '',
    '## 自检阶段',
    '',
  ];

  if (steps.length) {
    lines.push('| 阶段 | 状态 | 信息 | 更新时间 |');
    lines.push('| --- | --- | --- | --- |');
    steps.forEach((step) => {
      lines.push(`| ${markdownValue(step.label).replace(/\|/g, '\\|')} | ${markdownValue(step.status).replace(/\|/g, '\\|')} | ${markdownValue(step.message).replace(/\|/g, '\\|')} | ${markdownValue(step.updated_at).replace(/\|/g, '\\|')} |`);
    });
  } else {
    lines.push('无阶段信息。');
  }

  lines.push('', '## 错误详情', '');
  if (result.error || !result.success) {
    lines.push(`- 名称：${markdownValue(diagnostics.name)}`);
    lines.push(`- 阶段：${markdownValue(diagnostics.stage)}`);
    lines.push(`- 信息：${markdownValue(diagnostics.message || result.message)}`);
    lines.push(`- OpenCode Base URL：${markdownValue(diagnostics.opencode_base_url)}`);
    lines.push(`- OpenCode 端口：${markdownValue(diagnostics.opencode_port)}`);
    lines.push(`- 进程退出码：${markdownValue(diagnostics.opencode_exit_code)}`);
    lines.push(`- 进程退出信号：${markdownValue(diagnostics.opencode_exit_signal)}`);
    lines.push(`- Spawn 错误：${markdownValue(diagnostics.opencode_spawn_error)}`);
    lines.push(`- Health 错误：${markdownValue(diagnostics.opencode_last_health_error)}`);
    lines.push(`- Health 原因：${markdownValue(diagnostics.opencode_last_health_cause)}`);
  } else {
    lines.push('本次自检未发现错误。');
  }

  lines.push('', '## 环境快照', '', markdownFence(result.environment || {}, 'json'));
  lines.push('', '## 模型配置摘要', '', markdownFence(result.model_config || {}, 'json'));
  lines.push('', '## 直接模型测试', '', markdownFence(result.direct_model_test || {}, 'json'));
  lines.push('', '## AI Proxy 事件', '', markdownFence(result.proxy_diagnostics?.events || [], 'json'));
  lines.push('', '## Workspace 文件快照', '', markdownFence(result.workspace_snapshot || {}, 'json'));
  lines.push('', '## Agent 返回结构摘要', '', markdownFence(result.agent_result || {}, 'json'));
  lines.push('', '## 页面展示详情', '', markdownFence(result.detail_text || '', 'text'));
  lines.push('', '## 智能体输出', '', markdownFence(result.output_content || diagnostics.agent_partial_output || '', 'json'));
  lines.push('', '## OpenCode stdout tail', '', markdownFence(diagnostics.opencode_stdout_tail || '', 'text'));
  lines.push('', '## OpenCode stderr tail', '', markdownFence(diagnostics.opencode_stderr_tail || '', 'text'));
  lines.push('', '## OpenCode request log', '', markdownFence(diagnostics.opencode_request_log || [], 'json'));
  lines.push('', '## 完整结构化结果', '', markdownFence(result, 'json'));

  return `${lines.join('\n')}\n`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new Error('Agent 任务已取消');
  }
}

function readOutputContent(workspaceDir, outputFile) {
  const outputPath = path.join(workspaceDir, safeRelativePath(outputFile));
  return {
    path: outputPath,
    content: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
  };
}

function annotateAgentError(error, meta) {
  error.agentTaskId = meta.taskId;
  error.agentTitle = meta.title;
  error.agentWorkspaceDir = meta.workspaceDir;
  error.agentRuntimeRoot = meta.runtimeRoot || '';
  error.agentOutputFile = meta.outputFile;
  error.agentOutputPath = meta.outputPath || '';
  error.agentPartialOutput = meta.outputContent || '';
  error.agentPartialOutputChars = String(meta.outputContent || '').length;
  error.openCodeRequestLog = Array.isArray(meta.requestLog) ? meta.requestLog : [];
  error.openCodeStderrTail = meta.stderrTail || '';
  error.openCodeStdoutTail = meta.stdoutTail || '';
  return error;
}

function createAgentService({ app, configStore }) {
  async function runTask(payload = {}) {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const taskRoot = path.join(getAgentRuntimeDir(app), taskId);
    const workspaceDir = path.join(taskRoot, 'workspace');

    const prompt = payload.prompt || createDefaultAgentPrompt({
      task: payload.task || '请分析当前输入文件，并输出可执行结果。',
      outputFile,
    });

    const timeoutMs = Number(payload.timeout_ms || 10 * 60 * 1000);
    const abortController = createTaskAbortController(payload.signal, timeoutMs);

    let server = null;
    try {
      throwIfAborted(abortController.signal);
      writeWorkspaceFiles(workspaceDir, payload.files || []);

      server = await startIsolatedOpenCodeServer({
        app,
        configStore,
        workspaceDir,
        taskId,
        keepRuntime: Boolean(payload.keep_runtime),
        timeoutMs,
        diagnostics: payload.diagnostics,
        onStage: payload.on_stage,
      });
      throwIfAborted(abortController.signal);

      let result = null;
      try {
        result = await runOpenCodeTask(server, {
          title,
          prompt,
          signal: abortController.signal,
        });
      } catch (error) {
        const output = readOutputContent(workspaceDir, outputFile);
        annotateAgentError(error, {
          taskId,
          title,
          workspaceDir,
          runtimeRoot: server?.runtimeRoot || taskRoot,
          outputFile,
          outputPath: output.path,
          outputContent: output.content,
          requestLog: server?.requestLog || [],
          stderrTail: server?.getStderrTail?.(8000) || '',
          stdoutTail: server?.getStdoutTail?.(8000) || '',
        });
        throw error;
      }

      const output = readOutputContent(workspaceDir, outputFile);
      trackAgentRuntime(app, configStore, 'success');

      return {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: workspaceDir,
        runtime_root: server?.runtimeRoot || taskRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session?.id || '',
        opencode_request_log: server?.requestLog || [],
        opencode_stderr_tail: server?.getStderrTail?.(8000) || '',
        opencode_stdout_tail: server?.getStdoutTail?.(8000) || '',
      };
    } catch (error) {
      trackAgentRuntime(app, configStore, 'failed');
      if (!error.agentTaskId) {
        const output = readOutputContent(workspaceDir, outputFile);
        annotateAgentError(error, {
          taskId,
          title,
          workspaceDir,
          runtimeRoot: server?.runtimeRoot || taskRoot,
          outputFile,
          outputPath: output.path,
          outputContent: output.content,
          requestLog: server?.requestLog || [],
          stderrTail: server?.getStderrTail?.(8000) || '',
          stdoutTail: server?.getStdoutTail?.(8000) || '',
        });
      }
      throw error;
    } finally {
      abortController.cleanup();
      if (server) {
        await server.close();
      }
    }
  }

  async function selfCheck() {
    const checkedAt = nowIso();
    const startedAt = Date.now();
    const steps = createSelfCheckSteps();
    const logger = createSelfCheckLogger(app);
    const proxyDiagnostics = createSelfCheckCollector();
    const taskRoot = path.join(getAgentRuntimeDir(app), SELF_CHECK_TASK_ID);
    const workspaceDir = path.join(taskRoot, 'workspace');
    const outputPath = path.join(workspaceDir, SELF_CHECK_OUTPUT_FILE);
    const opencodeBinaryPath = getBundledOpencodeBinaryPath(app);

    let server = null;
    let config = null;
    let environmentSnapshot = null;
    let directModelTest = null;
    let session = null;
    let messageResult = null;
    let diff = [];
    let workspaceSnapshot = null;
    let outputContent = '';
    const abortController = createTaskAbortController(null, SELF_CHECK_TIMEOUT_MS);

    const updateStage = (stage, status, message) => {
      updateSelfCheckStep(steps, stage, status, message);
      logger.write('self-check.stage', { stage, status, message });
    };

    function createResult(success, message, errorDiagnostics = null) {
      const diagnostics = errorDiagnostics || {
        opencode_request_log: server?.requestLog || [],
        opencode_stdout_tail: clipText(server?.getStdoutTail?.(8000) || '', 4000),
        opencode_stderr_tail: clipText(server?.getStderrTail?.(8000) || '', 4000),
        opencode_base_url: server?.baseUrl || '',
        opencode_port: server?.port || parsePortFromUrl(server?.baseUrl),
      };
      const result = {
        success,
        status: success ? 'normal' : 'error',
        message,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logger.logDir,
        log_file: logger.logFile,
        runtime_root: taskRoot,
        workspace_dir: workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: outputPath,
        output_content: outputContent,
        opencode_binary_path: opencodeBinaryPath,
        model_config: summarizeTextModelConfig(config || {}),
        environment: environmentSnapshot,
        direct_model_test: directModelTest,
        opencode_request_log: server?.requestLog || diagnostics.opencode_request_log || [],
        proxy_diagnostics: { events: proxyDiagnostics.events },
        workspace_snapshot: workspaceSnapshot,
        steps,
        diagnostics,
        ...(errorDiagnostics ? { error: errorDiagnostics } : {}),
      };
      result.conclusion = createSelfCheckConclusion(result);
      result.detail_text = formatSelfCheckDetails(result);
      return result;
    }

    try {
      updateStage('prepare', 'running', '正在清理旧自检运行目录');
      fs.rmSync(taskRoot, { recursive: true, force: true });
      updateStage('prepare', 'success', logger.getSetupError() ? `自检日志初始化失败：${logger.getSetupError()}` : '已清理旧自检日志和运行目录');

      logger.write('self-check.started', {
        task_id: SELF_CHECK_TASK_ID,
        opencode_binary_path: opencodeBinaryPath,
        runtime_root: taskRoot,
        workspace_dir: workspaceDir,
      });

      config = configStore.load();
      updateStage('environment-snapshot', 'running', '正在采集环境和模型配置摘要');
      environmentSnapshot = createEnvironmentSnapshot(app, opencodeBinaryPath, config);
      updateStage('environment-snapshot', 'success', `模型：${config?.model_name || '-'}`);

      updateStage('binary-check', 'running', '正在检查 OpenCode 程序文件');
      if (!fs.existsSync(opencodeBinaryPath)) {
        throw createStageError('binary-check', `OpenCode binary 不存在：${opencodeBinaryPath}`);
      }
      const binaryStat = safeStat(opencodeBinaryPath);
      updateStage('binary-check', 'success', `${opencodeBinaryPath}${binaryStat?.size ? `（${binaryStat.size} bytes）` : ''}`);

      updateStage('runtime-write-check', 'running', '正在检查自检工作目录写入能力');
      fs.mkdirSync(workspaceDir, { recursive: true });
      const writeProbePath = path.join(workspaceDir, 'write-probe.txt');
      fs.writeFileSync(writeProbePath, 'ok', 'utf-8');
      fs.rmSync(writeProbePath, { force: true });
      updateStage('runtime-write-check', 'success', workspaceDir);

      updateStage('direct-model-test', 'running', '正在直接测试当前文本模型');
      directModelTest = await runDirectModelSelfCheck(config);
      if (!directModelTest.success) {
        throw createStageError('direct-model-test', directModelTest.message || '直接模型测试失败');
      }
      updateStage('direct-model-test', 'success', `${directModelTest.duration_ms}ms`);

      writeWorkspaceFiles(workspaceDir, [
        { path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' },
      ]);

      server = await startIsolatedOpenCodeServer({
        app,
        configStore,
        workspaceDir,
        taskId: SELF_CHECK_TASK_ID,
        keepRuntime: true,
        timeoutMs: SELF_CHECK_TIMEOUT_MS,
        diagnostics: proxyDiagnostics,
        onStage: updateStage,
      });

      updateStage('session-create', 'running', '正在创建 OpenCode Session');
      session = await createSession(server, '易标智能体自检', { signal: abortController.signal });
      updateStage('session-create', 'success', `session_id=${session?.id || '-'}`);

      updateStage('message-wait', 'running', '正在执行极简智能体任务并等待输出');
      messageResult = await sendPrompt(server, session.id, buildSelfCheckPrompt(), {
        signal: abortController.signal,
        agent: 'build',
      });
      updateStage('message-wait', 'success', `parts=${Array.isArray(messageResult?.parts) ? messageResult.parts.length : 0}`);

      updateStage('diff-fetch', 'running', '正在读取 OpenCode Diff');
      diff = await getSessionDiff(server, session.id, { signal: abortController.signal }).catch((error) => {
        logger.write('self-check.diff.failed', { error: error?.message || String(error) });
        return [];
      });
      updateStage('diff-fetch', 'success', `diff=${Array.isArray(diff) ? diff.length : 0}`);

      updateStage('output-check', 'running', '正在校验智能体输出');
      outputContent = String(readOutputContent(workspaceDir, SELF_CHECK_OUTPUT_FILE).content || '').trim();
      validateSelfCheckOutput(outputContent);
      updateStage('output-check', 'success', '输出内容符合预期');

      updateStage('workspace-snapshot', 'running', '正在采集工作目录文件快照');
      workspaceSnapshot = snapshotWorkspace(workspaceDir);
      updateStage('workspace-snapshot', 'success', `${workspaceSnapshot.files?.length || 0} 个条目`);

      const result = createResult(true, '智能体自检正常');
      result.agent_result = {
        session_id: session?.id || '',
        message_parts_count: Array.isArray(messageResult?.parts) ? messageResult.parts.length : 0,
        message_part_types: Array.isArray(messageResult?.parts) ? messageResult.parts.map((part) => part?.type || '').filter(Boolean) : [],
        assistant_text_chars: String((messageResult?.parts || []).filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n')).length,
        diff_count: Array.isArray(diff) ? diff.length : 0,
      };
      logger.write('self-check.completed', result);
      return result;
    } catch (error) {
      const stage = error?.selfCheckStage || getCurrentSelfCheckStage(steps);
      updateStage(stage, 'error', error?.message || String(error || '智能体自检失败'));
      try {
        outputContent = outputContent || String(readOutputContent(workspaceDir, SELF_CHECK_OUTPUT_FILE).content || '').trim();
      } catch {}
      try {
        updateStage('workspace-snapshot', 'running', '正在采集失败现场工作目录快照');
        workspaceSnapshot = snapshotWorkspace(workspaceDir);
        updateStage('workspace-snapshot', 'success', `${workspaceSnapshot.files?.length || 0} 个条目`);
      } catch {}
      if (!error.agentTaskId) {
        const output = readOutputContent(workspaceDir, SELF_CHECK_OUTPUT_FILE);
        annotateAgentError(error, {
          taskId: SELF_CHECK_TASK_ID,
          title: '易标智能体自检',
          workspaceDir,
          runtimeRoot: taskRoot,
          outputFile: SELF_CHECK_OUTPUT_FILE,
          outputPath: output.path,
          outputContent: output.content,
          requestLog: server?.requestLog || [],
          stderrTail: server?.getStderrTail?.(8000) || '',
          stdoutTail: server?.getStdoutTail?.(8000) || '',
        });
      }
      error.selfCheckStage = error.selfCheckStage || stage;
      const diagnostics = compactSelfCheckError(error);
      outputContent = outputContent || diagnostics.agent_partial_output || '';

      const result = createResult(false, error?.message || '智能体自检失败', {
        ...diagnostics,
        opencode_binary_path: diagnostics.opencode_binary_path || opencodeBinaryPath,
        opencode_port: diagnostics.opencode_port || parsePortFromUrl(diagnostics.opencode_base_url),
        opencode_request_log: server?.requestLog || diagnostics.opencode_request_log || [],
        opencode_stdout_tail: diagnostics.opencode_stdout_tail || clipText(server?.getStdoutTail?.(8000) || '', 4000),
        opencode_stderr_tail: diagnostics.opencode_stderr_tail || clipText(server?.getStderrTail?.(8000) || '', 4000),
      });
      logger.write('self-check.failed', result);
      return result;
    } finally {
      abortController.cleanup();
      if (server) {
        await server.close();
      }
    }
  }

  async function exportSelfCheckReport(result = {}) {
    const markdown = buildSelfCheckReportMarkdown(result);
    const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
    const defaultName = `${sanitizeReportFilename('智能体自检报告')}-${formatTimestampForFilename(result?.checked_at)}.md`;
    const saveResult = await dialog.showSaveDialog({
      title: '导出智能体自检报告',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }

    fs.writeFileSync(saveResult.filePath, markdown, 'utf-8');
    return { success: true, path: saveResult.filePath, message: '智能体自检报告已导出' };
  }

  return {
    runTask,
    selfCheck,
    exportSelfCheckReport,
  };
}

module.exports = {
  createAgentService,
};
