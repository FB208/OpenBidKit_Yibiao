const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const {
  createAgentRuntime,
  getAgentRuntimeDefinition,
  listAgentRuntimeDescriptors,
  normalizeAgentRuntimeId,
} = require('./agent/agentRuntimeRegistry.cjs');
const { buildPiSelfCheckReportMarkdown } = require('./pi/piSelfCheckService.cjs');

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

function createStoppedStatus(runtimeId) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  return {
    runtime_id: runtimeId,
    runtime_name: definition.displayName,
    phase: 'stopped',
    healthy: false,
    message: `${definition.displayName} 未启动`,
    updated_at: nowIso(),
    active_task: null,
    queued_count: 0,
    queued_tasks: [],
    proxy: { active: 0, queued: 0, limit: 0 },
    runtime_details: {},
  };
}

function normalizeRuntimeStatus(runtimeId, rawStatus = {}) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  const runtimeDetails = rawStatus.runtime_details && typeof rawStatus.runtime_details === 'object'
    ? rawStatus.runtime_details
    : rawStatus.opencode && typeof rawStatus.opencode === 'object'
      ? rawStatus.opencode
      : {};
  return {
    runtime_id: runtimeId,
    runtime_name: definition.displayName,
    phase: rawStatus.phase || 'stopped',
    healthy: Boolean(rawStatus.healthy),
    message: rawStatus.message || `${definition.displayName} 未启动`,
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

function createResultDiagnostics(rawResult = {}) {
  const diagnostics = rawResult.diagnostics && typeof rawResult.diagnostics === 'object'
    ? { ...rawResult.diagnostics }
    : {};
  if (Array.isArray(rawResult.opencode_request_log)) diagnostics.request_log = rawResult.opencode_request_log;
  if (rawResult.opencode_stderr_tail) diagnostics.stderr_tail = rawResult.opencode_stderr_tail;
  if (rawResult.opencode_stdout_tail) diagnostics.stdout_tail = rawResult.opencode_stdout_tail;
  return diagnostics;
}

function normalizeRunResult(runtimeId, rawResult = {}) {
  const {
    opencode_request_log: _requestLog,
    opencode_stderr_tail: _stderrTail,
    opencode_stdout_tail: _stdoutTail,
    ...result
  } = rawResult || {};
  return {
    ...result,
    runtime_id: runtimeId,
    diagnostics: createResultDiagnostics(rawResult),
  };
}

function normalizeRunError(runtimeId, error) {
  if (!error || typeof error !== 'object') return error;
  const diagnostics = error.agentDiagnostics && typeof error.agentDiagnostics === 'object'
    ? { ...error.agentDiagnostics }
    : {};
  if (Array.isArray(error.openCodeRequestLog)) diagnostics.request_log = error.openCodeRequestLog;
  if (error.openCodeStderrTail) diagnostics.stderr_tail = error.openCodeStderrTail;
  if (error.openCodeStdoutTail) diagnostics.stdout_tail = error.openCodeStdoutTail;
  if (error.openCodeRoute || error.openCodeMethod || error.openCodeStatus || error.openCodeCause) {
    diagnostics.request = {
      route: error.openCodeRoute || '',
      method: error.openCodeMethod || '',
      status: Number(error.openCodeStatus || 0),
      duration_ms: Number(error.openCodeDurationMs || 0),
      cause: error.openCodeCause || '',
    };
  }
  error.agentRuntimeId = runtimeId;
  error.agentDiagnostics = diagnostics;
  return error;
}

function normalizeSelfCheckResult(runtimeId, rawResult = {}) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  return {
    ...rawResult,
    success: Boolean(rawResult.success),
    runtime_id: runtimeId,
    runtime_name: definition.displayName,
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
      ? normalizeRuntimeStatus(runtimeId, rawResult.runtime_status)
      : undefined,
  };
}

