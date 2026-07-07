const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  getAgentCacheDir,
  getAgentRuntimeDir,
  getDeveloperLogsDir,
  getUserDataPath,
} = require('../../utils/paths.cjs');
const {
  BUNDLED_COMMANDS,
  SHIM_COMMANDS,
  applyOpenCodeToolEnvironment,
  ensureOpenCodeToolEnvironment,
} = require('./opencodeToolEnvironment.cjs');

const SELF_CHECK_TASK_ID = 'agent-self-check-latest';
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_EXPECTED_MESSAGE = 'YIBIAO_AGENT_SELF_CHECK_OK';
const SELF_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const SELF_CHECK_DIRECT_MODEL_TIMEOUT_MS = 30 * 1000;
const TOOL_CHECK_TIMEOUT_MS = 10 * 1000;
const TOOL_CHECK_CRITICAL_COMMANDS = new Set(['rg', 'fd', 'jq', 'node']);
const POWERSHELL_ALIAS_PRONE_COMMANDS = new Set(['cat', 'cp', 'ls', 'mkdir', 'mv', 'pwd', 'rm', 'sort']);
const TOOL_CHECK_INPUT = ['alpha', 'beta', 'alpha', 'gamma'].join('\n');

const TOOL_CHECK_DESCRIPTORS = [
  ...BUNDLED_COMMANDS.map((command) => ({ command, label: command, type: 'bundled' })),
  { command: 'node', label: 'node', type: 'shim', testCommand: 'node -e "console.log(process.version)"' },
  ...SHIM_COMMANDS.map((command) => ({ command, label: command, type: 'shim' })),
];

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（已截断，原始长度 ${text.length}）` : text;
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function getExecutableName(command) {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function getExpectedToolPath(toolEnvironment, descriptor) {
  if (descriptor.command === 'node') {
    return path.join(toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? 'node.cmd' : 'node');
  }
  if (descriptor.type === 'bundled') {
    return path.join(toolEnvironment.bundledToolsBinDir, getExecutableName(descriptor.command));
  }
  return path.join(toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? `${descriptor.command}.cmd` : descriptor.command);
}

function buildMinimalToolCheckEnv(extra = {}) {
  const keepKeys = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'ComSpec',
    'PATHEXT',
  ];
  const env = {};
  keepKeys.forEach((key) => {
    if (process.env[key]) env[key] = process.env[key];
  });
  return { ...env, ...extra };
}

function shellCommand(command, cwd, env, timeoutMs = TOOL_CHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  const child = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    : spawnSync('/bin/sh', ['-lc', command], {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
  return {
    exit_code: child.status ?? (child.error ? 1 : 0),
    signal: child.signal || '',
    stdout: clipText(child.stdout || '', 1000).trim(),
    stderr: clipText(child.stderr || '', 1000).trim(),
    error: child.error?.message || '',
    timed_out: child.error?.code === 'ETIMEDOUT',
    duration_ms: Date.now() - startedAt,
  };
}

function resolveToolCommand(command, cwd, env) {
  const escaped = String(command || '').replace(/'/g, "''");
  const resolveCommand = process.platform === 'win32'
    ? `$cmd = Get-Command -Name '${escaped}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $cmd) { exit 9 }; $source = [string]$cmd.Source; if (-not $source) { $source = [string]$cmd.Definition }; [Console]::WriteLine(([string]$cmd.CommandType) + '|' + $source)`
    : `resolved=$(command -v ${command} 2>/dev/null) || exit 9; printf 'Application|%s\n' "$resolved"`;
  const result = shellCommand(resolveCommand, cwd, env, 5000);
  if (result.exit_code !== 0) {
    return {
      found: false,
      command_type: '',
      source: '',
      message: result.stderr || result.error || `命令解析失败，exit=${result.exit_code}`,
    };
  }
  const [commandType, ...sourceParts] = String(result.stdout || '').split('|');
  return {
    found: true,
    command_type: commandType || '',
    source: clipText(sourceParts.join('|'), 500),
    message: '',
  };
}

