const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog } = require('electron');
const { createPiRuntimeService } = require('./pi/piRuntimeService.cjs');
const { buildPiSelfCheckReportMarkdown } = require('./pi/piSelfCheckService.cjs');
const { createAgentErrorReporter } = require('./agent/agentErrorReporter.cjs');
const { resolveAgentAbortReason } = require('./agent/agentInterruption.cjs');
const {
  createPersistentAgentTask,
  deletePersistentAgentTask,
  getPersistentAgentSessionPath,
  loadPersistentAgentTask,
  updatePersistentAgentTask,
} = require('./pi/piPersistentTaskStore.cjs');
const { loadPiModules } = require('./pi/piSessionFactory.cjs');
const {
  clearPrimaryAgentSession,
  loadPrimaryAgentSession,
  savePrimaryAgentSession,
} = require('./pi/piPrimarySessionStore.cjs');

const PI_RUNTIME_ID = 'pi';
const PI_RUNTIME_NAME = 'Pi Agent';

function nowIso() {
  return new Date().toISOString();
}

function createAgentDisconnectedError() {
  const error = new Error('Agent 服务正在关闭');
  error.code = 'AGENT_DISCONNECTED';
  return error;
}

function safeText(value) {
  return String(value || '').trim();
}

function formatTimestampForFilename(value) {
  const date = value ? new Date(value) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return valid.toISOString().replace(/[:.]/g, '-');
}

function sanitizeReportFilename(value) {
  return String(value || '智能体自检报告').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '智能体自检报告';
}

function createStoppedStatus() {
  return {
    runtime_id: PI_RUNTIME_ID,
    runtime_name: PI_RUNTIME_NAME,
    phase: 'stopped',
    healthy: false,
    message: `${PI_RUNTIME_NAME} 未启动`,
    updated_at: nowIso(),
    active_tasks: [],
    primary_session_id: '',
    queued_count: 0,
    queued_tasks: [],
    proxy: { active: 0, queued: 0, limit: 0 },
    runtime_details: {},
  };
}

function normalizeRuntimeStatus(rawStatus = {}) {
  const runtimeDetails = rawStatus.runtime_details && typeof rawStatus.runtime_details === 'object'
    ? rawStatus.runtime_details
    : {};
  return {
    runtime_id: PI_RUNTIME_ID,
    runtime_name: PI_RUNTIME_NAME,
    phase: rawStatus.phase || 'stopped',
    healthy: Boolean(rawStatus.healthy),
    message: rawStatus.message || `${PI_RUNTIME_NAME} 未启动`,
    updated_at: rawStatus.updated_at || nowIso(),
    last_health_at: rawStatus.last_health_at || '',
    last_health_error: rawStatus.last_health_error || '',
    restart_pending: Boolean(rawStatus.restart_pending),
    restart_pending_reason: rawStatus.restart_pending_reason || '',
    active_task: rawStatus.active_task || null,
    queued_count: Number(rawStatus.queued_count || 0),
    queued_tasks: Array.isArray(rawStatus.queued_tasks) ? rawStatus.queued_tasks : [],
    proxy: rawStatus.proxy || { active: 0, queued: 0, limit: 0 },
    runtime_details: runtimeDetails,
  };
}

function normalizeRunResult(rawResult = {}) {
  return {
    ...rawResult,
    runtime_id: PI_RUNTIME_ID,
    diagnostics: rawResult.diagnostics && typeof rawResult.diagnostics === 'object'
      ? { ...rawResult.diagnostics }
      : {},
  };
}

function normalizeRunError(error) {
  if (!error || typeof error !== 'object') return error;
  error.agentRuntimeId = PI_RUNTIME_ID;
  error.agentDiagnostics = error.agentDiagnostics && typeof error.agentDiagnostics === 'object'
    ? { ...error.agentDiagnostics }
    : {};
  return error;
}

// 读取后台父任务提供的最新诊断上下文，采集失败不影响原始异常上报。
function resolveUserTaskContext(provider) {
  if (typeof provider !== 'function') return provider && typeof provider === 'object' ? provider : null;
  try {
    const context = provider();
    return context && typeof context === 'object' ? context : null;
  } catch (error) {
    return { capture_error: error?.message || String(error) };
  }
}