function buildSelfCheckReportMarkdown(result = {}) {
  const lines = [
    `# ${result.runtime_name || '智能体'}自检报告`,
    '',
    `- 结果：${result.success ? '通过' : result.status === 'busy' ? '跳过' : '失败'}`,
    `- 信息：${result.message || '-'}`,
    `- 检查时间：${result.checked_at || '-'}`,
    `- 耗时：${result.duration_ms || 0} ms`,
    `- 运行目录：${result.runtime_root || '-'}`,
    `- 工作区：${result.workspace_dir || '-'}`,
    '',
  ];
  if (result.conclusion) lines.push('## 结论', '', result.conclusion, '');
  if (Array.isArray(result.steps) && result.steps.length) {
    lines.push('## 检查步骤', '');
    result.steps.forEach((step) => lines.push(`- ${step.label}：${step.status}${step.message ? ` - ${step.message}` : ''}`));
    lines.push('');
  }
  if (Array.isArray(result.sections)) {
    result.sections.forEach((section) => {
      lines.push(`## ${section.title}`, '', section.summary || section.status, '');
      (section.details || []).forEach((item) => lines.push(`- ${item.label}：${item.value}`));
      (section.items || []).forEach((item) => lines.push(`- ${item.label}：${item.message || item.detail || item.status}`));
      lines.push('');
    });
  }
  if (result.detail_text) lines.push('## 详细信息', '', '```text', result.detail_text, '```', '');
  return lines.join('\n');
}

