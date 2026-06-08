const crypto = require('node:crypto');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask } = require('./contentGenerationTask.cjs');
const { runGlobalFactsTask } = require('./globalFactsTask.cjs');
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
  'global-facts-generation': {
    label: '全局事实设定',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsTask',
  },
  'content-generation': {
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
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

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function copyPatchFields(target, source, fields) {
  for (const field of fields) {
    if (hasOwn(source, field)) {
      target[field] = source[field];
    }
  }
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
  if (['restoring', 'outline-expanding', 'expanding', 'original-auditing', 'auditing', 'illustrating'].includes(taskPhase)) {
    return taskPhase;
  }
  if (['planning', 'restoring', 'generating', 'outline-expanding', 'expanding', 'original-auditing', 'auditing', 'illustrating'].includes(runtimePhase)) {
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

function createTaskService({ aiService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, knowledgeBaseService, duplicateCheckService }) {
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

  function buildTechnicalPlanSnapshot(task, state = {}, eventPatch = {}) {
    const patch = { ...(eventPatch.technicalPlanPatch || {}) };
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = state?.[taskField] || task;
    }

    if (task.type === 'bid-analysis') {
      copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
      if (state.outlineData === null) {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, ['outlineMode', 'referenceKnowledgeDocumentIds']);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'global-facts-generation') {
      copyPatchFields(patch, state, ['globalFacts']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['contentGenerationRuntime']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'outlineData',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (hasOwn(eventPatch, 'outlineData')) {
      patch.outlineData = eventPatch.outlineData;
    }
    if (hasOwn(eventPatch, 'contentRuntime')) {
      patch.contentGenerationRuntime = eventPatch.contentRuntime;
    }

    const event = { technicalPlanPatch: patch };
    if (hasOwn(eventPatch, 'bidItem')) event.bidItem = eventPatch.bidItem;
    if (hasOwn(eventPatch, 'outlineData')) event.outlineData = eventPatch.outlineData;
    if (hasOwn(eventPatch, 'contentSection')) event.contentSection = eventPatch.contentSection;
    if (hasOwn(eventPatch, 'contentPlan')) event.contentPlan = eventPatch.contentPlan;
    if (hasOwn(eventPatch, 'contentRuntime')) event.contentRuntime = eventPatch.contentRuntime;
    return event;
  }

  function buildSnapshot(definition, state, task, eventPatch) {
    if (definition.stateKey === 'technicalPlan') {
      return buildTechnicalPlanSnapshot(task, state, eventPatch);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: state };
    }
    return {};
  }

  function getSnapshotForTask(task) {
    const definition = getTaskDefinition(task.type);
    if (definition.stateKey === 'technicalPlan') {
      return buildSnapshot(definition, technicalPlanStore.loadTechnicalPlan(), task);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: rejectionCheckStore.loadRejectionCheck() };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: duplicateCheckStore.loadDuplicateCheck() };
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
      return rejectionCheckStore.updateRejectionCheck(partial);
    }
    if (definition.stateKey === 'duplicateCheck') {
      return duplicateCheckStore.updateDuplicateCheck(partial);
    }
    return technicalPlanStore.updateTechnicalPlan(partial);
  }

  function loadWorkspaceState(definition) {
    if (definition.stateKey === 'technicalPlan') {
      return technicalPlanStore.loadTechnicalPlan();
    }
    if (definition.stateKey === 'rejectionCheck') {
      return rejectionCheckStore.loadRejectionCheck();
    }
    if (definition.stateKey === 'duplicateCheck') {
      return duplicateCheckStore.loadDuplicateCheck();
    }
    return technicalPlanStore.loadTechnicalPlan();
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
        emit(pausingTask, buildSnapshot(definition, state, pausingTask));
        return pausingTask;
      },
    };
    activeTaskControls.set(type, taskControl);

    const updateTask = (partial, workspaceState, eventPatch) => {
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
      if (workspaceState) {
        const persistedState = taskField ? updateWorkspaceState(definition, { [taskField]: currentTask }) : workspaceState;
        emit(currentTask, buildSnapshot(definition, persistedState, currentTask, eventPatch));
      }
      return currentTask;
    };

    const previousState = loadWorkspaceState(definition) || {};
    const state = updateWorkspaceState(definition, { ...initialPartial, [taskField]: currentTask });
    emit(currentTask, buildSnapshot(definition, state, currentTask));

    const runnerWorkspaceStore = definition.stateKey === 'technicalPlan'
      ? technicalPlanStore
      : definition.stateKey === 'rejectionCheck'
        ? rejectionCheckStore
        : duplicateCheckStore;
    runner({ aiService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, updateTask, payload, taskControl, previousState }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextState = updateWorkspaceState(definition, { [taskField]: failedTask });
      emit(failedTask, buildSnapshot(definition, nextState, failedTask));
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
    emit(pausedTask, buildSnapshot(getTaskDefinition('content-generation'), state, pausedTask));
  }

  function recoverInterruptedGlobalFactsTask() {
    if (activeTasks.has('global-facts-generation')) {
      return;
    }

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const globalFactsTask = technicalPlan.globalFactsTask;
    if (!isActiveTaskStatus(globalFactsTask?.status)) {
      return;
    }

    const message = '上次全局事实设定未完成，请重新解析';
    const recoveredTask = {
      ...globalFactsTask,
      status: 'error',
      progress: 100,
      error: message,
      logs: [...(Array.isArray(globalFactsTask.logs) ? globalFactsTask.logs : []), message],
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({ globalFactsTask: recoveredTask });
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-generation'), state, recoveredTask));
  }

  function recoverInterruptedRejectionCheckTasks() {
    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';
    const state = rejectionCheckStore.loadRejectionCheck() || {};
    const partial = {};

    if (!activeTasks.has('rejection-items-extraction') && state.extractionTask?.status === 'running') {
      partial.invalidBidAndRejectionItems = state.invalidBidAndRejectionItems?.status === 'running'
        ? { ...state.invalidBidAndRejectionItems, status: 'error', error: staleExtractionMessage, updatedAt: now() }
        : state.invalidBidAndRejectionItems;
      partial.extractionTask = {
        ...state.extractionTask,
        status: 'error',
        progress: 100,
        error: staleExtractionMessage,
        logs: [staleExtractionMessage],
        updated_at: now(),
      };
    }

    if (!activeTasks.has('rejection-check-run') && state.checkTask?.status === 'running') {
      const markResult = (result) => result?.status === 'running'
        ? { ...result, status: 'error', error: staleCheckMessage, progressMessage: staleCheckMessage, updatedAt: now() }
        : result;
      partial.rejectionCheckResult = markResult(state.rejectionCheckResult);
      partial.typoCheckResult = markResult(state.typoCheckResult);
      partial.logicCheckResult = markResult(state.logicCheckResult);
      partial.checkTask = {
        ...state.checkTask,
        status: 'error',
        progress: 100,
        error: staleCheckMessage,
        logs: [staleCheckMessage],
        updated_at: now(),
      };
    }

    if (Object.keys(partial).length) {
      rejectionCheckStore.updateRejectionCheck(partial);
    }
  }

  function recoverInterruptedDuplicateCheckTask() {
    if (activeTasks.has('duplicate-analysis')) {
      return;
    }
    const state = duplicateCheckStore.loadDuplicateCheck() || {};
    if (state.analysisTask?.status !== 'running') {
      return;
    }
    const message = '上次标书查重分析未完成，请重新分析';
    const markAnalysis = (analysis) => analysis?.status === 'running'
      ? { ...analysis, status: 'error', progress: 100, message, updated_at: now() }
      : analysis;
    const recoveredTask = {
      ...state.analysisTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const nextState = duplicateCheckStore.updateDuplicateCheck({
      analysisTask: recoveredTask,
      metadataAnalysis: markAnalysis(state.metadataAnalysis),
      outlineAnalysis: markAnalysis(state.outlineAnalysis),
      contentAnalysis: markAnalysis(state.contentAnalysis),
      imageAnalysis: markAnalysis(state.imageAnalysis),
    });
    emit(nextState.analysisTask || recoveredTask, { duplicateCheck: nextState });
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
      });
    },
    startGlobalFactsGeneration(payload) {
      return startManagedTask('global-facts-generation', payload, runGlobalFactsTask, {
        globalFacts: [],
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
      recoverInterruptedGlobalFactsTask();
      recoverInterruptedRejectionCheckTasks();
      recoverInterruptedDuplicateCheckTask();
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
