const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const { createAgentOpenAiProxy } = require('../agent/agentOpenAiProxy.cjs');
const { trackAgentRuntime } = require('../agent/agentRuntimeAnalytics.cjs');
const { preparePiEnvironment } = require('./piEnvironment.cjs');
const { createPiSession, loadPiModules } = require('./piSessionFactory.cjs');
const {
  createPiDiagnosticSections,
  createPiSelfCheckSteps,
  runPiToolEnvironmentSelfCheck,
  validatePiSessionSnapshot,
} = require('./piSelfCheckService.cjs');

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const STATUS_TICK_MS = 1000;
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimeoutMs(value, fallback = DEFAULT_IDLE_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeMaxRetries(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_RETRIES, Math.floor(number))) : 1;
}

function safeTaskSegment(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || crypto.randomUUID();
}

// 限制任务输入和输出只能使用普通相对路径，并禁止覆盖 Pi 资源文件。
function safeRelativePath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = relative.toLowerCase();
  if (!relative || relative.includes('..')) throw new Error(`非法文件路径：${value}`);
  if (
    lower === 'agents.md'
    || lower === 'claude.md'
    || lower.startsWith('.pi/')
    || lower.startsWith('.agents/')
  ) {
    throw new Error(`Pi Agent 保留路径不允许作为任务文件：${value}`);
  }
  return relative;
}

function ensureInsideRoot(rootDir, targetPath, sourcePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`文件路径越界：${sourcePath}`);
  return target;
}

function clearDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  });
}

function writeWorkspaceFiles(workspaceDir, files = []) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  files.forEach((file) => {
    const relative = safeRelativePath(file.path);
    const target = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relative), file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(file.content || ''), 'utf-8');
  });
}

function readOutput(workspaceDir, outputFile) {
  const relative = safeRelativePath(outputFile);
  const target = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relative), outputFile);
  return { path: target, content: fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '' };
}

function createDefaultPrompt(task, outputFile) {
  return `请只在当前工作目录内工作。

任务：
${task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 将最终结果写入 ${outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复简要说明处理动作和输出文件。`;
}