function normalizeSelfCheckResult(rawResult = {}) {
  return {
    ...rawResult,
    success: Boolean(rawResult.success),
    runtime_id: PI_RUNTIME_ID,
    runtime_name: PI_RUNTIME_NAME,
    status: rawResult.status || (rawResult.success ? 'normal' : 'error'),
    message: rawResult.message || (rawResult.success ? '智能体自检正常' : '智能体自检失败'),
    checked_at: rawResult.checked_at || nowIso(),
    duration_ms: Number(rawResult.duration_ms || 0),
    log_dir: rawResult.log_dir || '',
    log_file: rawResult.log_file || '',
    runtime_root: rawResult.runtime_root || '',
    workspace_dir: rawResult.workspace_dir || '',
    output_file: rawResult.output_file || '',
    output_path: rawResult.output_path || '',
    output_content: rawResult.output_content || '',
    conclusion: rawResult.conclusion || '',
    steps: Array.isArray(rawResult.steps) ? rawResult.steps : [],
    sections: Array.isArray(rawResult.sections) ? rawResult.sections : [],
    diagnostics: rawResult.diagnostics || {},
    error: rawResult.error || undefined,
    detail_text: rawResult.detail_text || '',
    runtime_status: rawResult.runtime_status
      ? normalizeRuntimeStatus(rawResult.runtime_status)
      : undefined,
  };
}

