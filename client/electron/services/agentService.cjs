const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const { createPiRuntimeService } = require('./pi/piRuntimeService.cjs');
const { buildPiSelfCheckReportMarkdown } = require('./pi/piSelfCheckService.cjs');
const { createAgentErrorReporter } = require('./agent/agentErrorReporter.cjs');

const PI_RUNTIME_ID = 'pi';
const PI_RUNTIME_NAME = 'Pi Agent';

function nowIso() {
  return new Date().toISOString();
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
    active_task: null,
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

// 协调唯一 Pi Agent 实例，并保持所有智能体任务共用同一条 FIFO 队列。
function createAgentService({ app, configStore, aiService, licenseService }) {
  const agentErrorReporter = createAgentErrorReporter({ app, configStore, licenseService });
  const listeners = new Set();
  const monitorListeners = new Set();
  const queue = [];
  let runtime = null;
  let runtimeUnsubscribe = null;
  let activeEntry = null;
  let queueDraining = false;
  let closing = false;
  let monitorSequence = 0;
  let monitorFlushTimer = null;
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
    if (event.type === 'assistant_delta') {
      const key = String(event.task_id || 'active');
      const previous = pendingAssistantDeltas.get(key);
      pendingAssistantDeltas.set(key, {
        ...event,
        delta: `${previous?.delta || ''}${event.delta || ''}`,
      });
      scheduleMonitorFlush();
      return;
    }
    if (event.type === 'tool_update') {
      const key = `${event.task_id || 'active'}:${event.tool_call_id || event.tool_name || 'tool'}`;
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

  function ensureRuntime() {
    if (runtime) return runtime;
    runtime = createPiRuntimeService({
      app,
      configStore,
      aiService,
      isMonitorActive: () => monitorListeners.size > 0,
      onMonitorEvent: emitMonitorEvent,
    });
    runtimeUnsubscribe = runtime.onStatus?.(() => emitStatus()) || null;
    return runtime;
  }

  function getRuntimeStatus() {
    return runtime ? normalizeRuntimeStatus(runtime.getStatus()) : createStoppedStatus();
  }

  function getQueuedTasks() {
    return queue.map((entry, index) => ({
      task_id: entry.taskId,
      title: entry.title,
      queued_at: entry.queuedAt,
      position: index + 1,
    }));
  }

  function getStatus() {
    const sourceStatus = getRuntimeStatus();
    return {
      ...sourceStatus,
      queued_count: queue.length,
      queued_tasks: getQueuedTasks(),
      active_task: sourceStatus.active_task || (activeEntry ? {
        task_id: activeEntry.taskId,
        title: activeEntry.title,
        stage: 'starting',
        progress_text: '正在启动智能体任务',
        started_at: activeEntry.startedAt || activeEntry.queuedAt,
        last_activity_at: activeEntry.startedAt || activeEntry.queuedAt,
        elapsed_seconds: 0,
        idle_seconds: 0,
      } : null),
    };
  }

  function createAbortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new Error(safeText(signal?.reason) || 'Agent 任务已取消');
  }

  function removeQueuedEntry(entry, error) {
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    entry.cleanup?.();
    entry.reject(error);
    emitStatus();
  }

  function drainQueue() {
    if (queueDraining || activeEntry || closing) return;
    queueDraining = true;
    void (async () => {
      try {
        while (!activeEntry && queue.length && !closing) {
          const entry = queue.shift();
          entry.cleanup?.();
          if (entry.payload.signal?.aborted) {
            entry.reject(createAbortError(entry.payload.signal));
            continue;
          }
          activeEntry = entry;
          entry.startedAt = nowIso();
          emitStatus();
          try {
            const rawResult = await ensureRuntime().runTask(entry.payload);
            entry.resolve(normalizeRunResult(rawResult));
          } catch (error) {
            const normalizedError = normalizeRunError(error);
            agentErrorReporter.reportFailure({
              payload: entry.payload,
              error: normalizedError,
              userTaskContext: resolveUserTaskContext(entry.userTaskContextProvider),
            });
            entry.reject(normalizedError);
          } finally {
            activeEntry = null;
            emitStatus();
          }
        }
      } finally {
        queueDraining = false;
        if (queue.length && !activeEntry && !closing) setTimeout(drainQueue, 0);
      }
    })();
  }

  function enqueueTask(payload = {}, userTaskContextProvider) {
    if (closing) return Promise.reject(new Error('Agent 服务正在关闭'));
    if (payload.signal?.aborted) return Promise.reject(createAbortError(payload.signal));
    const taskId = payload.task_id || require('node:crypto').randomUUID();
    const title = payload.title || '易标智能体任务';
    return new Promise((resolve, reject) => {
      const entry = {
        taskId,
        title,
        queuedAt: nowIso(),
        payload: { ...payload, task_id: taskId },
        userTaskContextProvider,
        resolve,
        reject,
        cleanup: null,
      };
      if (payload.signal?.addEventListener) {
        const onAbort = () => removeQueuedEntry(entry, createAbortError(payload.signal));
        payload.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => payload.signal.removeEventListener('abort', onAbort);
      }
      queue.push(entry);
      try {
        payload.onActivity?.({
          stage: 'queued',
          message: queue.length > 1 ? `Agent 任务排队中，前方还有 ${queue.length - 1} 个任务。` : 'Agent 任务已进入执行队列。',
          source: 'agent-coordinator.queue',
          visible: true,
          activity: false,
          meta: { runtime_id: PI_RUNTIME_ID, position: queue.length },
        });
      } catch {}
      emitStatus();
      drainQueue();
    });
  }

  function runTask(payload = {}) {
    return enqueueTask(payload, null);
  }

  // 为后台父任务绑定最新诊断上下文，不再绑定或选择运行时。
  function bindTaskContext(userTaskContextProvider) {
    return {
      runTask: (payload) => enqueueTask(payload, userTaskContextProvider),
      getStatus,
    };
  }

  async function warmup() {
    const piRuntime = ensureRuntime();
    await piRuntime.warmup();
    return getStatus();
  }

  async function selfCheck() {
    if (activeEntry || queue.length) {
      return {
        success: false,
        runtime_id: PI_RUNTIME_ID,
        runtime_name: PI_RUNTIME_NAME,
        status: 'busy',
        message: 'Agent 正在处理其他任务，请耐心等待',
        checked_at: nowIso(),
        duration_ms: 0,
        log_dir: '',
        log_file: '',
        runtime_root: '',
        workspace_dir: '',
        output_file: '',
        output_path: '',
        steps: [],
        sections: [],
        detail_text: 'Agent 全局队列正在执行任务，本次自检已跳过。',
        runtime_status: getStatus(),
      };
    }
    const entry = {
      taskId: `${PI_RUNTIME_ID}-self-check`,
      title: `${PI_RUNTIME_NAME} 自检`,
      queuedAt: nowIso(),
      startedAt: nowIso(),
      payload: {},
    };
    activeEntry = entry;
    emitStatus();
    try {
      return normalizeSelfCheckResult(await ensureRuntime().runSelfCheck());
    } finally {
      activeEntry = null;
      emitStatus();
      drainQueue();
    }
  }

  async function restart(reason) {
    await ensureRuntime().restart(reason || 'manual');
    return getStatus();
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    runtime?.handleConfigChanged?.(nextConfig, previousConfig);
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

  function getMonitorSnapshot() {
    return {
      attached_at: nowIso(),
      active_task: getRuntimeStatus().active_task || null,
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
    monitorListeners.clear();
    clearPendingMonitorEvents();
    agentErrorReporter.close();
    const error = new Error('Agent 服务正在关闭');
    while (queue.length) {
      const entry = queue.shift();
      entry.cleanup?.();
      entry.reject(error);
    }
    if (runtime) await runtime.close?.().catch(() => undefined);
    try { runtimeUnsubscribe?.(); } catch {}
    runtimeUnsubscribe = null;
    runtime = null;
    emitStatus();
  }

  return {
    bindTaskContext,
    warmup,
    runTask,
    selfCheck,
    getStatus,
    restart,
    handleConfigChanged,
    onStatus,
    onMonitorEvent,
    getMonitorSnapshot,
    exportSelfCheckReport,
    close,
  };
}

module.exports = {
  createAgentService,
};