function createAgentService({ app, configStore, mainWindow, aiService }) {
  const runtimes = new Map();
  const runtimeUnsubscribers = new Map();
  const listeners = new Set();
  const queue = [];
  let activeEntry = null;
  let queueDraining = false;
  let closing = false;

  function getSelectedRuntimeId() {
    return normalizeAgentRuntimeId(configStore.load().agent_runtime);
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  function ensureRuntime(runtimeId) {
    const normalizedId = normalizeAgentRuntimeId(runtimeId);
    if (runtimes.has(normalizedId)) return runtimes.get(normalizedId);
    const runtime = createAgentRuntime(normalizedId, { app, configStore, mainWindow, aiService });
    runtimes.set(normalizedId, runtime);
    const unsubscribe = runtime.onStatus?.(() => emitStatus());
    if (unsubscribe) runtimeUnsubscribers.set(normalizedId, unsubscribe);
    return runtime;
  }

  function getRuntimeStatus(runtimeId) {
    const normalizedId = normalizeAgentRuntimeId(runtimeId);
    const runtime = runtimes.get(normalizedId);
    return runtime ? normalizeRuntimeStatus(normalizedId, runtime.getStatus()) : createStoppedStatus(normalizedId);
  }

  function getQueuedTasks() {
    return queue.map((entry, index) => ({
      task_id: entry.taskId,
      title: entry.title,
      queued_at: entry.queuedAt,
      position: index + 1,
      runtime_id: entry.runtimeId,
    }));
  }

  function getCoordinatorStatus() {
    const selectedRuntimeId = getSelectedRuntimeId();
    const activeRuntimeId = activeEntry?.runtimeId || '';
    const sourceStatus = getRuntimeStatus(activeRuntimeId || selectedRuntimeId);
    return {
      ...sourceStatus,
      selected_runtime_id: selectedRuntimeId,
      active_runtime_id: activeRuntimeId,
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

  function getStatus(runtimeId) {
    return runtimeId ? getRuntimeStatus(runtimeId) : getCoordinatorStatus();
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
            const runtime = ensureRuntime(entry.runtimeId);
            const rawResult = await runtime.runTask(entry.payload);
            entry.resolve(normalizeRunResult(entry.runtimeId, rawResult));
          } catch (error) {
            entry.reject(normalizeRunError(entry.runtimeId, error));
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

  function runTask(payload = {}, runtimeId) {
    if (closing) return Promise.reject(new Error('Agent 服务正在关闭'));
    const targetRuntimeId = normalizeAgentRuntimeId(runtimeId || getSelectedRuntimeId());
    if (payload.signal?.aborted) return Promise.reject(createAbortError(payload.signal));
    const taskId = payload.task_id || require('node:crypto').randomUUID();
    const title = payload.title || '易标智能体任务';
    return new Promise((resolve, reject) => {
      const entry = {
        runtimeId: targetRuntimeId,
        taskId,
        title,
        queuedAt: nowIso(),
        payload: { ...payload, task_id: taskId },
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
          meta: { runtime_id: targetRuntimeId, position: queue.length },
        });
      } catch {}
      emitStatus();
      drainQueue();
    });
  }

  function bindSelectedRuntime() {
    const runtimeId = getSelectedRuntimeId();
    return {
      runtimeId,
      runTask: (payload) => runTask(payload, runtimeId),
      getStatus: () => getStatus(runtimeId),
    };
  }

  async function warmup(runtimeId) {
    const targetRuntimeId = normalizeAgentRuntimeId(runtimeId || getSelectedRuntimeId());
    const runtime = ensureRuntime(targetRuntimeId);
    await runtime.warmup();
    return getStatus(targetRuntimeId);
  }

  async function selfCheck(runtimeId) {
    const targetRuntimeId = normalizeAgentRuntimeId(runtimeId || getSelectedRuntimeId());
    if (activeEntry || queue.length) {
      const definition = getAgentRuntimeDefinition(targetRuntimeId);
      return {
        success: false,
        runtime_id: targetRuntimeId,
        runtime_name: definition.displayName,
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
        runtime_status: getCoordinatorStatus(),
      };
    }
    const definition = getAgentRuntimeDefinition(targetRuntimeId);
    const entry = {
      runtimeId: targetRuntimeId,
      taskId: `${targetRuntimeId}-self-check`,
      title: `${definition.displayName} 自检`,
      queuedAt: nowIso(),
      startedAt: nowIso(),
      payload: {},
    };
    activeEntry = entry;
    emitStatus();
    try {
      const runtime = ensureRuntime(targetRuntimeId);
      return normalizeSelfCheckResult(targetRuntimeId, await runtime.runSelfCheck());
    } finally {
      activeEntry = null;
      emitStatus();
      drainQueue();
    }
  }

  async function restart(reason, runtimeId) {
    const targetRuntimeId = normalizeAgentRuntimeId(runtimeId || getSelectedRuntimeId());
    const runtime = ensureRuntime(targetRuntimeId);
    await runtime.restart(reason || 'manual');
    return getStatus(targetRuntimeId);
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    runtimes.forEach((runtime) => runtime.handleConfigChanged?.(nextConfig, previousConfig));
    const nextRuntimeId = normalizeAgentRuntimeId(nextConfig.agent_runtime);
    const previousRuntimeId = normalizeAgentRuntimeId(previousConfig.agent_runtime);
    if (nextRuntimeId !== previousRuntimeId) {
      emitStatus();
      void warmup(nextRuntimeId).catch(() => emitStatus());
    }
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function exportSelfCheckReport(result = {}) {
    const markdown = result.runtime_id === 'pi'
      ? buildPiSelfCheckReportMarkdown(result)
      : buildSelfCheckReportMarkdown(result);
    const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
    const defaultName = `${sanitizeReportFilename(`${result.runtime_name || '智能体'}自检报告`)}-${formatTimestampForFilename(result.checked_at)}.md`;
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
    const error = new Error('Agent 服务正在关闭');
    while (queue.length) {
      const entry = queue.shift();
      entry.cleanup?.();
      entry.reject(error);
    }
    await Promise.all(Array.from(runtimes.values()).map((runtime) => runtime.close?.().catch(() => undefined)));
    runtimeUnsubscribers.forEach((unsubscribe) => {
      try { unsubscribe(); } catch {}
    });
    runtimeUnsubscribers.clear();
    runtimes.clear();
    emitStatus();
  }

  return {
    listRuntimes: () => listAgentRuntimeDescriptors(),
    bindSelectedRuntime,
    warmup,
    runTask,
    selfCheck,
    getStatus,
    restart,
    handleConfigChanged,
    onStatus,
    exportSelfCheckReport,
    close,
  };
}

module.exports = {
  createAgentService,
};
