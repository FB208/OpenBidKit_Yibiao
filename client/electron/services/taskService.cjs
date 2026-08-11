const crypto = require('node:crypto');
const { runBidSectionExtractionTask } = require('./bidSectionExtractionTask.cjs');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask } = require('./contentGenerationTask.cjs');
const { runGlobalFactsTask } = require('./globalFactsTask.cjs');
const { runOutlineGenerationTaskV2 } = require('./outlineGenerationTaskV2.cjs');
const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');

const taskDefinitions = {
  'bid-section-extraction': {
    label: '多标段识别',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidSectionExtractionTask',
  },
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
  const tenderFiles = Array.isArray(payload.tenderFiles) ? payload.tenderFiles : [payload.tenderFile].filter(Boolean);
  const files = [...tenderFiles, ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
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

// 提取技术方案流程中由用户选择或填写的任务参数，不包含生成结果和正文缓存。
function createTechnicalPlanUserSettings(state = {}) {
  const settings = {};
  copyPatchFields(settings, state, [
    'workflowKind',
    'step',
    'tenderFile',
    'tenderFiles',
    'originalPlanFile',
    'bidAnalysisMode',
    'bidAnalysisSelectedTaskIds',
    'bidSectionMode',
    'outlineMode',
    'outlineExpansionMode',
    'outlineWordControlOptions',
    'outlineWordControlSnapshot',
    'referenceKnowledgeDocumentIds',
    'contentGenerationOptions',
  ]);
  return settings;
}

const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';

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
  return technicalPlan?.contentGenerationTask?.stats?.content?.phase
    || technicalPlan?.contentGenerationRuntime?.phase
    || 'planning';
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

function createTaskService({ aiService, agentService, autoConfirmationService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, knowledgeBaseService, duplicateCheckService }) {
  const subscribers = new Set();
  const callbackSubscribers = new Set();
  const activeTasks = new Map();
  const activeTaskControls = new Map();

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
    for (const callback of callbackSubscribers) {
      callback(event);
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
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'bid-section-extraction') {
      copyPatchFields(patch, state, [
        'bidSectionMode',
        'bidSections',
        'bidSectionExtractionStatus',
        'bidSectionExtractionError',
        'tenderFile',
        'bidAnalysisTask',
        'bidAnalysisTasks',
        'bidAnalysisProgress',
        'projectOverview',
        'techRequirements',
        'outlineData',
        'outlineWordControlSnapshot',
        'outlineGenerationTask',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFacts',
        'contentGenerationTask',
        'contentGenerationOptions',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentIllustrationPlan',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, [
        'outlineMode',
        'outlineExpansionMode',
        'outlineWordControlOptions',
        'outlineWordControlSnapshot',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFacts',
      ]);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
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
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentIllustrationPlan', 'contentGenerationRuntime']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'outlineData',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
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
      return { rejectionCheckPatch: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheckPatch: state };
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

  /**
   * 订阅 Main 进程中的任务事件，并返回取消订阅函数
   */
  function subscribeCallback(callback) {
    callbackSubscribers.add(callback);
    for (const task of activeTasks.values()) {
      callback({ task, ...getSnapshotForTask(task) });
    }
    return () => callbackSubscribers.delete(callback);
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

  function updateWorkspaceStateWithoutReload(definition, partial) {
    if (definition.stateKey === 'technicalPlan') {
      technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'rejectionCheck') {
      rejectionCheckStore.updateRejectionCheckWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'duplicateCheck') {
      duplicateCheckStore.updateDuplicateCheckWithoutReload(partial);
      return;
    }
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
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

  // 在 Agent 失败时采集父任务及其前置步骤的用户参数快照。
  function createAgentUserTaskContext(type, definition, payload, currentTask) {
    const workspaceState = loadWorkspaceState(definition) || {};
    return {
      managed_task: {
        type,
        label: definition.label || type,
        group: definition.group || '',
        group_label: definition.groupLabel || '',
        step: definition.step,
        state_key: definition.stateKey || '',
        payload,
        state: currentTask,
      },
      workflow_settings: definition.stateKey === 'technicalPlan'
        ? createTechnicalPlanUserSettings(workspaceState)
        : {},
    };
  }

  function startManagedTask(type, payload, runner, initialPartial = {}, startOptions = {}) {
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
    startOptions.beforeStart?.();

    const definition = getTaskDefinition(type);
    const task = startOptions.existingTask || createTask(type, payload);
    const queueScopeId = `${type}:${task.task_id}`;
    activeTasks.set(type, task);
    const taskField = getTaskField(type);
    let currentTask = task;
    const abortController = new AbortController();
    let resolveSettled;
    const settledPromise = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const taskControl = {
      queueScopeId,
      signal: abortController.signal,
      pauseRequested: false,
      outlineSelectionWaiter: null,
      outlineSelectionResult: null,
      outlineSelectionAutoConfirmationId: null,
      isPauseRequested() {
        return this.pauseRequested;
      },
      requestPause() {
        this.pauseRequested = true;
        const pausedLogs = currentTask.logs?.length
          ? currentTask.logs
          : ['已请求暂停，正在等待当前 AI 请求完成。'];
        return checkpointTask({ status: 'pausing', pause_requested: true, logs: pausedLogs }).task;
      },
      waitForOutlineSelection() {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason || new Error('目录生成任务已取消');
        }
        if (this.outlineSelectionResult) return Promise.resolve(this.outlineSelectionResult);
        if (this.outlineSelectionWaiter) {
          this.registerOutlineSelectionAutoConfirmation?.();
          return this.outlineSelectionWaiter.promise;
        }
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        promise.catch(() => undefined);
        this.outlineSelectionWaiter = { promise, resolve, reject };
        this.registerOutlineSelectionAutoConfirmation?.();
        return promise;
      },
      cancel(reason = '后台任务已取消') {
        const error = new Error(reason);
        error.code = 'TASK_CANCELLED';
        this.outlineSelectionWaiter?.reject?.(error);
        this.outlineSelectionWaiter = null;
        autoConfirmationService.unregister(this.outlineSelectionAutoConfirmationId);
        this.outlineSelectionAutoConfirmationId = null;
        if (!abortController.signal.aborted) abortController.abort(error);
      },
      waitForSettlement() {
        return settledPromise;
      },
      dispose() {
        this.outlineSelectionWaiter?.reject?.(new Error('目录生成任务已结束'));
        this.outlineSelectionWaiter = null;
        autoConfirmationService.unregister(this.outlineSelectionAutoConfirmationId);
        this.outlineSelectionAutoConfirmationId = null;
      },
    };
    activeTaskControls.set(type, taskControl);

    const updateTask = (partial, workspaceState, eventPatch, options = {}) => {
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
        if (taskField) {
          updateWorkspaceStateWithoutReload(definition, { [taskField]: currentTask });
        }
        emit(currentTask, buildSnapshot(definition, { ...workspaceState, [taskField]: currentTask }, currentTask, eventPatch));
      }
      return currentTask;
    };

    // 将业务状态和任务状态作为同一个 checkpoint 落库，并在提交后统一推送事件。
    const checkpointTask = (taskPartial, workspacePartial = {}, eventPatch) => {
      const nextTask = updateTask(taskPartial);
      const persistedPatch = {
        ...(workspacePartial || {}),
        [taskField]: nextTask,
      };
      updateWorkspaceStateWithoutReload(definition, persistedPatch);
      emit(nextTask, buildSnapshot(definition, persistedPatch, nextTask, eventPatch));
      return { task: nextTask };
    };

    // 为一级目录默认选择注册自动确认，并把截止时间同步到任务状态。
    taskControl.registerOutlineSelectionAutoConfirmation = () => {
      if (type !== 'outline-generation' || taskControl.outlineSelectionAutoConfirmationId) return;
      const selection = currentTask.stats?.outline_selection;
      if (!selection?.items?.length || !selection.selected_ids?.length || selection.confirmed) return;
      const confirmationId = `outline-selection:${currentTask.task_id}`;
      const defaultItems = selection.items;
      const defaultSelectedIds = selection.selected_ids;
      taskControl.outlineSelectionAutoConfirmationId = confirmationId;
      autoConfirmationService.register({
        id: confirmationId,
        submit: () => taskControl.confirmOutlineSelection({
          taskId: currentTask.task_id,
          items: defaultItems,
          selectedIds: defaultSelectedIds,
        }),
        onStateChange: ({ auto_answer_at: autoAnswerAt }) => {
          const currentSelection = currentTask.stats?.outline_selection;
          if (!currentSelection || currentSelection.confirmed) return;
          const nextSelection = { ...currentSelection };
          if (autoAnswerAt) nextSelection.auto_answer_at = autoAnswerAt;
          else delete nextSelection.auto_answer_at;
          currentTask = checkpointTask({
            stats: {
              ...(currentTask.stats || {}),
              outline_selection: nextSelection,
            },
          }).task;
        },
      });
    };

    taskControl.confirmOutlineSelection = (request = {}) => {
      if (type !== 'outline-generation' || request.taskId !== currentTask.task_id) {
        throw new Error('一级目录生成结果已变化，请重新打开后再选择');
      }
      const waiter = taskControl.outlineSelectionWaiter;
      if (!waiter) throw new Error('当前目录任务不在一级目录确认阶段');
      const items = Array.isArray(request.items) ? request.items : [];
      const selectedIds = Array.isArray(request.selectedIds) ? request.selectedIds : [];
      autoConfirmationService.unregister(taskControl.outlineSelectionAutoConfirmationId);
      taskControl.outlineSelectionAutoConfirmationId = null;
      const checkpoint = checkpointTask({
        stats: {
          ...(currentTask.stats || {}),
          outline_selection: {
            items,
            selected_ids: selectedIds,
            confirmed: true,
          },
        },
      });
      currentTask = checkpoint.task;
      taskControl.outlineSelectionWaiter = null;
      taskControl.outlineSelectionResult = { items, selectedIds };
      waiter.resolve(taskControl.outlineSelectionResult);
      return { success: true };
    };

    // 用户修改一级目录草稿后停止当前确认项的自动提交。
    taskControl.suppressOutlineSelectionAutoConfirmation = (request = {}) => {
      if (type !== 'outline-generation' || request.taskId !== currentTask.task_id) {
        return { success: true };
      }
      autoConfirmationService.suppress(taskControl.outlineSelectionAutoConfirmationId);
      return { success: true };
    };

    const previousState = loadWorkspaceState(definition) || {};
    const initialState = startOptions.skipInitialStateUpdate
      ? previousState
      : { ...initialPartial, [taskField]: currentTask };
    if (!startOptions.skipInitialStateUpdate) {
      updateWorkspaceStateWithoutReload(definition, initialState);
    }
    emit(currentTask, buildSnapshot(definition, initialState, currentTask));
    if (startOptions.restoreOutlineSelectionWaiter) {
      taskControl.waitForOutlineSelection();
    }

    const runnerWorkspaceStore = definition.stateKey === 'technicalPlan'
      ? technicalPlanStore
      : definition.stateKey === 'rejectionCheck'
        ? rejectionCheckStore
        : duplicateCheckStore;
    const runnerAiService = aiService?.withQueueScope ? aiService.withQueueScope(queueScopeId) : aiService;
    const runnerAgentService = agentService.bindTaskContext(
      () => createAgentUserTaskContext(type, definition, payload, currentTask),
      { queueScopeId },
    );
    runner({ aiService: runnerAiService, agentService: runnerAgentService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, updateTask, checkpointTask, payload, taskControl, previousState }).catch((error) => {
      checkpointTask({ status: 'error', error: error.message || '任务执行失败' });
    }).finally(() => {
      taskControl.dispose();
      if (aiService?.resumeQueueScope) {
        aiService.resumeQueueScope(queueScopeId);
      }
      activeTasks.delete(type);
      activeTaskControls.delete(type);
      resolveSettled();
    });

    return currentTask;
  }

  // 取消目录生成并等待其异步清理完成，避免重置后旧任务重新写回状态。
  async function cancelOutlineGenerationForReset() {
    const task = activeTasks.get('outline-generation');
    const control = activeTaskControls.get('outline-generation');
    if (!task || !isActiveTaskStatus(task.status) || !control?.cancel) return;
    control.cancel('技术方案已重置，目录生成任务已取消');
    await control.waitForSettlement();
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
    const partial = {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationTask: pausedTask,
      contentGenerationRuntime: {
        ...(normalizedPlan.contentGenerationRuntime || {}),
        phase,
        updated_at: now(),
      },
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(pausedTask, buildSnapshot(getTaskDefinition('content-generation'), partial, pausedTask));
  }

  function recoverInterruptedOutlineGenerationTask() {
    if (activeTasks.has('outline-generation')) {
      return;
    }

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const outlineTask = technicalPlan.outlineGenerationTask;
    if (!isActiveTaskStatus(outlineTask?.status)) {
      return;
    }

    const agentState = outlineTask.stats?.agent || {};
    let persistentTask = null;
    try {
      persistentTask = agentService.loadPersistentTask(OUTLINE_AGENT_TASK_KEY);
    } catch {}
    const recoverableWaiting = persistentTask?.state?.run_id === outlineTask.task_id
      && persistentTask.state.status === 'waiting-outline-selection'
      && persistentTask.state.phase === 'outline-selection'
      && persistentTask.state.agent_connection === 'idle'
      && Boolean(persistentTask.state.session_file)
      && agentService.hasPersistentTaskSession(OUTLINE_AGENT_TASK_KEY)
      && Boolean(outlineTask.stats?.outline_selection?.items?.length)
      && outlineTask.stats.outline_selection.confirmed !== true;
    if (recoverableWaiting) {
      startManagedTask('outline-generation', {
        ...(agentState.resume_payload || {}),
        agent_resume: {
          phase: 'outline-selection',
        },
      }, runOutlineGenerationTaskV2, {}, {
        existingTask: outlineTask,
        skipInitialStateUpdate: true,
        restoreOutlineSelectionWaiter: true,
      });
      return;
    }

    const message = '上次目录生成未完成，请重新生成目录。';
    if (persistentTask) {
      try {
        agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    const recoveredStats = { ...(outlineTask.stats || {}) };
    delete recoveredStats.outline_selection;
    if (recoveredStats.agent) {
      recoveredStats.agent = {
        ...recoveredStats.agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    const recoveredTask = {
      ...outlineTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(outlineTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(outlineTask.logs) ? outlineTask.logs : []), message],
      stats: recoveredStats,
      updated_at: now(),
    };
    const partial = { outlineGenerationTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-generation'), partial, recoveredTask));
  }

  function recoverInterruptedBidAnalysisTask() {
    if (activeTasks.has('bid-analysis')) {
      return;
    }

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const bidAnalysisTask = technicalPlan.bidAnalysisTask;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) {
      return;
    }

    const message = '上次招标文件解析未完成，请重新解析';
    const nextBidAnalysisTasks = {};
    let hasInterruptedItem = false;
    for (const [itemId, item] of Object.entries(technicalPlan.bidAnalysisTasks || {})) {
      if (item?.status === 'running') {
        nextBidAnalysisTasks[itemId] = {
          ...item,
          status: 'error',
          error: message,
        };
        hasInterruptedItem = true;
      } else {
        nextBidAnalysisTasks[itemId] = item;
      }
    }

    const logs = Array.isArray(bidAnalysisTask.logs) ? bidAnalysisTask.logs : [];
    const recoveredTask = {
      ...bidAnalysisTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: logs.includes(message) ? logs : [...logs, message],
      updated_at: now(),
    };
    const partial = hasInterruptedItem
      ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: nextBidAnalysisTasks }
      : { bidAnalysisTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-analysis'), partial, recoveredTask));
  }

  function recoverInterruptedBidSectionExtractionTask() {
    if (activeTasks.has('bid-section-extraction')) {
      return;
    }

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const extractionTask = technicalPlan.bidSectionExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const message = '上次多标段识别未完成，请重新识别';
    const recoveredTask = {
      ...extractionTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(extractionTask.logs) ? extractionTask.logs : []), message],
      updated_at: now(),
    };
    const partial = {
      bidSectionExtractionTask: recoveredTask,
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-section-extraction'), partial, recoveredTask));
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
    const partial = { globalFactsTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-generation'), partial, recoveredTask));
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
      rejectionCheckStore.updateRejectionCheckWithoutReload(partial);
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
    const partial = {
      analysisTask: recoveredTask,
      metadataAnalysis: markAnalysis(state.metadataAnalysis),
      outlineAnalysis: markAnalysis(state.outlineAnalysis),
      contentAnalysis: markAnalysis(state.contentAnalysis),
      imageAnalysis: markAnalysis(state.imageAnalysis),
    };
    duplicateCheckStore.updateDuplicateCheckWithoutReload(partial);
    emit(recoveredTask, { duplicateCheckPatch: partial });
  }

  recoverInterruptedBidSectionExtractionTask();
  recoverInterruptedBidAnalysisTask();
  recoverInterruptedOutlineGenerationTask();
  recoverInterruptedContentGenerationTask();
  recoverInterruptedGlobalFactsTask();
  recoverInterruptedRejectionCheckTasks();
  recoverInterruptedDuplicateCheckTask();

  return {
    subscribe,
    subscribeCallback,
    startBidSectionExtraction(payload) {
      return startManagedTask('bid-section-extraction', payload, runBidSectionExtractionTask, {
        bidSectionMode: 'multiple',
        bidSections: [],
        bidSectionExtractionStatus: 'running',
        bidSectionExtractionError: undefined,
        bidAnalysisTask: undefined,
        bidAnalysisTasks: {},
        bidAnalysisProgress: 0,
        projectOverview: '',
        techRequirements: '',
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineGenerationTask: undefined,
        referenceKnowledgeDocumentIds: [],
        globalFactsTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationOptions: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      });
    },
    startBidAnalysis(payload) {
      return startManagedTask('bid-analysis', payload, runBidAnalysisTask);
    },
    startOutlineGeneration(payload) {
      const outlineMode = payload?.outline_mode === 'response-file' ? 'response-file' : 'aligned';
      const taskPayload = { ...payload, outline_mode: outlineMode };
      return startManagedTask('outline-generation', taskPayload, runOutlineGenerationTaskV2, {
        outlineMode,
        outlineExpansionMode: payload?.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
        outlineWordControlOptions: payload?.word_control_options,
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids) ? payload.reference_knowledge_document_ids : [],
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        globalFactsTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      }, {
        beforeStart: () => agentService.deletePersistentTask(OUTLINE_AGENT_TASK_KEY),
      });
    },
    startGlobalFactsGeneration(payload) {
      return startManagedTask('global-facts-generation', payload, runGlobalFactsTask, {
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      });
    },
    startContentGeneration(payload) {
      const technicalPlan = technicalPlanStore.loadTechnicalPlan();
      if (!technicalPlan.outlineWordControlSnapshot) {
        throw new Error('当前目录没有字数控制生效快照，请重新生成目录');
      }
      return startManagedTask('content-generation', payload, runContentGenerationTask);
    },
    pauseContentGeneration() {
      const task = activeTasks.get('content-generation');
      const control = activeTaskControls.get('content-generation');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && aiService?.pauseQueueScope) {
          aiService.pauseQueueScope(control.queueScopeId);
        }
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
    confirmOutlineSelection(payload) {
      const control = activeTaskControls.get('outline-generation');
      if (!control?.confirmOutlineSelection) throw new Error('当前没有等待确认的一级目录任务');
      return control.confirmOutlineSelection(payload);
    },
    suppressOutlineSelectionAutoConfirmation(payload) {
      const control = activeTaskControls.get('outline-generation');
      if (!control?.suppressOutlineSelectionAutoConfirmation) return { success: true };
      return control.suppressOutlineSelectionAutoConfirmation(payload);
    },
    async resetTechnicalPlan() {
      await cancelOutlineGenerationForReset();
      return technicalPlanStore.clearTechnicalPlan();
    },
    getActiveTasks() {
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