// 协调共享 Pi 运行基础设施，并为每个 Agent 任务创建独立 Runtime/Session。
function createAgentService({ app, configStore, aiService, licenseService, autoConfirmationService }) {
  const agentErrorReporter = createAgentErrorReporter({ app, configStore, licenseService });
  const listeners = new Set();
  const monitorListeners = new Set();
  const questionListeners = new Set();
  const primarySessionListeners = new Set();
  const activeEntries = new Map();
  let serviceRuntime = null;
  let serviceRuntimeUnsubscribe = null;
  let closing = false;
  let monitorSequence = 0;
  let monitorFlushTimer = null;
  const pendingQuestions = new Map();
  let visibleQuestionId = '';
  let latestPrimaryRequestSequence = 0;
  let primarySession = loadPrimaryAgentSession(app);
  if (primarySession) {
    try {
      const persistentTask = primarySession.task_key
        ? loadPersistentAgentTask(app, primarySession.task_key)
        : null;
      const sessionFile = persistentTask?.state?.session_file;
      if (!sessionFile || !fs.existsSync(getPersistentAgentSessionPath(app, primarySession.task_key, sessionFile))) {
        primarySession = null;
        clearPrimaryAgentSession(app);
      }
    } catch {
      primarySession = null;
      clearPrimaryAgentSession(app);
    }
  }
  const pendingAssistantDeltas = new Map();
  const pendingToolUpdates = new Map();

  function clearPendingMonitorEvents() {
    if (monitorFlushTimer) clearTimeout(monitorFlushTimer);
    monitorFlushTimer = null;
    pendingAssistantDeltas.clear();
    pendingToolUpdates.clear();
  }

  function dispatchMonitorEvent(event = {}) {
    if (!monitorListeners.size) return;
    const normalized = {
      ...event,
      sequence: ++monitorSequence,
      at: event.at || nowIso(),
    };
    monitorListeners.forEach((listener) => {
      try { listener(normalized); } catch {}
    });
  }

  function flushPendingMonitorEvents() {
    if (monitorFlushTimer) clearTimeout(monitorFlushTimer);
    monitorFlushTimer = null;
    if (!monitorListeners.size) {
      clearPendingMonitorEvents();
      return;
    }
    pendingAssistantDeltas.forEach((event) => dispatchMonitorEvent(event));
    pendingAssistantDeltas.clear();
    pendingToolUpdates.forEach((event) => dispatchMonitorEvent(event));
    pendingToolUpdates.clear();
  }

  function scheduleMonitorFlush() {
    if (!monitorFlushTimer) {
      monitorFlushTimer = setTimeout(flushPendingMonitorEvents, 50);
    }
  }

  // 监视器未打开时不序列化、不缓存，只保留一次空监听判断。
  function emitMonitorEvent(event = {}) {
    if (!monitorListeners.size) return;
    const normalizedEvent = {
      ...event,
      is_primary: isPrimarySession(event),
    };
    event = normalizedEvent;
    if (event.type === 'assistant_delta') {
      const key = `${event.task_id || 'active'}:${event.session_id || 'session'}`;
      const previous = pendingAssistantDeltas.get(key);
      pendingAssistantDeltas.set(key, {
        ...event,
        delta: `${previous?.delta || ''}${event.delta || ''}`,
      });
      scheduleMonitorFlush();
      return;
    }
    if (event.type === 'tool_update') {
      const key = `${event.task_id || 'active'}:${event.session_id || 'session'}:${event.tool_call_id || event.tool_name || 'tool'}`;
      pendingToolUpdates.set(key, event);
      scheduleMonitorFlush();
      return;
    }
    flushPendingMonitorEvents();
    dispatchMonitorEvent(event);
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  function getVisibleQuestionEntry() {
    if (visibleQuestionId && pendingQuestions.has(visibleQuestionId)) {
      return pendingQuestions.get(visibleQuestionId);
    }
    const next = [...pendingQuestions.values()]
      .sort((left, right) => String(left.question.asked_at).localeCompare(String(right.question.asked_at)))[0] || null;
    visibleQuestionId = next?.question.question_id || '';
    return next;
  }

  function getPendingQuestion() {
    return getVisibleQuestionEntry()?.question || null;
  }

  function getPendingQuestions() {
    return [...pendingQuestions.values()]
      .map((entry) => entry.question)
      .sort((left, right) => String(left.asked_at).localeCompare(String(right.asked_at)));
  }

  function emitQuestionState() {
    const question = getPendingQuestion();
    questionListeners.forEach((listener) => {
      try { listener(question); } catch {}
    });
  }

  function clearPendingQuestion(entry) {
    if (!entry || !pendingQuestions.has(entry.question.question_id)) return;
    autoConfirmationService.unregister(entry.autoConfirmationId);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    pendingQuestions.delete(entry.question.question_id);
    if (visibleQuestionId === entry.question.question_id) visibleQuestionId = '';
    emitQuestionState();
    emitStatus();
  }

  function rejectPendingQuestions(error) {
    const entries = [...pendingQuestions.values()];
    for (const entry of entries) {
      clearPendingQuestion(entry);
      entry.reject(error);
    }
  }

  // 建立一次 Agent 到用户的提问，并在收到答案前保持工具调用等待。
  function requestUserQuestion(request = {}, signal) {
    if (closing) return Promise.reject(new Error('Agent 服务正在关闭'));
    if (signal?.aborted) return Promise.reject(createAbortError(signal));

    const questionId = crypto.randomUUID();
    const sourceOptions = Array.isArray(request.options) ? request.options : [];
    const options = sourceOptions.map((option, index) => ({
      id: `option-${index + 1}`,
      label: safeText(option?.label),
      description: safeText(option?.description),
      recommended: index === 0,
      custom: option?.custom === true,
    }));
    const question = {
      question_id: questionId,
      task_id: safeText(request.task_id),
      session_id: safeText(request.session_id),
      task_title: safeText(request.task_title) || '易标智能体任务',
      question: safeText(request.question),
      options,
      asked_at: nowIso(),
      is_primary: isPrimarySession(request),
    };

    return new Promise((resolve, reject) => {
      const entry = {
        question,
        resolve,
        reject,
        signal,
        onAbort: null,
        autoConfirmationId: `agent-question:${questionId}`,
      };
      entry.onAbort = () => {
        if (!pendingQuestions.has(questionId)) return;
        clearPendingQuestion(entry);
        reject(createAbortError(signal));
      };
      pendingQuestions.set(questionId, entry);
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      const recommendedOption = question.options.find((option) => option.recommended && !option.custom);
      if (recommendedOption) {
        autoConfirmationService.register({
          id: entry.autoConfirmationId,
          submit: () => answerQuestion({
            question_id: question.question_id,
            option_id: recommendedOption.id,
          }),
          onStateChange: ({ auto_answer_at: autoAnswerAt }) => {
            if (!pendingQuestions.has(questionId)) return;
            if (autoAnswerAt) entry.question.auto_answer_at = autoAnswerAt;
            else delete entry.question.auto_answer_at;
            emitQuestionState();
          },
        });
      }
      emitQuestionState();
      emitStatus();
    });
  }

  // 用户切换选项后停止当前 Agent 问题的自动回答计时。
  function suppressQuestionAutoAnswer(payload = {}) {
    const entry = pendingQuestions.get(payload.question_id);
    if (!entry) return { success: true };
    autoConfirmationService.suppress(entry.autoConfirmationId);
    return { success: true };
  }

  // 提交用户选择并恢复正在等待的 Agent 工具调用。
  function answerQuestion(payload = {}) {
    const entry = pendingQuestions.get(payload.question_id);
    if (!entry) {
      throw new Error('当前 Agent 问题已失效');
    }
    const option = entry.question.options.find((item) => item.id === payload.option_id);
    if (!option) throw new Error('请选择一个有效选项');
    const answer = option.custom ? safeText(payload.custom_answer) : option.label;
    if (!answer) throw new Error('请输入具体要求');
    const result = {
      answer,
      selected_option: option.label,
      is_custom: option.custom,
    };
    clearPendingQuestion(entry);
    entry.resolve(result);
    return { success: true };
  }

  function ensureServiceRuntime() {
    if (serviceRuntime) return serviceRuntime;
    serviceRuntime = createPiRuntimeService({
      app,
      configStore,
      aiService,
      isMonitorActive: () => monitorListeners.size > 0,
      onMonitorEvent: emitMonitorEvent,
      requestUserQuestion,
    });
    serviceRuntimeUnsubscribe = serviceRuntime.onStatus?.(() => emitStatus()) || null;
    return serviceRuntime;
  }

  function createTaskRuntime(entry) {
    const taskRuntime = createPiRuntimeService({
      app,
      configStore,
      aiService,
      isMonitorActive: () => monitorListeners.size > 0,
      onMonitorEvent: emitMonitorEvent,
      requestUserQuestion,
    });
    entry.runtimeUnsubscribe = taskRuntime.onStatus?.(() => emitStatus()) || null;
    return taskRuntime;
  }

  function getServiceRuntimeStatus() {
    return serviceRuntime ? normalizeRuntimeStatus(serviceRuntime.getStatus()) : createStoppedStatus();
  }

  function getPrimarySession() {
    return primarySession ? { ...primarySession } : null;
  }

  function isPrimarySession(value = {}) {
    if (!primarySession) return false;
    const taskId = safeText(value.task_id || value.taskId);
    const sessionId = safeText(value.session_id || value.sessionId);
    const taskKey = safeText(value.task_key || value.taskKey || value.persistent_task?.task_key);
    if (sessionId && primarySession.session_id) return sessionId === primarySession.session_id;
    if (taskId && primarySession.task_id) return taskId === primarySession.task_id;
    return Boolean(taskKey && primarySession.task_key && taskKey === primarySession.task_key);
  }

  function emitPrimarySessionChanged() {
    const value = getPrimarySession();
    primarySessionListeners.forEach((listener) => {
      try { listener(value); } catch {}
    });
    emitMonitorEvent({
      type: 'primary_session_changed',
      task_id: value?.task_id || '',
      session_id: value?.session_id || '',
      task_key: value?.task_key || '',
      title: '主 Session 已变更',
    });
    emitStatus();
  }

  function setPrimarySession(value = {}) {
    primarySession = savePrimaryAgentSession(app, value);
    emitPrimarySessionChanged();
    return getPrimarySession();
  }

  function clearPrimarySessionIfMatches(value = {}) {
    if (!isPrimarySession(value)) return false;
    primarySession = null;
    clearPrimaryAgentSession(app);
    emitPrimarySessionChanged();
    return true;
  }

  function getEntryActiveTask(entry) {
    const runtimeStatus = entry.runtime ? normalizeRuntimeStatus(entry.runtime.getStatus()) : null;
    const source = runtimeStatus?.active_task;
    const startedAt = entry.startedAt || entry.createdAt;
    const activeTask = source || {
      task_id: entry.taskId,
      session_id: entry.sessionId || '',
      title: entry.title,
      stage: 'starting',
      progress_text: '正在启动智能体任务',
      started_at: startedAt,
      last_activity_at: startedAt,
      last_progress_at: startedAt,
      elapsed_seconds: 0,
      idle_seconds: 0,
      waiting_for_user: false,
      workspace_dir: entry.workspaceDir || '',
    };
    return {
      ...activeTask,
      session_id: activeTask.session_id || entry.sessionId || '',
      workspace_dir: activeTask.workspace_dir || entry.workspaceDir || runtimeStatus?.runtime_details?.workspace_dir || '',
      is_primary: isPrimarySession({
        task_id: entry.taskId,
        session_id: activeTask.session_id || entry.sessionId,
        task_key: entry.taskKey,
      }),
    };
  }

  function getStatus() {
    const serviceStatus = getServiceRuntimeStatus();
    const activeTasks = [...activeEntries.values()].map(getEntryActiveTask);
    if (serviceStatus.active_task) {
      activeTasks.push({
        ...serviceStatus.active_task,
        workspace_dir: serviceStatus.active_task.workspace_dir || serviceStatus.runtime_details?.workspace_dir || '',
        is_primary: false,
      });
    }
    const running = activeTasks.length > 0;
    const { active_task: _serviceActiveTask, ...serviceSummary } = serviceStatus;
    return {
      ...serviceSummary,
      phase: running ? 'running' : serviceStatus.phase,
      healthy: running ? true : serviceStatus.healthy,
      message: running ? `${activeTasks.length} 个 Agent Session 正在运行` : serviceStatus.message,
      active_tasks: activeTasks,
      primary_session_id: primarySession?.session_id || '',
      queued_count: 0,
      queued_tasks: [],
      proxy: aiService?.getTextQueueStatus?.() || serviceStatus.proxy || { active: 0, queued: 0, limit: 0 },
    };
  }

  function createAbortError(signal) {
    return resolveAgentAbortReason(signal);
  }

  function startTask(payload = {}, userTaskContextProvider) {
    if (closing) return Promise.reject(new Error('Agent 服务正在关闭'));
    if (payload.signal?.aborted) return Promise.reject(createAbortError(payload.signal));
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const taskKey = safeText(payload.persistent_task?.task_key);
    const entry = {
      taskId,
      taskKey,
      title,
      createdAt: nowIso(),
      startedAt: nowIso(),
      sessionId: '',
      workspaceDir: '',
      primaryRequested: payload.primary_session === true,
      primaryRequestSequence: payload.primary_session === true ? ++latestPrimaryRequestSequence : 0,
      payload: { ...payload, task_id: taskId },
      userTaskContextProvider,
      runtime: null,
      runtimeUnsubscribe: null,
      promise: null,
    };
    entry.runtime = createTaskRuntime(entry);
    activeEntries.set(taskId, entry);
    emitStatus();

    const originalOnSessionStarted = payload.onSessionStarted;
    const runtimePayload = {
      ...entry.payload,
      onSessionStarted(sessionInfo = {}) {
        entry.sessionId = safeText(sessionInfo.session_id);
        entry.workspaceDir = safeText(sessionInfo.workspace_dir);
        try { originalOnSessionStarted?.(sessionInfo); } catch {}
        if (entry.primaryRequested && entry.primaryRequestSequence === latestPrimaryRequestSequence) {
          setPrimarySession({
            task_id: taskId,
            task_key: taskKey,
            session_id: entry.sessionId,
          });
        } else {
          emitStatus();
        }
      },
    };

    entry.promise = entry.runtime.runTask(runtimePayload)
      .then((rawResult) => normalizeRunResult(rawResult))
      .catch((error) => {
        const normalizedError = normalizeRunError(error);
        const persistentTask = Boolean(taskKey);
        // 可恢复子任务由父 Agent 接收错误；运行统计保留，最终失败诊断由父任务上报。
        const shouldReport = runtimePayload.failure_handled_by_parent !== true
          && !runtimePayload.signal?.aborted
          && !['AGENT_DISCONNECTED', 'TASK_CANCELLED'].includes(normalizedError?.code);
        if (shouldReport) {
          void agentErrorReporter.reportFailure({
            payload: runtimePayload,
            error: normalizedError,
            userTaskContext: resolveUserTaskContext(userTaskContextProvider),
          }).finally(() => {
            if (!persistentTask) void entry.runtime?.deleteTaskArchive?.(taskId);
          });
        } else if (!persistentTask) {
          void entry.runtime?.deleteTaskArchive?.(taskId);
        }
        throw normalizedError;
      })
      .finally(async () => {
        activeEntries.delete(taskId);
        try { entry.runtimeUnsubscribe?.(); } catch {}
        entry.runtimeUnsubscribe = null;
        await entry.runtime?.close?.().catch(() => undefined);
        emitStatus();
      });

    return entry.promise;
  }

  function runTask(payload = {}) {
    return startTask(payload, null);
  }

  function loadPersistentTask(taskKey) {
    return loadPersistentAgentTask(app, taskKey);
  }

  function deletePersistentTask(taskKey) {
    deletePersistentAgentTask(app, taskKey);
    clearPrimarySessionIfMatches({ task_key: taskKey });
  }

  function updatePersistentTask(taskKey, partial) {
    return updatePersistentAgentTask(app, taskKey, partial);
  }

  // 复制源任务工作区，并通过 Pi SDK 将其 Session 历史分叉到新的持久任务。
  async function forkPersistentTask(sourceTaskKey, targetTaskKey, state = {}) {
    const sourceTask = loadPersistentAgentTask(app, sourceTaskKey);
    if (!sourceTask?.state?.session_file) {
      throw new Error('源持久 Agent Session 不存在，无法创建分叉任务');
    }
    const sourceSessionFile = getPersistentAgentSessionPath(app, sourceTaskKey, sourceTask.state.session_file);
    if (!fs.existsSync(sourceSessionFile)) {
      throw new Error('源持久 Agent Session 文件不存在，无法创建分叉任务');
    }

    const targetTask = createPersistentAgentTask(app, targetTaskKey, {
      ...state,
      session_file: '',
    });
    try {
      for (const entry of fs.readdirSync(sourceTask.paths.workspaceDir, { withFileTypes: true })) {
        fs.cpSync(
          path.join(sourceTask.paths.workspaceDir, entry.name),
          path.join(targetTask.paths.workspaceDir, entry.name),
          { recursive: true, force: true },
        );
      }
      const { codingAgent } = await loadPiModules();
      const sessionManager = codingAgent.SessionManager.forkFrom(
        sourceSessionFile,
        targetTask.paths.workspaceDir,
        targetTask.paths.sessionsDir,
      );
      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) throw new Error('Pi SDK 未生成分叉 Session 文件');
      return updatePersistentAgentTask(app, targetTaskKey, {
        session_file: path.basename(sessionFile),
      });
    } catch (error) {
      deletePersistentAgentTask(app, targetTaskKey);
      throw error;
    }
  }

  function hasPersistentTaskSession(taskKey) {
    const task = loadPersistentAgentTask(app, taskKey);
    if (!task?.state?.session_file) return false;
    try {
      return fs.existsSync(getPersistentAgentSessionPath(app, taskKey, task.state.session_file));
    } catch {
      return false;
    }
  }

  // 为后台父任务绑定最新诊断上下文和统一 AI 队列作用域。
  function bindTaskContext(userTaskContextProvider, options = {}) {
    const queueScopeId = safeText(options.queueScopeId || options.queue_scope_id);
    const signal = options.signal;
    const primarySessionRequested = options.primary_session === true;
    return {
      runTask: (payload = {}) => {
        const taskSignal = signal && payload.signal
          ? AbortSignal.any([signal, payload.signal])
          : payload.signal || signal;
        return startTask({
          ...payload,
          ...(queueScopeId && !payload.queueScopeId && !payload.queue_scope_id ? { queue_scope_id: queueScopeId } : {}),
          // 子任务可以显式拒绝继承主会话身份，队列和取消作用域仍照常继承。
          primary_session: payload.primary_session ?? primarySessionRequested,
          ...(taskSignal ? { signal: taskSignal } : {}),
        }, userTaskContextProvider);
      },
      getStatus,
      hasPersistentTaskSession,
      loadPersistentTask,
      updatePersistentTask,
      deletePersistentTask,
      forkPersistentTask,
      getPrimarySession,
      isPrimarySession,
    };
  }

  async function warmup() {
    const piRuntime = ensureServiceRuntime();
    await piRuntime.warmup();
    return getStatus();
  }

  async function selfCheck() {
    return normalizeSelfCheckResult(await ensureServiceRuntime().runSelfCheck());
  }

  async function restart(reason) {
    await ensureServiceRuntime().restart(reason || 'manual');
    return getStatus();
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    serviceRuntime?.handleConfigChanged?.(nextConfig, previousConfig);
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // 注册只读执行监视器；最后一个监听关闭后立即丢弃待推送增量。
  function onMonitorEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    monitorListeners.add(listener);
    return () => {
      monitorListeners.delete(listener);
      if (!monitorListeners.size) clearPendingMonitorEvents();
    };
  }

  function onQuestion(listener) {
    if (typeof listener !== 'function') return () => {};
    questionListeners.add(listener);
    return () => questionListeners.delete(listener);
  }

  function onPrimarySessionChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    primarySessionListeners.add(listener);
    return () => primarySessionListeners.delete(listener);
  }

  function getMonitorSnapshot() {
    const status = getStatus();
    return {
      attached_at: nowIso(),
      active_tasks: status.active_tasks || [],
      primary_session_id: status.primary_session_id || '',
    };
  }

  async function exportSelfCheckReport(result = {}) {
    const markdown = buildPiSelfCheckReportMarkdown(result);
    const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
    const defaultName = `${sanitizeReportFilename(`${result.runtime_name || PI_RUNTIME_NAME}自检报告`)}-${formatTimestampForFilename(result.checked_at)}.md`;
    const saveResult = await dialog.showSaveDialog({
      title: '导出智能体自检报告',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true, message: '已取消导出' };
    fs.writeFileSync(saveResult.filePath, markdown, 'utf-8');
    return { success: true, path: saveResult.filePath, message: '智能体自检报告已导出' };
  }

  async function close() {
    closing = true;
    rejectPendingQuestions(createAgentDisconnectedError());
    questionListeners.clear();
    primarySessionListeners.clear();
    monitorListeners.clear();
    clearPendingMonitorEvents();
    agentErrorReporter.close();

    const entries = [...activeEntries.values()];
    await Promise.all(entries.map((entry) => entry.runtime?.close?.().catch(() => undefined)));
    await Promise.allSettled(entries.map((entry) => entry.promise));
    activeEntries.clear();

    if (serviceRuntime) await serviceRuntime.close?.().catch(() => undefined);
    try { serviceRuntimeUnsubscribe?.(); } catch {}
    serviceRuntimeUnsubscribe = null;
    serviceRuntime = null;
    emitStatus();
  }

  return {
    bindTaskContext,
    deletePersistentTask,
    forkPersistentTask,
    loadPersistentTask,
    updatePersistentTask,
    warmup,
    runTask,
    selfCheck,
    getStatus,
    hasPersistentTaskSession,
    restart,
    handleConfigChanged,
    onStatus,
    onMonitorEvent,
    getMonitorSnapshot,
    getPendingQuestion,
    getPendingQuestions,
    answerQuestion,
    suppressQuestionAutoAnswer,
    onQuestion,
    getPrimarySession,
    isPrimarySession,
    onPrimarySessionChanged,
    exportSelfCheckReport,
    close,
  };
}

module.exports = {
  createAgentService,
};
