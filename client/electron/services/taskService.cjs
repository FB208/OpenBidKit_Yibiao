const crypto = require('node:crypto');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask } = require('./contentGenerationTask.cjs');
const { runOutlineGenerationTask } = require('./outlineGenerationTask.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');

const taskDefinitions = {
  'bid-analysis': {
    label: '招标文件解析',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidAnalysisTask',
  },
  'outline-generation': {
    label: '目录生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineGenerationTask',
  },
  'content-generation': {
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'contentGenerationTask',
  },
  'rejection-items-extraction': {
    label: '无效与废标项解析',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 1,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'extractionTask',
  },
  'rejection-check-run': {
    label: '废标项检查',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'checkTask',
  },
  'duplicate-analysis': {
    label: '标书查重分析',
    group: 'duplicate-check',
    groupLabel: '标书查重',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'duplicateCheck',
    field: 'analysisTask',
  },
};

function now() {
  return new Date().toISOString();
}

function getTaskDefinition(type) {
  return taskDefinitions[type] || { label: type, stateKey: 'technicalPlan', field: undefined, lockPolicy: 'none' };
}

function getScopeId(payload) {
  const scopeId = payload?.scopeId ?? payload?.scope_id;
  return scopeId === undefined || scopeId === null ? '' : String(scopeId);
}