function compactText(value, maxLength = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function extractAssistantText(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  if (!assistant) return '';
  return (Array.isArray(assistant.content) ? assistant.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
    .trim();
}

function getAssistantError(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return assistant?.stopReason === 'error' ? assistant.errorMessage || 'Pi Agent 模型请求失败' : '';
}

function buildRetryPrompt(outputFile, error, attempt, maxRetries) {
  return `上一轮执行未通过程序校验或执行失败：${compactText(error?.message || error, 800)}

请继续使用当前会话和工作区，只做必要修复，并将最终结果写入 ${outputFile}。
这是第 ${attempt}/${maxRetries} 次自动修复机会。`;
}

function createRetrySummary(attempt, error, outputContent) {
  return {
    attempt,
    at: nowIso(),
    error: compactText(error?.message || error, 600),
    output_chars: String(outputContent || '').length,
  };
}

function createRuntimeDiagnostics(limit = 500) {
  const events = [];
  return {
    events,
    record(event, payload = {}) {
      events.push({ at: nowIso(), event, ...payload });
      if (events.length > limit) events.splice(0, events.length - limit);
    },
  };
}

function createPiRuntimeService({ app, configStore, runtime }) {
  const runtimeId = runtime.id;
  const runtimeName = runtime.displayName;
  const environment = preparePiEnvironment(app, runtimeId);
  const { layout } = environment;
  const diagnostics = createRuntimeDiagnostics();
  const listeners = new Set();
  let phase = 'stopped';
  let healthy = false;
  let message = `${runtimeName} 未启动`;
  let updatedAt = nowIso();
  let lastHealthAt = '';
  let lastHealthError = '';
  let restartPending = false;
  let restartPendingReason = '';
  let proxy = null;
  let proxyInfo = null;
  let startPromise = null;
  let closePromise = null;
  let activeTask = null;
  let activeController = null;
  let statusTimer = null;
  let sdkVersion = '';

  function getActiveTaskSummary() {
    if (!activeTask) return null;
    const started = new Date(activeTask.started_at).getTime();
    const lastActivity = new Date(activeTask.last_activity_at).getTime();
    return {
      task_id: activeTask.task_id,
      title: activeTask.title,
      stage: activeTask.stage,
      progress_text: activeTask.progress_text,
      started_at: activeTask.started_at,
      last_activity_at: activeTask.last_activity_at,
      last_progress_at: activeTask.last_progress_at,
      elapsed_seconds: Math.max(0, Math.floor((Date.now() - started) / 1000)),
      idle_seconds: Math.max(0, Math.floor((Date.now() - lastActivity) / 1000)),
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
      queued_count: 0,
      queued_tasks: [],
      proxy: proxy?.getStatus?.() || { active: 0, queued: 0, limit: 0 },
      runtime_details: {
        sdk_version: sdkVersion,
        runtime_root: layout.runtimeRoot,
        workspace_dir: layout.workspaceDir,
      },
    };
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  function setPhase(nextPhase, nextMessage) {
    phase = nextPhase;
    healthy = ['starting', 'idle', 'running', 'restarting'].includes(nextPhase);
    message = nextMessage || message;
    updatedAt = nowIso();
    diagnostics.record('runtime.phase', { phase, message });
    emitStatus();
  }

  function touchActivity(event = {}) {
    if (!activeTask || event.task_token !== activeTask.task_token) return;
    const now = nowIso();
    if (event.activity !== false) activeTask.last_activity_at = now;
    if (event.visible !== false && event.message) {
      activeTask.stage = event.stage || activeTask.stage;
      activeTask.progress_text = event.message;
      activeTask.last_progress_at = now;
      message = event.message;
    }
    diagnostics.record(event.source || 'runtime.activity', event);
    try { activeTask.onActivity?.({ ...event, at: now }); } catch {}
    emitStatus();
  }

  // 加载 Pi SDK 并启动本地 AI Proxy。
  async function ensureStarted() {
    if (proxy && phase !== 'unhealthy' && phase !== 'stopped' && phase !== 'closing') return proxyInfo;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      setPhase(phase === 'unhealthy' ? 'restarting' : 'starting', `正在启动 ${runtimeName}`);
      const { codingAgent } = await loadPiModules();
      sdkVersion = codingAgent.VERSION || '';
      proxy = createAgentOpenAiProxy({
        app,
        configStore,
        runtime,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        diagnostics,
        onActivity: touchActivity,
        getActivityContext: () => activeTask ? { task_token: activeTask.task_token, task_id: activeTask.task_id } : null,
      });
      proxyInfo = await proxy.start();
      lastHealthAt = nowIso();
      lastHealthError = '';
      setPhase(activeTask ? 'running' : 'idle', activeTask ? `${runtimeName} 正在执行任务` : `${runtimeName} 空闲`);
      if (!statusTimer) statusTimer = setInterval(() => { if (activeTask) emitStatus(); }, STATUS_TICK_MS);
      return proxyInfo;
    })();
    try {
      return await startPromise;
    } catch (error) {
      lastHealthError = error?.message || String(error);
      try { await proxy?.close?.(); } catch {}
      proxy = null;
      proxyInfo = null;
      setPhase('unhealthy', `${runtimeName} 启动失败`);
      throw error;
    } finally {
      startPromise = null;
    }
  }

  function archiveWorkspace(taskId) {
    const taskDir = path.join(layout.tasksRoot, safeTaskSegment(taskId));
    const archivedWorkspace = path.join(taskDir, 'workspace');
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.cpSync(layout.workspaceDir, archivedWorkspace, { recursive: true });
    return { taskDir, archivedWorkspace };
  }

  function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  }

  function subscribeSession(session, taskToken, diffEntries) {
    let streamedText = '';
    return session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        streamedText += event.assistantMessageEvent.delta || '';
        touchActivity({
          task_token: taskToken,
          stage: 'assistant_text',
          message: compactText(streamedText.slice(-500), 200),
          source: 'pi.message',
          visible: true,
          activity: true,
        });
        return;
      }
      if (event.type === 'tool_execution_start') {
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `正在调用工具：${event.toolName}`,
          source: 'pi.tool.start',
          visible: true,
          activity: true,
          meta: { tool: event.toolName },
        });
        return;
      }
      if (event.type === 'tool_execution_update') {
        touchActivity({ task_token: taskToken, stage: 'tool', message: '', source: 'pi.tool.update', visible: false, activity: true });
        return;
      }
      if (event.type === 'tool_execution_end') {
        const details = event.result?.details || {};
        if (details.diff || details.patch) diffEntries.push({ tool: event.toolName, diff: details.diff || '', patch: details.patch || '' });
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `${event.toolName} ${event.isError ? '执行失败' : '执行完成'}`,
          source: 'pi.tool.end',
          visible: true,
          activity: true,
          meta: { tool: event.toolName, is_error: Boolean(event.isError) },
        });
        return;
      }
      if (['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_end', 'compaction_start', 'compaction_end'].includes(event.type)) {
        touchActivity({ task_token: taskToken, stage: event.type, message: '', source: `pi.${event.type}`, visible: false, activity: true });
      }
    });
  }

  function bindAbort(parentSignal, controller, getSession) {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(parentSignal?.reason || new Error('Agent 任务已取消'));
      void getSession()?.abort?.().catch(() => undefined);
    };
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener?.('abort', abort, { once: true });
    const sessionAbort = () => { void getSession()?.abort?.().catch(() => undefined); };
    controller.signal.addEventListener('abort', sessionAbort, { once: true });
    return () => {
      parentSignal?.removeEventListener?.('abort', abort);
      controller.signal.removeEventListener('abort', sessionAbort);
    };
  }

  function startWatchdog(controller, timeoutMs, taskToken) {
    return setInterval(() => {
      if (!activeTask) return;
      const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
      if (idleMs < timeoutMs || controller.signal.aborted) return;
      const error = new Error('Pi Agent 长时间无进展，已停止本轮任务');
      error.code = 'AGENT_STALLED';
      touchActivity({ task_token: taskToken, stage: 'stalled', message: error.message, source: 'pi.watchdog', visible: true, activity: false });
      controller.abort(error);
    }, 2000);
  }

  // 执行单个 Pi Agent 任务，并保持业务输出协议一致。
  async function runTask(payload = {}) {
    if (activeTask) throw new Error(`${runtimeName} 正在执行其他任务`);
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const timeoutMs = normalizeTimeoutMs(payload.timeout_ms);
    const maxRetries = normalizeMaxRetries(payload.max_retries);
    const retryAttempts = [];
    const taskToken = crypto.randomUUID();
    const startedAt = nowIso();
    activeTask = {
      task_id: taskId,
      title,
      stage: 'starting',
      progress_text: `正在启动 ${runtimeName}`,
      started_at: startedAt,
      last_activity_at: startedAt,
      last_progress_at: startedAt,
      task_token: taskToken,
      onActivity: payload.onActivity,
    };
    activeController = new AbortController();
    setPhase('running', activeTask.progress_text);
    let session = null;
    let sessionSnapshot = null;
    let unsubscribe = null;
    let archivedWorkspace = '';
    const diffEntries = [];
    const cleanupAbort = bindAbort(payload.signal, activeController, () => session);
    const watchdog = startWatchdog(activeController, timeoutMs, taskToken);

    try {
      await ensureStarted();
      clearDirectory(layout.workspaceDir);
      writeWorkspaceFiles(layout.workspaceDir, payload.files || []);
      const created = await createPiSession({
        workspaceDir: layout.workspaceDir,
        environment,
        proxyInfo,
        config: configStore.load(),
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
      session = created.session;
      sessionSnapshot = created.snapshot;
      unsubscribe = subscribeSession(session, taskToken, diffEntries);
      let prompt = payload.prompt || createDefaultPrompt(payload.task || '请分析当前输入文件并输出结果。', outputFile);
      let assistantText = '';
      let validationResult = null;
      let retryCount = 0;

      for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
        try {
          if (activeController.signal.aborted) throw activeController.signal.reason;
          await session.prompt(prompt, { expandPromptTemplates: false });
          if (activeController.signal.aborted) throw activeController.signal.reason;
          const assistantError = getAssistantError(session.messages);
          if (assistantError) throw new Error(assistantError);
          assistantText = extractAssistantText(session.messages);
          const output = readOutput(layout.workspaceDir, outputFile);
          const candidate = {
            success: true,
            runtime_id: runtimeId,
            task_id: taskId,
            title,
            output_file: outputFile,
            output_content: output.content,
            assistant_text: assistantText,
            session_id: session.sessionId,
            retry_count: attemptIndex,
            retry_attempts: [...retryAttempts],
          };
          if (typeof payload.validateOutput === 'function') {
            try {
              validationResult = await payload.validateOutput(candidate, {
                attempt: attemptIndex + 1,
                max_retries: maxRetries,
                task_id: taskId,
                title,
                output_file: outputFile,
                workspace_dir: layout.workspaceDir,
                session_id: session.sessionId,
                retry_attempts: [...retryAttempts],
              });
            } catch (validationError) {
              if (validationError && typeof validationError === 'object') {
                validationError.agentValidationFailed = true;
              }
              throw validationError;
            }
          }
          retryCount = attemptIndex;
          break;
        } catch (error) {
          if (activeController.signal.aborted || attemptIndex >= maxRetries) throw error;
          const output = readOutput(layout.workspaceDir, outputFile);
          retryAttempts.push(createRetrySummary(attemptIndex + 1, error, output.content));
          retryCount = retryAttempts.length;
          touchActivity({
            task_token: taskToken,
            stage: 'retry',
            message: `${runtimeName} 正在自动修复 ${retryCount}/${maxRetries}：${compactText(error?.message || error, 160)}`,
            source: 'pi.retry',
            visible: true,
            activity: true,
          });
          prompt = buildRetryPrompt(outputFile, error, retryCount, maxRetries);
        }
      }

      const output = readOutput(layout.workspaceDir, outputFile);
      const archive = archiveWorkspace(taskId);
      archivedWorkspace = archive.archivedWorkspace;
      const result = {
        success: true,
        runtime_id: runtimeId,
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspace,
        runtime_workspace_dir: layout.workspaceDir,
        runtime_root: layout.runtimeRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: assistantText,
        diff: diffEntries,
        session_id: session.sessionId,
        retry_count: retryCount,
        retry_attempts: retryAttempts,
        validation_result: validationResult,
        diagnostics: {
          session: sessionSnapshot,
          events: diagnostics.events.slice(-160),
        },
      };
      writeJson(path.join(archive.taskDir, 'result.json'), result);
      trackAgentRuntime(app, configStore, runtimeId, 'success', { retryCount });
      return result;
    } catch (error) {
      let output = { path: '', content: '' };
      try { output = readOutput(layout.workspaceDir, outputFile); } catch {}
      try { archivedWorkspace = archiveWorkspace(taskId).archivedWorkspace; } catch {}
      if (error && typeof error === 'object') {
        error.agentRuntimeId = runtimeId;
        error.agentTaskId = taskId;
        error.agentTitle = title;
        error.agentWorkspaceDir = archivedWorkspace || layout.workspaceDir;
        error.agentRuntimeRoot = layout.runtimeRoot;
        error.agentOutputFile = outputFile;
        error.agentOutputPath = archivedWorkspace ? path.join(archivedWorkspace, outputFile) : output.path;
        error.agentPartialOutput = output.content;
        error.agentPartialOutputChars = output.content.length;
        error.agentRetryAttempts = retryAttempts;
        error.agentDiagnostics = {
          session: sessionSnapshot,
          events: diagnostics.events.slice(-160),
        };
      }
      trackAgentRuntime(app, configStore, runtimeId, 'failed', { retryCount: retryAttempts.length });
      throw error;
    } finally {
      unsubscribe?.();
      session?.dispose?.();
      cleanupAbort();
      clearInterval(watchdog);
      activeTask = null;
      activeController = null;
      try { clearDirectory(layout.workspaceDir); } catch {}
      if (phase !== 'closing' && phase !== 'stopped') {
        if (restartPending) {
          await restart(restartPendingReason || 'config changed').catch((error) => {
            lastHealthError = error?.message || String(error);
            setPhase('unhealthy', `${runtimeName} 重启失败`);
          });
        } else {
          setPhase(proxy ? 'idle' : 'unhealthy', proxy ? `${runtimeName} 空闲` : `${runtimeName} 异常`);
        }
      }
    }
  }

  // 执行 Pi SDK、资源、工具、模型和输出文件的完整链路自检。
  async function runSelfCheck() {
    const checkedAt = nowIso();
    const startedAt = Date.now();
    const steps = createPiSelfCheckSteps();
    const logDir = getDeveloperLogsDir(app, `${runtimeId}-self-check`);
    const logFile = path.join(logDir, 'latest.json');
    let sessionSnapshot = {};
    let toolCheck = null;
    const setStep = (id, status, stepMessage) => {
      const step = steps.find((item) => item.id === id);
      if (step) Object.assign(step, { status, message: stepMessage, updated_at: nowIso() });
    };
    try {
      fs.mkdirSync(logDir, { recursive: true });
      setStep('sdk', 'running', '正在加载 Pi SDK');
      const { codingAgent } = await loadPiModules();
      sdkVersion = sdkVersion || codingAgent.VERSION || '';
      setStep('sdk', 'success', sdkVersion ? `Pi SDK ${sdkVersion}` : 'Pi SDK 已加载');

      setStep('runtime', 'running', `正在启动 ${runtimeName} AI Proxy`);
      await ensureStarted();
      setStep('runtime', 'success', layout.runtimeRoot);

      setStep('tools', 'running', '正在检查共享命令环境');
      toolCheck = runPiToolEnvironmentSelfCheck(environment);
      if (!toolCheck.success) throw new Error(`Pi 共享命令环境检查失败：${toolCheck.summary}`);
      setStep('tools', 'success', toolCheck.summary);

      setStep('agent', 'running', `正在执行 ${runtimeName} 自检任务`);
      const result = await runTask({
        task_id: `${runtimeId}-agent-self-check-latest`,
        title: `${runtimeName} 自检`,
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT' }],
        prompt: `请完成以下自检：
1. 使用 read 工具读取 self-check-input.txt。
2. 使用 bash 工具执行 node -e "console.log('YIBIAO_PI_NODE_OK')"。
3. 使用 write 工具将 JSON 写入 ${SELF_CHECK_OUTPUT_FILE}，格式为 {"message":"YIBIAO_PI_AGENT_SELF_CHECK_OK","input":"YIBIAO_PI_AGENT_SELF_CHECK_INPUT","node":"YIBIAO_PI_NODE_OK"}。
4. 不要访问当前工作区以外的文件。`,
        timeout_ms: 5 * 60 * 1000,
        max_retries: 0,
      });
      setStep('agent', 'success', `session_id=${result.session_id}`);
      sessionSnapshot = result.diagnostics?.session || {};
      const snapshotValidation = validatePiSessionSnapshot(sessionSnapshot);
      setStep('resources', snapshotValidation.resourcesValid ? 'success' : 'error', snapshotValidation.resourcesValid ? '仅加载易标内置工作区指令' : 'Pi 资源加载结果不符合配置');
      if (!snapshotValidation.resourcesValid) throw new Error('Pi Agent 加载了未授权资源');
      setStep('tools', snapshotValidation.toolsValid ? 'success' : 'error', snapshotValidation.toolsValid ? toolCheck.summary : 'Pi 工具注册结果不符合配置');
      if (!snapshotValidation.toolsValid) throw new Error('Pi Agent 工具注册结果不符合配置');

      setStep('output', 'running', '正在校验自检输出');
      const output = JSON.parse(result.output_content || '{}');
      if (
        output.message !== 'YIBIAO_PI_AGENT_SELF_CHECK_OK'
        || output.input !== 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT'
        || output.node !== 'YIBIAO_PI_NODE_OK'
      ) {
        throw new Error('Pi Agent 自检输出不符合预期');
      }
      setStep('output', 'success', '输出内容符合预期');
      const selfCheckResult = {
        success: true,
        status: 'normal',
        message: `${runtimeName} 自检正常`,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logDir,
        log_file: logFile,
        runtime_root: layout.runtimeRoot,
        workspace_dir: result.workspace_dir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(result.workspace_dir, SELF_CHECK_OUTPUT_FILE),
        output_content: result.output_content,
        conclusion: 'Pi SDK、资源加载、共享工具、当前文本模型和输出链路均正常。',
        steps,
        sections: createPiDiagnosticSections({ layout, sdkVersion, sessionSnapshot, toolCheck }),
        diagnostics: { ...result.diagnostics, tool_check: toolCheck },
        detail_text: JSON.stringify({ sdk_version: sdkVersion, session: sessionSnapshot, tool_check: toolCheck, runtime_status: getStatus() }, null, 2),
        runtime_status: getStatus(),
      };
      writeJson(logFile, selfCheckResult);
      return selfCheckResult;
    } catch (error) {
      sessionSnapshot = Object.keys(sessionSnapshot).length
        ? sessionSnapshot
        : error?.agentDiagnostics?.session || {};
      const current = steps.find((step) => step.status === 'running')
        || (!steps.some((step) => step.status === 'error') ? steps.find((step) => step.status === 'pending') : null);
      if (current) setStep(current.id, 'error', error?.message || String(error));
      const result = {
        success: false,
        status: 'error',
        message: error?.message || `${runtimeName} 自检失败`,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logDir,
        log_file: logFile,
        runtime_root: layout.runtimeRoot,
        workspace_dir: layout.workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(layout.workspaceDir, SELF_CHECK_OUTPUT_FILE),
        steps,
        sections: createPiDiagnosticSections({ layout, sdkVersion, sessionSnapshot, toolCheck }),
        diagnostics: {
          ...(error?.agentDiagnostics || {}),
          message: error?.message || String(error),
          stack: error?.stack || '',
          tool_check: toolCheck,
        },
        error: { message: error?.message || String(error) },
        detail_text: error?.stack || error?.message || String(error),
        runtime_status: getStatus(),
      };
      try { writeJson(logFile, result); } catch {}
      return result;
    }
  }

  async function warmup() {
    await ensureStarted();
    return getStatus();
  }

  async function restart(reason = 'manual') {
    if (activeTask) {
      restartPending = true;
      restartPendingReason = reason;
      emitStatus();
      return getStatus();
    }
    restartPending = false;
    restartPendingReason = '';
    setPhase('restarting', `正在重启 ${runtimeName}`);
    await proxy?.close?.();
    proxy = null;
    proxyInfo = null;
    await ensureStarted();
    return getStatus();
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    if (Number(nextConfig.context_length_limit || 0) !== Number(previousConfig.context_length_limit || 0)) {
      if (activeTask) {
        restartPending = true;
        restartPendingReason = 'context_length_limit changed';
        emitStatus();
      } else if (proxy) {
        void restart('context_length_limit changed').catch((error) => {
          lastHealthError = error?.message || String(error);
          setPhase('unhealthy', `${runtimeName} 重启失败`);
        });
      }
    }
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      setPhase('closing', `正在关闭 ${runtimeName}`);
      if (activeController && !activeController.signal.aborted) activeController.abort(new Error('Agent 服务正在关闭'));
      if (startPromise) await startPromise.catch(() => undefined);
      await proxy?.close?.();
      proxy = null;
      proxyInfo = null;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      setPhase('stopped', `${runtimeName} 已停止`);
      healthy = false;
    })().finally(() => { closePromise = null; });
    return closePromise;
  }

  return {
    warmup,
    runTask,
    runSelfCheck,
    getStatus,
    restart,
    handleConfigChanged,
    onStatus,
    close,
  };
}

module.exports = {
  createPiRuntimeService,
};
