const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgentRuntimeDir } = require('../../utils/paths.cjs');
const { startOpenCodeSidecar, closeOpenCodeSidecar } = require('./opencodeServerRunner.cjs');
const { runOpenCodeTask } = require('./opencodeHttpClient.cjs');

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_INTERVAL_MS = 30 * 1000;
const HEALTH_FAILURE_LIMIT = 3;
const STATUS_TICK_MS = 1000;
const WORKSPACE_WATCH_INTERVAL_MS = 2000;
const BUSY_MESSAGE = 'Agent 正在处理其他任务，请耐心等待';
const SELF_CHECK_TASK_ID = 'agent-self-check-latest';
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_EXPECTED_MESSAGE = 'YIBIAO_AGENT_SELF_CHECK_OK';
const SELF_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimeoutMs(value, fallback = DEFAULT_AGENT_IDLE_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（已截断，原始长度 ${text.length}）` : text;
}

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

function safeTaskPathSegment(value) {
  return String(value || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || crypto.randomUUID();
}

function ensureInsideRoot(rootDir, targetPath, sourcePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`文件路径越界：${sourcePath}`);
  }
  return resolvedTarget;
}

function writeWorkspaceFiles(workspaceDir, files = []) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  files.forEach((file) => {
    const relativePath = safeRelativePath(file.path);
    const targetPath = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relativePath), file.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, String(file.content || ''), 'utf-8');
  });
}

function clearDirectoryContents(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
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
    throw new Error('智能体自检未生成输出文件内容');
  }
  const data = JSON.parse(raw);
  if (data?.ok !== true || data?.message !== SELF_CHECK_EXPECTED_MESSAGE) {
    throw new Error(`智能体自检输出不符合预期：${clipText(raw, 1000)}`);
  }
  return data;
}

function readOutputContent(workspaceDir, outputFile) {
  const relativePath = safeRelativePath(outputFile);
  const outputPath = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relativePath), outputFile);
  return {
    path: outputPath,
    content: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
  };
}

function annotateAgentError(error, meta = {}) {
  if (!error || typeof error !== 'object') return error;
  error.agentTaskId = meta.taskId || error.agentTaskId || '';
  error.agentTitle = meta.title || error.agentTitle || '';
  error.agentWorkspaceDir = meta.workspaceDir || error.agentWorkspaceDir || '';
  error.agentRuntimeRoot = meta.runtimeRoot || error.agentRuntimeRoot || '';
  error.agentOutputFile = meta.outputFile || error.agentOutputFile || '';
  error.agentOutputPath = meta.outputPath || error.agentOutputPath || '';
  error.agentPartialOutput = meta.outputContent || error.agentPartialOutput || '';
  error.agentPartialOutputChars = String(meta.outputContent || error.agentPartialOutput || '').length;
  error.openCodeRequestLog = Array.isArray(meta.requestLog) ? meta.requestLog : error.openCodeRequestLog || [];
  error.openCodeStderrTail = meta.stderrTail || error.openCodeStderrTail || '';
  error.openCodeStdoutTail = meta.stdoutTail || error.openCodeStdoutTail || '';
  return error;
}

function isUserCancelOrPause(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error || '');
  return code === 'CONTENT_GENERATION_PAUSED'
    || code === 'AI_QUEUE_SCOPE_PAUSED'
    || code === 'ABORT_ERR'
    || message === 'CONTENT_GENERATION_PAUSED'
    || message.includes('请求已取消')
    || message.includes('任务已取消');
}

function isWatchdogStall(error) {
  return error?.code === 'AGENT_STALLED';
}

function createStallError() {
  const error = new Error('Agent 长时间无进展，已停止本轮任务');
  error.code = 'AGENT_STALLED';
  return error;
}

function createOpenCodeRuntimeService({ app, configStore }) {
  const runtimeRoot = getAgentRuntimeDir(app);
  const serviceRuntimeRoot = path.join(runtimeRoot, 'service');
  const serviceWorkspaceDir = path.join(serviceRuntimeRoot, 'workspace');
  const tasksRoot = path.join(runtimeRoot, 'tasks');
  const diagnostics = createRuntimeDiagnostics();
  const listeners = new Set();

  let phase = 'stopped';
  let healthy = false;
  let message = 'Agent 服务未启动';
  let updatedAt = nowIso();
  let lastHealthAt = '';
  let lastHealthError = '';
  let lastExitCode = null;
  let lastExitSignal = '';
  let restartPending = false;
  let restartPendingReason = '';
  let sidecar = null;
  let startPromise = null;
  let closePromise = null;
  let activeTask = null;
  let activeTaskAbortController = null;
  let healthTimer = null;
  let statusTimer = null;
  let healthFailureCount = 0;
  let healthRestartAttempted = false;

  function ensureRuntimeDirs() {
    fs.mkdirSync(serviceRuntimeRoot, { recursive: true });
    fs.mkdirSync(serviceWorkspaceDir, { recursive: true });
    fs.mkdirSync(tasksRoot, { recursive: true });
  }

  function appendRuntimeEvent(event = {}) {
    diagnostics.record('runtime.event', event);
  }

  function getActiveTaskSummary() {
    if (!activeTask) return null;
    const now = Date.now();
    const startedAt = new Date(activeTask.started_at).getTime();
    const lastActivityAt = new Date(activeTask.last_activity_at).getTime();
    return {
      task_id: activeTask.task_id,
      title: activeTask.title,
      stage: activeTask.stage,
      progress_text: activeTask.progress_text,
      started_at: activeTask.started_at,
      last_activity_at: activeTask.last_activity_at,
      last_progress_at: activeTask.last_progress_at,
      elapsed_seconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
      idle_seconds: Math.max(0, Math.floor((now - lastActivityAt) / 1000)),
    };
  }

  function getStatus() {
    return {
      phase,
      healthy,
      message,
      updated_at: updatedAt,
      last_health_at: lastHealthAt,
      last_health_error: lastHealthError,
      restart_pending: restartPending,
      restart_pending_reason: restartPendingReason,
      active_task: getActiveTaskSummary(),
      proxy: sidecar?.getProxyStatus?.() || { active: 0, queued: 0, limit: 0 },
      opencode: {
        pid: sidecar?.pid || sidecar?.child?.pid || 0,
        base_url: sidecar?.baseUrl || '',
        port: sidecar?.port || 0,
        last_exit_code: lastExitCode,
        last_exit_signal: lastExitSignal,
      },
    };
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  let emitStatusTimer = null;
  function emitStatusThrottled() {
    if (emitStatusTimer) return;
    emitStatusTimer = setTimeout(() => {
      emitStatusTimer = null;
      emitStatus();
    }, 200);
  }

  function setPhase(nextPhase, nextMessage) {
    phase = nextPhase;
    healthy = nextPhase === 'idle' || nextPhase === 'running' || nextPhase === 'starting' || nextPhase === 'restarting';
    message = nextMessage || message;
    updatedAt = nowIso();
    appendRuntimeEvent({ phase, message, source: 'runtime.phase' });
    emitStatusThrottled();
    if (phase === 'idle' && restartPending && !activeTask) {
      setTimeout(() => {
        if (phase === 'idle' && restartPending && !activeTask) {
          void restart(restartPendingReason || 'config changed').catch((error) => {
            lastHealthError = error?.message || String(error || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
          });
        }
      }, 0);
    }
  }

  function touchActivity(event = {}) {
    if (!activeTask) {
      appendRuntimeEvent({ ...event, at: nowIso(), ignored: true, reason: 'no-active-task' });
      return;
    }
    if (!event.task_token || event.task_token !== activeTask.activity_token) {
      appendRuntimeEvent({ ...event, at: nowIso(), stale: true });
      return;
    }

    const now = nowIso();
    activeTask.last_activity_at = now;
    if (event.visible !== false) {
      activeTask.stage = event.stage || activeTask.stage;
      activeTask.progress_text = event.message || activeTask.progress_text;
      activeTask.last_progress_at = now;
      message = activeTask.progress_text;
      updatedAt = now;
    }
    appendRuntimeEvent({ ...event, at: now });
    emitStatusThrottled();
  }

  function createTaskActivity(taskRef) {
    const taskToken = taskRef.activity_token;
    return (event = {}) => touchActivity({ ...event, task_token: taskToken });
  }

  function createActiveTask({ taskId, title, timeoutMs }) {
    const now = nowIso();
    return {
      task_id: taskId,
      title,
      stage: 'starting',
      progress_text: 'Agent 正在执行任务',
      started_at: now,
      last_activity_at: now,
      last_progress_at: now,
      timeout_ms: timeoutMs,
      activity_token: crypto.randomUUID(),
    };
  }

  function createBusyResult() {
    return {
      success: false,
      status: 'busy',
      skipped: true,
      message: BUSY_MESSAGE,
      active_task: getActiveTaskSummary(),
    };
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function startStatusTimer() {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      if (activeTask) emitStatus();
    }, STATUS_TICK_MS);
  }

  function stopStatusTimer() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  async function checkSidecarHealth() {
    if (!sidecar) throw new Error('OpenCode sidecar 未启动');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Agent 服务健康检查超时')), 5000);
    try {
      const opencodeResponse = await fetch(`${sidecar.baseUrl}/global/health`, {
        headers: { Authorization: sidecar.authHeader },
        signal: controller.signal,
      });
      if (!opencodeResponse.ok) {
        throw new Error(`OpenCode health status ${opencodeResponse.status}`);
      }
      const proxyResponse = await fetch(`${sidecar.aiProxyBaseUrl}/health`, { signal: controller.signal });
      if (!proxyResponse.ok) {
        throw new Error(`Agent proxy health status ${proxyResponse.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function stopIdleHealthTimer() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
  }

  function startIdleHealthTimer() {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (phase !== 'idle' || activeTask || !sidecar) return;
      void checkSidecarHealth()
        .then(() => {
          healthFailureCount = 0;
          healthRestartAttempted = false;
          lastHealthAt = nowIso();
          lastHealthError = '';
          updatedAt = lastHealthAt;
          emitStatusThrottled();
        })
        .catch((error) => {
          healthFailureCount += 1;
          lastHealthError = error?.message || String(error || 'Agent 服务健康检查失败');
          updatedAt = nowIso();
          appendRuntimeEvent({ at: updatedAt, source: 'health', message: lastHealthError, failure_count: healthFailureCount });
          if (healthFailureCount >= HEALTH_FAILURE_LIMIT) {
            setPhase('unhealthy', 'Agent 服务健康检查失败');
            if (!healthRestartAttempted) {
              healthRestartAttempted = true;
              void restart('idle health failed').catch((restartError) => {
                lastHealthError = restartError?.message || String(restartError || lastHealthError);
                setPhase('unhealthy', 'Agent 服务异常');
              });
            }
          }
          emitStatusThrottled();
        });
    }, HEALTH_INTERVAL_MS);
  }

  async function ensureStarted() {
    if (sidecar && phase !== 'unhealthy' && phase !== 'stopped' && phase !== 'closing') return sidecar;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      setPhase(phase === 'unhealthy' ? 'restarting' : 'starting', phase === 'unhealthy' ? '正在重启 Agent 服务' : '正在启动 Agent 服务');
      ensureRuntimeDirs();
      if (sidecar) {
        await closeOpenCodeSidecar(sidecar);
        sidecar = null;
      }
      sidecar = await startOpenCodeSidecar({
        app,
        configStore,
        runtimeRoot: serviceRuntimeRoot,
        workspaceDir: serviceWorkspaceDir,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        diagnostics,
        onActivity: touchActivity,
        getActivityContext: () => activeTask
          ? { task_token: activeTask.activity_token, task_id: activeTask.task_id }
          : null,
        onExit: handleOpenCodeExit,
      });
      if (phase === 'closing' || phase === 'stopped') {
        await closeOpenCodeSidecar(sidecar);
        sidecar = null;
        throw new Error('Agent 服务正在关闭');
      }
      healthFailureCount = 0;
      healthRestartAttempted = false;
      lastHealthAt = nowIso();
      lastHealthError = '';
      setPhase(activeTask ? 'running' : 'idle', activeTask ? 'Agent 正在执行任务' : 'Agent 服务空闲');
      startIdleHealthTimer();
      startStatusTimer();
      return sidecar;
    })();

    try {
      return await startPromise;
    } catch (error) {
      if (phase !== 'closing' && phase !== 'stopped') {
        setPhase('unhealthy', error?.message || 'Agent 服务启动失败');
      }
      throw error;
    } finally {
      startPromise = null;
    }
  }

  function handleOpenCodeExit({ code, signal }) {
    lastExitCode = code ?? null;
    lastExitSignal = signal || '';
    appendRuntimeEvent({ at: nowIso(), source: 'opencode.exit', code, signal });
    if (phase === 'closing' || phase === 'stopped') return;
    if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
      activeTaskAbortController.abort(new Error('OpenCode Server 已退出'));
    }
    setPhase('unhealthy', 'Agent 服务异常退出');
  }

  function bindParentSignal(parentSignal, controller) {
    if (!parentSignal) return () => {};
    const abortFromParent = () => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal.reason || new Error('Agent 任务已取消'));
      }
    };
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    return () => {
      try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
    };
  }

  function startActivityWatchdog({ timeoutMs, abort, taskActivity }) {
    const timer = setInterval(() => {
      if (!activeTask) return;
      const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
      if (idleMs >= timeoutMs) {
        taskActivity({
          stage: 'stalled',
          message: 'Agent 长时间无进展，正在停止本轮任务',
          source: 'watchdog',
        });
        abort(createStallError());
      }
    }, 2000);
    return () => clearInterval(timer);
  }

  function prepareStagingWorkspace(payload) {
    clearDirectoryContents(serviceWorkspaceDir);
    writeWorkspaceFiles(serviceWorkspaceDir, payload.files || []);
  }

  function cleanupStagingWorkspace() {
    clearDirectoryContents(serviceWorkspaceDir);
  }

  function archiveTaskWorkspace(taskId) {
    const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
    const archiveWorkspaceDir = path.join(taskDir, 'workspace');
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.cpSync(serviceWorkspaceDir, archiveWorkspaceDir, { recursive: true });
    return archiveWorkspaceDir;
  }

  function writeTaskDiagnostics(taskId, payload = {}) {
    try {
      const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'diagnostics.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {}
  }

  function writeTaskResult(taskId, payload = {}) {
    try {
      const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'result.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {}
  }

  function collectDiagnostics({ taskId, title, outputFile }) {
    let output = { path: '', content: '' };
    try { output = readOutputContent(serviceWorkspaceDir, outputFile); } catch {}
    return {
      taskId,
      title,
      workspaceDir: serviceWorkspaceDir,
      runtimeRoot: serviceRuntimeRoot,
      outputFile,
      outputPath: output.path,
      outputContent: output.content,
      requestLog: sidecar?.requestLog || [],
      stderrTail: sidecar?.getStderrTail?.(8000) || '',
      stdoutTail: sidecar?.getStdoutTail?.(8000) || '',
      status: getStatus(),
      events: diagnostics.events.slice(-120),
    };
  }

  function startOutputWatcher(outputFile, taskActivity) {
    let previousKey = '';
    const outputPath = ensureInsideRoot(serviceWorkspaceDir, path.join(serviceWorkspaceDir, safeRelativePath(outputFile)), outputFile);
    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(outputPath)) return;
        const stat = fs.statSync(outputPath);
        const nextKey = `${stat.size}:${stat.mtimeMs}`;
        if (previousKey && nextKey !== previousKey) {
          taskActivity({
            stage: 'tool',
            message: 'Agent 正在写入输出文件',
            source: 'workspace.output',
            meta: { size: stat.size },
          });
        }
        previousKey = nextKey;
      } catch {}
    }, WORKSPACE_WATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  async function runTask(payload = {}) {
    if (activeTask) return createBusyResult();

    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const timeoutMs = normalizeTimeoutMs(payload.timeout_ms, DEFAULT_AGENT_IDLE_TIMEOUT_MS);

    activeTask = createActiveTask({ taskId, title, timeoutMs });
    const taskActivity = createTaskActivity(activeTask);
    setPhase('running', 'Agent 正在执行任务');
    emitStatus();

    activeTaskAbortController = new AbortController();
    const stopParentAbort = bindParentSignal(payload.signal, activeTaskAbortController);
    const stopWatchdog = startActivityWatchdog({
      timeoutMs,
      abort: (error) => {
        if (!activeTaskAbortController.signal.aborted) activeTaskAbortController.abort(error);
      },
      taskActivity,
    });
    let stopOutputWatcher = null;
    let mustRestartAfterTask = false;
    let archivedWorkspaceDir = '';

    try {
      await ensureStarted();
      if (activeTaskAbortController.signal.aborted) throw activeTaskAbortController.signal.reason;

      taskActivity({ stage: 'workspace', message: '正在准备 Agent 工作目录', source: 'runtime' });
      prepareStagingWorkspace(payload);
      stopOutputWatcher = startOutputWatcher(outputFile, taskActivity);

      const result = await runOpenCodeTask(sidecar, {
        title,
        prompt: payload.prompt || createDefaultAgentPrompt({ task: payload.task || '请分析当前输入文件，并输出可执行结果。', outputFile }),
        signal: activeTaskAbortController.signal,
        agent: payload.agent || 'build',
        onActivity: taskActivity,
      });

      taskActivity({ stage: 'output', message: '正在读取 Agent 输出', source: 'runtime' });
      const output = readOutputContent(serviceWorkspaceDir, outputFile);

      taskActivity({ stage: 'archive', message: '正在保存 Agent 任务现场', source: 'runtime' });
      archivedWorkspaceDir = archiveTaskWorkspace(taskId);
      const diagnosticsPayload = collectDiagnostics({ taskId, title, outputFile });
      writeTaskDiagnostics(taskId, diagnosticsPayload);

      trackAgentRuntime(app, configStore, 'success');

      const taskResult = {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspaceDir,
        runtime_workspace_dir: serviceWorkspaceDir,
        runtime_root: serviceRuntimeRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session?.id || '',
        opencode_request_log: sidecar?.requestLog || [],
        opencode_stderr_tail: sidecar?.getStderrTail?.(8000) || '',
        opencode_stdout_tail: sidecar?.getStdoutTail?.(8000) || '',
      };
      writeTaskResult(taskId, taskResult);
      return taskResult;
    } catch (error) {
      if (isUserCancelOrPause(error)) {
        mustRestartAfterTask = true;
        throw annotateAgentError(error, collectDiagnostics({ taskId, title, outputFile }));
      }
      if (isWatchdogStall(error)) {
        mustRestartAfterTask = true;
      }
      trackAgentRuntime(app, configStore, 'failed');
      const diagnosticsPayload = collectDiagnostics({ taskId, title, outputFile });
      writeTaskDiagnostics(taskId, diagnosticsPayload);
      throw annotateAgentError(error, diagnosticsPayload);
    } finally {
      stopOutputWatcher?.();
      stopWatchdog?.();
      stopParentAbort?.();
      const shouldRestart = mustRestartAfterTask || phase === 'unhealthy';
      activeTask = null;
      activeTaskAbortController = null;
      try { cleanupStagingWorkspace(); } catch (error) { lastHealthError = error?.message || String(error); }

      if (phase !== 'closing' && phase !== 'stopped') {
        if (shouldRestart) {
          await restart('task aborted or stalled').catch((restartError) => {
            lastHealthError = restartError?.message || String(restartError || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
          });
        } else if (restartPending) {
          await restart('config changed').catch((restartError) => {
            lastHealthError = restartError?.message || String(restartError || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
          });
        } else {
          setPhase(sidecar ? 'idle' : 'unhealthy', sidecar ? 'Agent 服务空闲' : 'Agent 服务异常');
        }
      }
      emitStatus();
    }
  }

  async function warmup() {
    try {
      await ensureStarted();
      return getStatus();
    } catch (error) {
      lastHealthError = error?.message || String(error || 'Agent 服务启动失败');
      setPhase('unhealthy', 'Agent 服务启动失败');
      throw error;
    }
  }

  async function restart(reason = 'manual') {
    if (activeTask) {
      restartPending = true;
      restartPendingReason = reason;
      emitStatusThrottled();
      return getStatus();
    }
    restartPending = false;
    restartPendingReason = '';
    stopIdleHealthTimer();
    setPhase('restarting', '正在重启 Agent 服务');
    await closeOpenCodeSidecar(sidecar);
    sidecar = null;
    try { cleanupStagingWorkspace(); } catch {}
    await ensureStarted();
    return getStatus();
  }

  function markRestartPending(reason) {
    restartPending = true;
    restartPendingReason = reason || 'config changed';
    emitStatusThrottled();
    if (!activeTask && phase === 'idle') {
      void restart(restartPendingReason).catch((error) => {
        lastHealthError = error?.message || String(error || 'Agent 服务重启失败');
        setPhase('unhealthy', 'Agent 服务重启失败');
      });
    }
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    if (Number(nextConfig.context_length_limit || 0) !== Number(previousConfig.context_length_limit || 0)) {
      markRestartPending('context_length_limit changed');
    }
  }

  async function runSelfCheck() {
    if (activeTask) {
      return {
        success: false,
        status: 'busy',
        message: BUSY_MESSAGE,
        conclusion: 'Agent 子服务正在执行任务，自检已跳过；这不是 OpenCode 故障。',
        checked_at: nowIso(),
        duration_ms: 0,
        log_dir: '',
        log_file: '',
        runtime_root: serviceRuntimeRoot,
        workspace_dir: serviceWorkspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(serviceWorkspaceDir, SELF_CHECK_OUTPUT_FILE),
        opencode_binary_path: '',
        runtime_status: getStatus(),
        steps: [],
        detail_text: BUSY_MESSAGE,
      };
    }

    const checkedAt = nowIso();
    const startedAt = Date.now();
    const steps = [
      { id: 'runtime-status', label: '读取常驻 Agent 状态', status: 'running', updated_at: nowIso() },
      { id: 'agent-run', label: '执行常驻 Agent 自检任务', status: 'pending' },
      { id: 'output-check', label: '校验智能体输出', status: 'pending' },
    ];

    function updateStep(id, status, stepMessage) {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      step.status = status;
      step.message = stepMessage || '';
      step.updated_at = nowIso();
    }

    try {
      await ensureStarted();
      updateStep('runtime-status', 'success', '常驻 Agent 服务可用');
      updateStep('agent-run', 'running', '正在执行极简智能体任务');
      const agentResult = await runTask({
        task_id: SELF_CHECK_TASK_ID,
        title: '易标智能体自检',
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' }],
        prompt: buildSelfCheckPrompt(),
        timeout_ms: SELF_CHECK_TIMEOUT_MS,
        keep_runtime: true,
        internal_self_check: true,
      });
      updateStep('agent-run', 'success', `session_id=${agentResult?.session_id || '-'}`);
      updateStep('output-check', 'running', '正在校验输出内容');
      parseSelfCheckOutput(agentResult?.output_content || '');
      updateStep('output-check', 'success', '输出内容符合预期');

      const runtimeStatus = getStatus();
      const result = {
        success: true,
        status: 'normal',
        message: '智能体自检正常',
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: '',
        log_file: '',
        runtime_root: serviceRuntimeRoot,
        workspace_dir: agentResult?.workspace_dir || '',
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(agentResult?.workspace_dir || '', SELF_CHECK_OUTPUT_FILE),
        output_content: agentResult?.output_content || '',
        opencode_binary_path: '',
        opencode_request_log: agentResult?.opencode_request_log || [],
        proxy_diagnostics: { events: diagnostics.events.slice(-120) },
        workspace_snapshot: null,
        runtime_status: runtimeStatus,
        agent_result: {
          session_id: agentResult?.session_id || '',
          assistant_text_chars: String(agentResult?.assistant_text || '').length,
          diff_count: Array.isArray(agentResult?.diff) ? agentResult.diff.length : 0,
        },
        steps,
        diagnostics: { runtime_status: runtimeStatus },
      };
      result.conclusion = '结论：智能体自检通过，常驻 OpenCode Server、AI proxy 和文件输出链路均正常。';
      result.detail_text = `${result.conclusion}\n消息：${result.message}`;
      return result;
    } catch (error) {
      const runningStep = steps.find((step) => step.status === 'running');
      if (runningStep) updateStep(runningStep.id, 'error', error?.message || String(error));
      const runtimeStatus = getStatus();
      const result = {
        success: false,
        status: 'error',
        message: error?.message || '智能体自检失败',
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: '',
        log_file: '',
        runtime_root: serviceRuntimeRoot,
        workspace_dir: error?.agentWorkspaceDir || serviceWorkspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: error?.agentOutputPath || path.join(serviceWorkspaceDir, SELF_CHECK_OUTPUT_FILE),
        output_content: error?.agentPartialOutput || '',
        opencode_binary_path: '',
        opencode_request_log: error?.openCodeRequestLog || [],
        proxy_diagnostics: { events: diagnostics.events.slice(-120) },
        workspace_snapshot: null,
        runtime_status: runtimeStatus,
        steps,
        diagnostics: {
          name: error?.name || 'Error',
          message: error?.message || String(error),
          agent_task_id: error?.agentTaskId || '',
          agent_workspace_dir: error?.agentWorkspaceDir || '',
          agent_runtime_root: error?.agentRuntimeRoot || serviceRuntimeRoot,
          agent_output_file: error?.agentOutputFile || SELF_CHECK_OUTPUT_FILE,
          agent_output_path: error?.agentOutputPath || '',
          agent_partial_output: error?.agentPartialOutput || '',
          agent_partial_output_chars: error?.agentPartialOutputChars || 0,
          opencode_request_log: error?.openCodeRequestLog || [],
          opencode_stdout_tail: error?.openCodeStdoutTail || '',
          opencode_stderr_tail: error?.openCodeStderrTail || '',
          runtime_status: runtimeStatus,
        },
      };
      result.conclusion = `结论：智能体自检失败，问题位于常驻 Agent 链路：${result.message}`;
      result.detail_text = `${result.conclusion}\n消息：${result.message}`;
      result.error = result.diagnostics;
      return result;
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      setPhase('closing', '正在关闭 Agent 服务');
      stopIdleHealthTimer();
      stopStatusTimer();
      if (emitStatusTimer) {
        clearTimeout(emitStatusTimer);
        emitStatusTimer = null;
      }
      if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
        activeTaskAbortController.abort(new Error('Agent 服务正在关闭'));
      }
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      activeTask = null;
      activeTaskAbortController = null;
      await closeOpenCodeSidecar(sidecar);
      sidecar = null;
      try { cleanupStagingWorkspace(); } catch {}
      setPhase('stopped', 'Agent 服务已停止');
      healthy = false;
      emitStatus();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  startStatusTimer();

  return {
    warmup,
    runTask,
    runSelfCheck,
    getStatus,
    restart,
    markRestartPending,
    handleConfigChanged,
    onStatus,
    close,
  };
}

function createRuntimeDiagnostics(limit = 500) {
  const events = [];
  return {
    events,
    record(event, payload = {}) {
      events.push({ at: nowIso(), event, ...payload });
      if (events.length > limit) {
        events.splice(0, events.length - limit);
      }
    },
  };
}

module.exports = {
  createOpenCodeRuntimeService,
};
