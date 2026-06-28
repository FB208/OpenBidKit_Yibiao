const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgentRuntimeDir, getBundledOpencodeBinaryPath } = require('../../utils/paths.cjs');
const { startOpenCodeSidecar, closeOpenCodeSidecar } = require('./opencodeServerRunner.cjs');
const { runOpenCodeTask } = require('./opencodeHttpClient.cjs');
const {
  SELF_CHECK_TASK_ID,
  SELF_CHECK_OUTPUT_FILE,
  SELF_CHECK_TIMEOUT_MS,
  buildSelfCheckPrompt,
  compactSelfCheckError,
  createEnvironmentSnapshot,
  createSelfCheckConclusion,
  createSelfCheckLogger,
  createSelfCheckSteps,
  formatSelfCheckDetails,
  getCurrentSelfCheckStage,
  runDirectModelSelfCheck,
  safeStat,
  snapshotWorkspace,
  summarizeTextModelConfig,
  updateSelfCheckStep,
  validateSelfCheckOutput,
} = require('./opencodeSelfCheckService.cjs');

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_INTERVAL_MS = 30 * 1000;
const HEALTH_FAILURE_LIMIT = 3;
const STATUS_TICK_MS = 1000;
const WORKSPACE_WATCH_INTERVAL_MS = 2000;
const BUSY_MESSAGE = 'Agent 正在处理其他任务，请耐心等待';
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimeoutMs(value, fallback = DEFAULT_AGENT_IDLE_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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

function createSelfCheckStageError(stage, message) {
  const error = new Error(message);
  error.selfCheckStage = stage;
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
    if (typeof activeTask.activity_handler === 'function') {
      try {
        activeTask.activity_handler({ ...event, at: now });
      } catch (error) {
        appendRuntimeEvent({ at: nowIso(), source: 'task-activity-handler', message: error?.message || String(error) });
      }
    }
    emitStatusThrottled();
  }

  function createTaskActivity(taskRef) {
    const taskToken = taskRef.activity_token;
    return (event = {}) => touchActivity({ ...event, task_token: taskToken });
  }

  function createActiveTask({ taskId, title, timeoutMs, onActivity }) {
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
      activity_handler: typeof onActivity === 'function' ? onActivity : null,
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
        onStage: (stage, status, stageMessage, meta = {}) => {
          if (!activeTask) {
            appendRuntimeEvent({
              at: nowIso(),
              source: 'opencode-start',
              stage,
              message: stageMessage,
              meta: { ...meta, status },
              ignored: true,
              reason: 'no-active-task',
            });
            return;
          }

          touchActivity({
            task_token: activeTask.activity_token,
            task_id: activeTask.task_id,
            stage,
            message: stageMessage,
            source: 'opencode-start',
            meta: { ...meta, status },
          });
        },
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

    activeTask = createActiveTask({ taskId, title, timeoutMs, onActivity: payload.onActivity });
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
      const busyResult = {
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
        detail_text: '',
      };
      busyResult.detail_text = formatSelfCheckDetails(busyResult);
      return busyResult;
    }

    const checkedAt = nowIso();
    const startedAt = Date.now();
    const steps = createSelfCheckSteps();
    const logger = createSelfCheckLogger(app);
    let opencodeBinaryPath = '';
    let config = null;
    let modelConfig = null;
    let environment = null;
    let directModelTest = null;
    let agentResult = null;
    let workspaceSnapshot = null;
    let agentTaskStarted = false;

    function setStep(id, status, stepMessage, meta = {}) {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      if (step.status === 'error' && status !== 'error') return;
      if (step.status === 'success' && status === 'running') return;
      updateSelfCheckStep(steps, id, status, stepMessage);
      logger.write('step', { id, status, message: stepMessage || '', ...meta });
    }

    function completeStep(id, stepMessage) {
      const step = steps.find((item) => item.id === id);
      if (!step || step.status === 'success' || step.status === 'error') return;
      setStep(id, 'success', stepMessage);
    }

    function completeRuntimeSteps() {
      if (!sidecar) return;
      completeStep('ai-proxy-start', sidecar.aiProxyBaseUrl || '常驻 OpenCode AI proxy 可用');
      completeStep('opencode-config-write', path.join(serviceRuntimeRoot, 'opencode.json'));
      completeStep('opencode-server-start', sidecar.baseUrl || '常驻 OpenCode Server 可用');
      completeStep('opencode-health', sidecar.baseUrl || '常驻 OpenCode Server 健康检查通过');
    }

    function inferActivityStatus(event, successPattern) {
      const status = event?.meta?.status;
      if (status === 'success' || status === 'error' || status === 'running') return status;
      return successPattern.test(String(event?.message || '')) ? 'success' : 'running';
    }

    function handleInternalActivity(event = {}) {
      logger.write('activity', event);
      const stage = String(event.stage || '');
      const messageText = String(event.message || '');
      const route = String(event.meta?.route || '');

      if (['ai-proxy-start', 'opencode-config-write', 'opencode-server-start', 'opencode-health'].includes(stage)) {
        setStep(stage, inferActivityStatus(event, /成功|完成|可用|通过/), messageText);
        return;
      }

      if (stage === 'session') {
        setStep('session-create', inferActivityStatus(event, /已创建|完成/), messageText);
        return;
      }

      if (stage === 'message') {
        setStep('message-wait', inferActivityStatus(event, /完成/), messageText);
        return;
      }

      if (stage === 'output' && route.includes('/diff')) {
        const nextStatus = inferActivityStatus(event, /已读取|完成/);
        if (nextStatus !== 'error') setStep('diff-fetch', nextStatus, messageText);
        return;
      }

      if (stage === 'tool' || event.source === 'workspace.output') {
        setStep('message-wait', 'running', messageText || 'Agent 正在写入输出文件');
      }
    }

    function failCurrentStep(error) {
      const existingError = steps.find((step) => step.status === 'error');
      if (existingError) {
        if (error && typeof error === 'object' && !error.selfCheckStage) error.selfCheckStage = existingError.id;
        return;
      }
      const currentStage = error?.selfCheckStage && steps.some((step) => step.id === error.selfCheckStage)
        ? error.selfCheckStage
        : getCurrentSelfCheckStage(steps);
      const stageId = steps.some((step) => step.id === currentStage) ? currentStage : 'message-wait';
      if (error && typeof error === 'object' && !error.selfCheckStage) error.selfCheckStage = stageId;
      setStep(stageId, 'error', error?.message || String(error || '智能体自检失败'));
    }

    function createBaseResult({ success, status, resultMessage, error }) {
      const runtimeStatus = getStatus();
      const diagnosticsPayload = error ? compactSelfCheckError(error) : {
        opencode_binary_path: opencodeBinaryPath,
        opencode_base_url: sidecar?.baseUrl || '',
        opencode_port: sidecar?.port || 0,
        opencode_exit_code: lastExitCode,
        opencode_exit_signal: lastExitSignal,
        opencode_stdout_tail: sidecar?.getStdoutTail?.(8000) || '',
        opencode_stderr_tail: sidecar?.getStderrTail?.(8000) || '',
        opencode_request_log: agentResult?.opencode_request_log || sidecar?.requestLog || [],
      };
      diagnosticsPayload.opencode_binary_path = diagnosticsPayload.opencode_binary_path || opencodeBinaryPath;
      diagnosticsPayload.opencode_base_url = diagnosticsPayload.opencode_base_url || sidecar?.baseUrl || '';
      diagnosticsPayload.opencode_port = diagnosticsPayload.opencode_port || sidecar?.port || 0;
      diagnosticsPayload.opencode_exit_code = diagnosticsPayload.opencode_exit_code ?? lastExitCode;
      diagnosticsPayload.opencode_exit_signal = diagnosticsPayload.opencode_exit_signal || lastExitSignal;
      diagnosticsPayload.opencode_stdout_tail = diagnosticsPayload.opencode_stdout_tail || sidecar?.getStdoutTail?.(8000) || agentResult?.opencode_stdout_tail || '';
      diagnosticsPayload.opencode_stderr_tail = diagnosticsPayload.opencode_stderr_tail || sidecar?.getStderrTail?.(8000) || agentResult?.opencode_stderr_tail || '';
      if (!diagnosticsPayload.opencode_request_log?.length) {
        diagnosticsPayload.opencode_request_log = agentResult?.opencode_request_log || sidecar?.requestLog || [];
      }
      diagnosticsPayload.runtime_status = runtimeStatus;

      const workspaceDir = agentResult?.workspace_dir || error?.agentWorkspaceDir || serviceWorkspaceDir;
      const outputPath = agentResult?.workspace_dir
        ? path.join(agentResult.workspace_dir, SELF_CHECK_OUTPUT_FILE)
        : error?.agentOutputPath || path.join(serviceWorkspaceDir, SELF_CHECK_OUTPUT_FILE);
      return {
        success,
        status,
        message: resultMessage,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logger.logDir,
        log_file: logger.logFile,
        runtime_root: serviceRuntimeRoot,
        workspace_dir: workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: outputPath,
        output_content: agentResult?.output_content || error?.agentPartialOutput || '',
        opencode_binary_path: opencodeBinaryPath,
        model_config: modelConfig,
        environment,
        direct_model_test: directModelTest,
        opencode_request_log: agentResult?.opencode_request_log || diagnosticsPayload.opencode_request_log || [],
        proxy_diagnostics: { events: diagnostics.events.slice(-200) },
        workspace_snapshot: workspaceSnapshot,
        runtime_status: runtimeStatus,
        agent_result: agentResult ? {
          session_id: agentResult.session_id || '',
          assistant_text_chars: String(agentResult.assistant_text || '').length,
          diff_count: Array.isArray(agentResult.diff) ? agentResult.diff.length : 0,
        } : null,
        steps,
        diagnostics: diagnosticsPayload,
        error: error ? diagnosticsPayload : undefined,
        detail_text: '',
      };
    }

    try {
      opencodeBinaryPath = getBundledOpencodeBinaryPath(app);
      config = configStore.load();
      modelConfig = summarizeTextModelConfig(config);

      setStep('prepare', 'running', '正在清理上一轮自检日志和旧归档');
      if (logger.getSetupError()) {
        throw createSelfCheckStageError('prepare', `自检日志目录不可写：${logger.getSetupError()}`);
      }
      ensureRuntimeDirs();
      fs.rmSync(path.join(tasksRoot, safeTaskPathSegment(SELF_CHECK_TASK_ID)), { recursive: true, force: true });
      setStep('prepare', 'success', '自检日志和旧归档已清理');

      setStep('environment-snapshot', 'running', '正在采集本机环境和模型配置摘要');
      environment = createEnvironmentSnapshot(app, opencodeBinaryPath, config);
      setStep('environment-snapshot', 'success', '环境快照已采集');

      setStep('binary-check', 'running', '正在检查 OpenCode 程序文件');
      const binaryStat = safeStat(opencodeBinaryPath);
      if (!binaryStat?.exists || !binaryStat.is_file) {
        throw createSelfCheckStageError('binary-check', `OpenCode binary 不存在或不可访问：${opencodeBinaryPath}`);
      }
      setStep('binary-check', 'success', `size=${binaryStat.size}`);

      setStep('runtime-write-check', 'running', '正在检查常驻运行目录写入能力');
      fs.mkdirSync(serviceRuntimeRoot, { recursive: true });
      fs.mkdirSync(serviceWorkspaceDir, { recursive: true });
      const writeCheckPath = path.join(serviceRuntimeRoot, `.self-check-write-${Date.now()}.tmp`);
      fs.writeFileSync(writeCheckPath, 'ok', 'utf-8');
      fs.rmSync(writeCheckPath, { force: true });
      setStep('runtime-write-check', 'success', '运行目录可写');

      setStep('direct-model-test', 'running', '正在直接请求当前文本模型');
      directModelTest = await runDirectModelSelfCheck(config);
      if (!directModelTest.success) {
        throw createSelfCheckStageError('direct-model-test', directModelTest.message || '直接模型测试失败');
      }
      setStep('direct-model-test', 'success', directModelTest.message || '直接模型测试成功');

      setStep('ai-proxy-start', 'running', '正在确认常驻 OpenCode AI proxy');
      agentTaskStarted = true;
      agentResult = await runTask({
        task_id: SELF_CHECK_TASK_ID,
        title: '易标智能体自检',
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' }],
        prompt: buildSelfCheckPrompt(),
        timeout_ms: SELF_CHECK_TIMEOUT_MS,
        onActivity: handleInternalActivity,
      });

      if (agentResult?.status === 'busy') {
        const busyResult = createBaseResult({ success: false, status: 'busy', resultMessage: BUSY_MESSAGE });
        busyResult.conclusion = 'Agent 子服务正在执行任务，自检已跳过；这不是 OpenCode 故障。';
        busyResult.detail_text = formatSelfCheckDetails(busyResult);
        logger.write('result', busyResult);
        return busyResult;
      }

      completeRuntimeSteps();
      completeStep('session-create', `session_id=${agentResult?.session_id || '-'}`);
      completeStep('message-wait', 'Agent 任务执行完成');
      completeStep('diff-fetch', `diff_count=${Array.isArray(agentResult?.diff) ? agentResult.diff.length : 0}`);

      setStep('output-check', 'running', '正在校验输出内容');
      validateSelfCheckOutput(agentResult?.output_content || '');
      setStep('output-check', 'success', '输出内容符合预期');

      setStep('workspace-snapshot', 'running', '正在采集自检工作目录快照');
      workspaceSnapshot = snapshotWorkspace(agentResult?.workspace_dir || serviceWorkspaceDir);
      setStep('workspace-snapshot', 'success', `files=${workspaceSnapshot?.files?.length || 0}`);

      const result = createBaseResult({ success: true, status: 'normal', resultMessage: '智能体自检正常' });
      result.conclusion = createSelfCheckConclusion(result);
      result.detail_text = formatSelfCheckDetails(result);
      logger.write('result', result);
      return result;
    } catch (error) {
      if (agentTaskStarted) completeRuntimeSteps();
      failCurrentStep(error);
      const workspaceRoot = agentResult?.workspace_dir || error?.agentWorkspaceDir || serviceWorkspaceDir;
      workspaceSnapshot = snapshotWorkspace(workspaceRoot);
      const result = createBaseResult({
        success: false,
        status: 'error',
        resultMessage: error?.message || '智能体自检失败',
        error,
      });
      result.conclusion = createSelfCheckConclusion(result);
      result.detail_text = formatSelfCheckDetails(result);
      logger.write('result', result);
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