function createDuplicateCheckPayloadSignature(payload = {}) {
  const files = [payload.tenderFile, ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function getPayloadSignature(type, payload) {
  if (type === 'duplicate-analysis') {
    return createDuplicateCheckPayloadSignature(payload);
  }
  return undefined;
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';

function collectLeafItems(items) {
  return (items || []).flatMap((item) => item?.children?.length ? collectLeafItems(item.children) : [item]);
}

function clearOutlineContentByIds(items, interruptedIds) {
  if (!(interruptedIds instanceof Set) || !interruptedIds.size) {
    return items;
  }

  return (items || []).map((item) => {
    const nextItem = interruptedIds.has(item.id) ? { ...item, content: '' } : { ...item };
    if (item?.children?.length) {
      nextItem.children = clearOutlineContentByIds(item.children, interruptedIds);
    }
    return nextItem;
  });
}

function normalizeInterruptedContentSections(technicalPlan) {
  const sections = technicalPlan?.contentGenerationSections || {};
  const interruptedIds = new Set();
  const nextSections = { ...sections };

  for (const [itemId, section] of Object.entries(sections)) {
    if (section?.status !== 'running') {
      continue;
    }
    interruptedIds.add(itemId);
    // 单小节重新生成时异常退出可能丢失旧正文；场景极窄，恢复优先保证可继续重跑，不额外保存旧正文。
    nextSections[itemId] = {
      ...section,
      status: 'error',
      content: '',
      error: INTERRUPTED_SECTION_ERROR,
      updated_at: now(),
    };
  }

  if (!interruptedIds.size) {
    return { sections, outlineData: technicalPlan?.outlineData, interruptedIds };
  }

  const outlineData = technicalPlan?.outlineData?.outline
    ? {
      ...technicalPlan.outlineData,
      outline: clearOutlineContentByIds(technicalPlan.outlineData.outline, interruptedIds),
    }
    : technicalPlan?.outlineData;

  return { sections: nextSections, outlineData, interruptedIds };
}

function inferContentGenerationPhase(technicalPlan) {
  const taskContent = technicalPlan?.contentGenerationTask?.stats?.content || {};
  const taskPhase = taskContent.phase;
  const runtimePhase = technicalPlan?.contentGenerationRuntime?.phase;
  if (['outline-expanding', 'expanding', 'illustrating'].includes(taskPhase)) {
    return taskPhase;
  }
  if (['planning', 'generating', 'outline-expanding', 'expanding', 'illustrating'].includes(runtimePhase)) {
    return runtimePhase;
  }

  const leaves = collectLeafItems(technicalPlan?.outlineData?.outline || []);
  const sections = technicalPlan?.contentGenerationSections || {};
  const completed = leaves.filter((item) => sections[item.id]?.status === 'success').length;
  const minimumWords = Number(taskContent.minimum_words ?? technicalPlan?.contentGenerationOptions?.minimumWords ?? 0) || 0;
  const currentWords = Number(taskContent.current_words ?? 0) || 0;

  if (leaves.length && completed >= leaves.length && minimumWords > 0 && currentWords < minimumWords) {
    return 'expanding';
  }
  if (leaves.length && completed > 0) {
    return 'generating';
  }
  return taskPhase || 'planning';
}

function createTask(type, payload) {
  const definition = getTaskDefinition(type);
  const scopeId = getScopeId(payload);
  const payloadSignature = getPayloadSignature(type, payload);
  return {
    task_id: crypto.randomUUID(),
    type,
    group: definition.group,
    step: definition.step,
    lock_policy: definition.lockPolicy,
    scope_id: scopeId || undefined,
    payload_signature: payloadSignature,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: now(),
    updated_at: now(),
  };
}

function createTaskService({ aiService, workspaceStore, technicalPlanStore, knowledgeBaseService, duplicateCheckService }) {
  const subscribers = new Set();
  const activeTasks = new Map();
  const activeTaskControls = new Map();

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
  }

  function getSnapshotForTask(task) {
    const definition = getTaskDefinition(task.type);
    if (definition.stateKey === 'technicalPlan') {
      return { technicalPlan: technicalPlanStore.loadTechnicalPlan() };
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: workspaceStore.loadRejectionCheck() };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: workspaceStore.loadDuplicateCheck() };
    }
    return {};
  }

  function subscribe(webContents) {
    subscribers.add(webContents);
    for (const task of activeTasks.values()) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', { task, ...getSnapshotForTask(task) });
      }
    }
    webContents.once('destroyed', () => subscribers.delete(webContents));
  }

  function getTaskField(type) {
    return getTaskDefinition(type).field;
  }

  function getActiveTaskConflict(type, payload) {
    const definition = getTaskDefinition(type);
    if (definition.lockPolicy === 'none' || !definition.group) {
      return null;
    }

    const nextScopeId = getScopeId(payload);
    for (const task of activeTasks.values()) {
      if (!isActiveTaskStatus(task.status) || task.type === type) {
        continue;
      }

      const activeDefinition = getTaskDefinition(task.type);
      if (activeDefinition.group !== definition.group) {
        continue;
      }

      if (definition.lockPolicy === 'group-exclusive' || activeDefinition.lockPolicy === 'group-exclusive') {
        return { task, definition: activeDefinition };
      }

      if (definition.lockPolicy === 'scope-exclusive' && nextScopeId && task.scope_id === nextScopeId) {
        return { task, definition: activeDefinition };
      }
    }

    return null;
  }

  function assertTaskCanStart(type, payload) {
    const conflict = getActiveTaskConflict(type, payload);
    if (!conflict) {
      const definition = getTaskDefinition(type);
      if (definition.group === 'technical-plan') {
        const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
        const pausedContentTask = technicalPlan.contentGenerationTask;
        if (pausedContentTask?.status === 'paused') {
          if (type === 'content-generation' && payload?.resume) {
            return;
          }
          throw new Error('正文生成已暂停，请先继续当前正文生成任务或重置技术方案后再启动新的任务。');
        }
      }
      return;
    }

    const definition = getTaskDefinition(type);
    throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${conflict.definition.label || conflict.task.type}”，请完成后再启动“${definition.label || type}”。`);
  }

  function updateWorkspaceState(definition, partial) {
    if (definition.stateKey === 'technicalPlan') {
      return technicalPlanStore.updateTechnicalPlan(partial);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return workspaceStore.updateRejectionCheck(partial);
    }
    if (definition.stateKey === 'duplicateCheck') {
      return workspaceStore.updateDuplicateCheck(partial);
    }
    return technicalPlanStore.updateTechnicalPlan(partial);
  }

  function loadWorkspaceState(definition) {
    if (definition.stateKey === 'technicalPlan') {
      return technicalPlanStore.loadTechnicalPlan();
    }
    if (definition.stateKey === 'rejectionCheck') {
      return workspaceStore.loadRejectionCheck();
    }
    if (definition.stateKey === 'duplicateCheck') {
      return workspaceStore.loadDuplicateCheck();
    }
    return technicalPlanStore.loadTechnicalPlan();
  }

  function buildSnapshot(definition, state) {
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: state };
    }
    return { technicalPlan: state };
  }

  function startManagedTask(type, payload, runner, initialPartial = {}) {
    const existingTask = activeTasks.get(type);
    if (existingTask && isActiveTaskStatus(existingTask.status)) {
      const nextPayloadSignature = getPayloadSignature(type, payload);
      if (existingTask.payload_signature && nextPayloadSignature && existingTask.payload_signature !== nextPayloadSignature) {
        const definition = getTaskDefinition(type);
        throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${definition.label || type}”，请等待当前任务完成后再重新分析新的文件集合。`);
      }
      emit(existingTask, getSnapshotForTask(existingTask));
      return existingTask;
    }

    assertTaskCanStart(type, payload);

    const definition = getTaskDefinition(type);
    const task = createTask(type, payload);
    activeTasks.set(type, task);
    const taskField = getTaskField(type);
    let currentTask = task;
    const taskControl = {
      pauseRequested: false,
      isPauseRequested() {
        return this.pauseRequested;
      },
      requestPause() {
        this.pauseRequested = true;
        const pausedLogs = currentTask.logs?.length
          ? currentTask.logs
          : ['已请求暂停，正在等待当前 AI 请求完成。'];
        const pausingTask = updateTask({ status: 'pausing', pause_requested: true, logs: pausedLogs });
        const state = updateWorkspaceState(definition, { [taskField]: pausingTask });
        emit(pausingTask, buildSnapshot(definition, state));
        return pausingTask;
      },
    };
    activeTaskControls.set(type, taskControl);

    const updateTask = (partial, technicalPlan) => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running'
        ? 'pausing'
        : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || partial.pause_requested,
        logs: partial.logs ? partial.logs : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(type, currentTask);
      if (technicalPlan) {
        const persistedState = taskField ? updateWorkspaceState(definition, { [taskField]: currentTask }) : technicalPlan;
        emit(currentTask, buildSnapshot(definition, persistedState));
      }
      return currentTask;
    };

    const previousState = loadWorkspaceState(definition) || {};
    const state = updateWorkspaceState(definition, { ...initialPartial, [taskField]: currentTask });
    emit(currentTask, buildSnapshot(definition, state));

    const runnerWorkspaceStore = definition.stateKey === 'technicalPlan' ? technicalPlanStore : workspaceStore;
    runner({ aiService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, updateTask, payload, taskControl, previousState }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextState = updateWorkspaceState(definition, { [taskField]: failedTask });
      emit(failedTask, buildSnapshot(definition, nextState));
    }).finally(() => {
      activeTasks.delete(type);
      activeTaskControls.delete(type);
    });

    return currentTask;
  }

  function recoverInterruptedContentGenerationTask() {
    if (activeTasks.has('content-generation')) {
      return;
    }

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const contentTask = technicalPlan.contentGenerationTask;
    if (!isActiveTaskStatus(contentTask?.status)) {
      return;
    }

    const { sections, outlineData, interruptedIds } = normalizeInterruptedContentSections(technicalPlan);
    const normalizedPlan = interruptedIds.size
      ? { ...technicalPlan, contentGenerationSections: sections, outlineData }
      : technicalPlan;
    const phase = inferContentGenerationPhase(normalizedPlan);
    const nextLogs = [
      ...(Array.isArray(contentTask.logs) ? contentTask.logs : []),
      '上次正文生成因应用关闭而暂停，可点击继续恢复。',
    ];
    const nextStats = {
      ...(contentTask.stats || {}),
      content: {
        ...(contentTask.stats?.content || {}),
        phase,
      },
    };
    const pausedTask = {
      ...contentTask,
      status: 'paused',
      pause_requested: false,
      logs: nextLogs,
      stats: nextStats,
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationTask: pausedTask,
      contentGenerationRuntime: {
        ...(normalizedPlan.contentGenerationRuntime || {}),
        phase,
        updated_at: now(),
      },
    });
    emit(pausedTask, { technicalPlan: state });
  }

  return {
    subscribe,
    startBidAnalysis(payload) {
      return startManagedTask('bid-analysis', payload, runBidAnalysisTask);
    },
    startOutlineGeneration(payload) {
      return startManagedTask('outline-generation', payload, runOutlineGenerationTask, {
        outlineMode: payload?.mode,
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids) ? payload.reference_knowledge_document_ids : [],
        outlineData: null,
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      });
    },
    startContentGeneration(payload) {
      return startManagedTask('content-generation', payload, runContentGenerationTask);
    },
    pauseContentGeneration() {
      const task = activeTasks.get('content-generation');
      const control = activeTaskControls.get('content-generation');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        return control.requestPause();
      }

      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      const contentTask = technicalPlan.contentGenerationTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }

      throw new Error('当前没有正在生成的正文任务。');
    },
    startRejectionItemsExtraction(payload) {
      return startManagedTask('rejection-items-extraction', payload, runRejectionItemsExtractionTask, payload?.workspaceState || {});
    },
    startRejectionCheck(payload) {
      return startManagedTask('rejection-check-run', payload, runRejectionCheckTask, payload?.workspaceState || {});
    },
    startDuplicateAnalysis(payload) {
      if (!duplicateCheckService?.runAnalysisTask) {
        throw new Error('标书查重任务服务尚未初始化');
      }
      return startManagedTask('duplicate-analysis', payload, duplicateCheckService.runAnalysisTask);
    },
    getActiveTasks() {
      recoverInterruptedContentGenerationTask();
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