function getToolTestCommand(command) {
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

function prepareToolCheckFixture(checkDir, command) {
  if (command === 'cp') {
    fs.rmSync(path.join(checkDir, 'cp-output.txt'), { force: true });
  }
  if (command === 'mkdir') {
    fs.rmSync(path.join(checkDir, 'mkdir-output'), { recursive: true, force: true });
  }
  if (command === 'mv') {
    fs.writeFileSync(path.join(checkDir, 'mv-source.txt'), 'move me\n', 'utf-8');
    fs.rmSync(path.join(checkDir, 'mv-output.txt'), { force: true });
  }
  if (command === 'rm') {
    fs.writeFileSync(path.join(checkDir, 'rm-source.txt'), 'remove me\n', 'utf-8');
  }
  if (command === 'touch') {
    fs.rmSync(path.join(checkDir, 'touch-output.txt'), { force: true });
  }
}

function buildToolCheckStatus({ descriptor, expectedPath, resolution, smoke }) {
  const expectedExists = fs.existsSync(expectedPath);
  const resolvedSource = normalizePathForCompare(resolution.source);
  const expectedSource = normalizePathForCompare(expectedPath);
  const resolvedToExpected = Boolean(resolvedSource && expectedSource && resolvedSource === expectedSource);
  const isPowerShellAlias = process.platform === 'win32' && ['Alias', 'Cmdlet', 'Function'].includes(resolution.command_type);
  const critical = TOOL_CHECK_CRITICAL_COMMANDS.has(descriptor.command);

  if (!expectedExists) {
    return { status: critical ? 'error' : 'warning', message: `期望文件不存在：${expectedPath}` };
  }
  if (!resolution.found) {
    return { status: critical ? 'error' : 'warning', message: resolution.message || '命令无法在 PATH 中解析' };
  }
  if (smoke.exit_code !== 0 || smoke.timed_out) {
    return {
      status: critical ? 'error' : 'warning',
      message: smoke.timed_out ? '执行超时' : smoke.stderr || smoke.error || `执行失败，exit=${smoke.exit_code}`,
    };
  }
  if (!resolvedToExpected) {
    if (POWERSHELL_ALIAS_PRONE_COMMANDS.has(descriptor.command) && isPowerShellAlias) {
      return { status: 'warning', message: `命令可执行，但当前由 PowerShell ${resolution.command_type} 处理` };
    }
    if (critical) {
      return { status: 'error', message: `命令未解析到易标集成路径：${resolution.source}` };
    }
    return { status: 'warning', message: `命令可执行，但未解析到易标集成路径：${resolution.source}` };
  }
  return { status: 'success', message: '可用' };
}

function summarizeToolChecks(items) {
  const total = items.length;
  const successCount = items.filter((item) => item.status === 'success').length;
  const warningCount = items.filter((item) => item.status === 'warning').length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  const parts = [`${successCount}/${total} 可用`];
  if (warningCount) parts.push(`${warningCount} 个警告`);
  if (errorCount) parts.push(`${errorCount} 个失败`);
  return parts.join('，');
}

function runIntegratedToolSelfCheck({ app, runtimeRoot, workspaceDir, logger } = {}) {
  const checkDir = path.join(workspaceDir, `.agent-tool-check-${Date.now()}`);
  const homeDir = path.join(runtimeRoot, 'home');
  const dataHome = path.join(homeDir, '.local', 'share');
  const cacheHome = path.join(getAgentCacheDir(app), 'opencode-cache');
  let toolEnvironment = null;

  try {
    fs.mkdirSync(checkDir, { recursive: true });
    fs.writeFileSync(path.join(checkDir, 'tool-check-input.txt'), `${TOOL_CHECK_INPUT}\n`, 'utf-8');

    toolEnvironment = ensureOpenCodeToolEnvironment({ app, workspaceDir });
    const env = applyOpenCodeToolEnvironment(buildMinimalToolCheckEnv({
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
    }), toolEnvironment);

    const items = TOOL_CHECK_DESCRIPTORS.map((descriptor) => {
      const expectedPath = getExpectedToolPath(toolEnvironment, descriptor);
      prepareToolCheckFixture(checkDir, descriptor.command);
      const resolution = resolveToolCommand(descriptor.command, checkDir, env);
      const smoke = resolution.found
        ? shellCommand(descriptor.testCommand || getToolTestCommand(descriptor.command), checkDir, env)
        : { exit_code: 1, stdout: '', stderr: '', error: resolution.message || '命令未解析', timed_out: false, duration_ms: 0 };
      const status = buildToolCheckStatus({ descriptor, expectedPath, resolution, smoke });
      const item = {
        id: descriptor.command,
        label: descriptor.label,
        command: descriptor.command,
        type: descriptor.type,
        critical: TOOL_CHECK_CRITICAL_COMMANDS.has(descriptor.command),
        status: status.status,
        message: status.message,
        expected_path: expectedPath,
        resolved_type: resolution.command_type,
        resolved_source: resolution.source,
        exit_code: smoke.exit_code,
        duration_ms: smoke.duration_ms,
        stdout: smoke.stdout,
        stderr: smoke.stderr || smoke.error,
      };
      logger?.write?.('tool-check', item);
      return item;
    });

    const summary = summarizeToolChecks(items);
    return {
      success: !items.some((item) => item.status === 'error'),
      summary,
      runtime_tools_bin_dir: toolEnvironment.runtimeToolsBinDir,
      bundled_tools_bin_dir: toolEnvironment.bundledToolsBinDir,
      path_entries: toolEnvironment.pathEntries,
      items,
    };
  } catch (error) {
    const message = error?.message || String(error || '集成工具校验失败');
    logger?.write?.('tool-check-error', { message });
    return {
      success: false,
      summary: message,
      runtime_tools_bin_dir: toolEnvironment?.runtimeToolsBinDir || '',
      bundled_tools_bin_dir: toolEnvironment?.bundledToolsBinDir || '',
      path_entries: toolEnvironment?.pathEntries || [],
      items: TOOL_CHECK_DESCRIPTORS.map((descriptor) => ({
        id: descriptor.command,
        label: descriptor.label,
        command: descriptor.command,
        type: descriptor.type,
        critical: TOOL_CHECK_CRITICAL_COMMANDS.has(descriptor.command),
        status: TOOL_CHECK_CRITICAL_COMMANDS.has(descriptor.command) ? 'error' : 'warning',
        message,
        expected_path: '',
        resolved_type: '',
        resolved_source: '',
        exit_code: 1,
        duration_ms: 0,
        stdout: '',
        stderr: message,
      })),
    };
  } finally {
    try { fs.rmSync(checkDir, { recursive: true, force: true }); } catch {}
  }
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
    return `结论：${failedStep.label}失败，问题位于本机 OpenCode/AI proxy 常驻链路。`;
  }
  if (failedStep?.id === 'tool-check') {
    return '结论：智能体集成命令工具存在不可用项，优先检查 OpenCode 工具目录、PATH 注入和 node shim。';
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
    { id: 'tool-check', label: '校验已集成命令工具', status: 'pending', message: '' },
    { id: 'direct-model-test', label: '直接测试文本模型', status: 'pending', message: '' },
    { id: 'ai-proxy-start', label: '确认常驻 OpenCode AI proxy', status: 'pending', message: '' },
    { id: 'opencode-config-write', label: '确认 OpenCode 常驻配置', status: 'pending', message: '' },
    { id: 'opencode-server-start', label: '确认常驻 OpenCode Server', status: 'pending', message: '' },
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
    `状态：${result.success ? '正常' : result.status === 'busy' ? '忙碌' : '异常'}`,
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
  (result.steps || []).forEach((step) => {
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

  if (Array.isArray(result.tool_checks) && result.tool_checks.length) {
    lines.push('');
    lines.push(`集成工具校验：${result.tool_check_summary || summarizeToolChecks(result.tool_checks)}`);
    result.tool_checks.forEach((item) => {
      lines.push(`- ${item.label || item.command}：${item.status}，${item.message || '-'}${item.resolved_source ? `，解析=${item.resolved_source}` : ''}`);
    });
  }

  if (result.runtime_status) {
    lines.push('');
    lines.push('Runtime 状态：');
    lines.push(JSON.stringify(result.runtime_status, null, 2));
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
    `- 状态：${result.success ? '正常' : result.status === 'busy' ? '忙碌' : '异常'}`,
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
  if (result.error || (!result.success && result.status !== 'busy')) {
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
  } else if (result.status === 'busy') {
    lines.push('Agent 正在处理其他任务，自检已跳过；这不是 OpenCode 故障。');
  } else {
    lines.push('本次自检未发现错误。');
  }

  lines.push('', '## 环境快照', '', markdownFence(result.environment || {}, 'json'));
  lines.push('', '## 模型配置摘要', '', markdownFence(result.model_config || {}, 'json'));
  lines.push('', '## 直接模型测试', '', markdownFence(result.direct_model_test || {}, 'json'));
  lines.push('', '## 集成工具校验', '');
  if (Array.isArray(result.tool_checks) && result.tool_checks.length) {
    lines.push(`摘要：${markdownValue(result.tool_check_summary || summarizeToolChecks(result.tool_checks))}`, '');
    lines.push('| 工具 | 类型 | 状态 | 信息 | 解析来源 | 期望路径 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    result.tool_checks.forEach((item) => {
      lines.push(`| ${markdownValue(item.label || item.command).replace(/\|/g, '\\|')} | ${markdownValue(item.type).replace(/\|/g, '\\|')} | ${markdownValue(item.status).replace(/\|/g, '\\|')} | ${markdownValue(item.message).replace(/\|/g, '\\|')} | ${markdownValue(item.resolved_source).replace(/\|/g, '\\|')} | ${markdownValue(item.expected_path).replace(/\|/g, '\\|')} |`);
    });
  } else {
    lines.push('无工具校验结果。');
  }
  lines.push('', '## Runtime 状态', '', markdownFence(result.runtime_status || {}, 'json'));
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

module.exports = {
  SELF_CHECK_TASK_ID,
  SELF_CHECK_OUTPUT_FILE,
  SELF_CHECK_TIMEOUT_MS,
  buildSelfCheckPrompt,
  buildSelfCheckReportMarkdown,
  compactSelfCheckError,
  createEnvironmentSnapshot,
  createSelfCheckConclusion,
  createSelfCheckLogger,
  createSelfCheckSteps,
  formatSelfCheckDetails,
  formatTimestampForFilename,
  getCurrentSelfCheckStage,
  runIntegratedToolSelfCheck,
  runDirectModelSelfCheck,
  sanitizeReportFilename,
  safeStat,
  snapshotWorkspace,
  summarizeTextModelConfig,
  updateSelfCheckStep,
  validateSelfCheckOutput,
};
