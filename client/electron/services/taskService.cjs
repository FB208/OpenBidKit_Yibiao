const crypto = require('node:crypto');
const { runBidSectionExtractionTask } = require('./bidSectionExtractionTask.cjs');
const { detectBidSectionMode } = require('./bidSectionModeDetection.cjs');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask, prepareContentGenerationStart } = require('./contentGenerationTask.cjs');
const { runGlobalFactsTaskV2 } = require('./globalFactsTaskV2.cjs');
const { runOutlineGenerationTaskV2 } = require('./outlineGenerationTaskV2.cjs');
const { runOutlineAdjustmentTask } = require('./outlineAdjustmentTask.cjs');
const { runBidTemplateExtractionTask } = require('./bidTemplateExtractionTask.cjs');
const { hasRulePageChapters, runRulePageCompileTask } = require('./rulePageCompileTask.cjs');
const { runGlobalFactsAdjustmentTask } = require('./globalFactsAdjustmentTask.cjs');
const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, RULE_PAGE_AGENT_TASK_KEY } = require('./businessTemplateFillAgentConfig.cjs');
const { loadBusinessFillReview, editBusinessFillValues } = require('./businessTemplateFillTask.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');
const { runBlindCheckTask } = require('./blindCheckTask.cjs');
const { runBlindCheckFixTask } = require('./blindCheckFixTask.cjs');
const { BLIND_CHECK_AGENT_TASK_KEY } = require('./blindCheckAgent.cjs');
const { runBlindCheckPresetExtractionTask } = require('./blindCheckPresetExtractionTask.cjs');
const {
  clearContent,
  runFeasibilityAnalysisTask,
  runFeasibilityParametersTask,
  runFeasibilityContentTask,
  runFeasibilityHumanWritingTask,
} = require('./feasibilityReportTasks.cjs');
const { runFeasibilityOutlineTask } = require('./feasibilityOutlineTask.cjs');
const { runFeasibilityOutlineAdjustmentTask } = require('./feasibilityOutlineAdjustmentTask.cjs');
const { normalizeLogs } = require('./taskLogStore.cjs');
const { runBidDocumentAdjustmentTask } = require('./bidDocumentAdjustmentTask.cjs');
const { readExportFailure } = require('./bidDocumentExportFailure.cjs');
const { runContentSectionRegenerationTask } = require('./contentSectionRegenerationTask.cjs');

const taskDefinitions = {
  'bid-document-adjustment': {
    label: '投标文件AI调整', group: 'technical-plan', groupLabel: '技术方案',
    step: 5, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'bidDocumentAdjustmentTask',
  },
  'bid-section-extraction': {
    label: '标段识别',
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
  'outline-adjustment': {
    label: '目录AI调整',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineAdjustmentTask',
  },
  'bid-template-extraction': {
    label: '投标模版提取',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidTemplateExtractionTask',
  },
  'rule-page-compile': {
    label: '规则和页码编制',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'rulePageCompileTask',
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
  'global-facts-adjustment': {
    label: '全局事实AI调整',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsAdjustmentTask',
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
  'blind-check-run': {
    label: '暗标合规检查',
    group: 'blind-check',
    groupLabel: '暗标合规检查',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'blindCheck',
    field: 'checkTask',
  },
  'blind-check-fix': {
    label: '暗标自动修复',
    group: 'blind-check',
    groupLabel: '暗标合规检查',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'blindCheck',
    field: 'fixTask',
  },
  'blind-check-preset-extraction': {
    label: '暗标格式要求提取',
    group: 'blind-check',
    groupLabel: '暗标合规检查',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'blindCheck',
    field: 'extractionTask',
  },
  'feasibility-analysis': {
    label: '可研项目资料分析',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'analysisTask',
  },
  'feasibility-outline': {
    label: '可研报告目录生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'outlineTask',
  },
  'feasibility-outline-adjustment': {
    label: '可研报告目录AI调整',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'outlineAdjustmentTask',
  },
  'feasibility-parameters': {
    label: '可研关键参数生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'parametersTask',
  },
  'feasibility-content': {
    label: '可研报告正文生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'contentTask',
  },
  'feasibility-human-writing': {
    label: '可研自然化审校',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'humanWritingTask',
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
    'step',
    'tenderFile',
    'tenderFiles',
    'originalPlanFile',
    'bidAnalysisMode',
    'bidAnalysisSelectedTaskIds',
    'bidSectionMode',
    'bidSectionAutoEnabled',
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

// 未成功或尚无确认字数的 AI 叶子仍待正文任务生成。
function collectPendingSectionIds(technicalPlan, items = technicalPlan.outlineData?.outline || []) {
  return items.flatMap(item => item.children?.length ? collectPendingSectionIds(technicalPlan, item.children)
    : item.content_mode === 'ai-generate'
      && (technicalPlan.contentGenerationSections?.[item.id]?.status !== 'success'
        || !Object.hasOwn(technicalPlan.contentGenerationRuntime?.section_words || {}, item.id)) ? [item.id] : []);
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

// 依赖待检文档的暗标任务；从招标文件提取预设与待检文档无关，换文档时不取消。
const BLIND_CHECK_DOCUMENT_TASK_TYPES = ['blind-check-run', 'blind-check-fix'];

function createTaskService({ app, technicalPlanExport, templateStore, aiService, agentService, autoConfirmationService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, blindCheckStore, feasibilityReportStore, knowledgeBaseService, duplicateCheckService, openXmlHelperService, credentialLibraryService }) {
  const subscribers = new Set();
  const callbackSubscribers = new Set();
  const activeTasks = new Map();
  const activeTaskControls = new Map();
  let exportOccupied = false;
  let pendingBidAnalysis = null; // 多标段待选时保留本次解析请求，页面离开不影响。

  // 正式导出与后台写任务双向互斥；内部转换复核不重复申请占用。
  function beginTechnicalPlanExport() {
    if (exportOccupied) throw new Error('投标文件正在导出');
    const busy = [...activeTasks.values()].find(task => task.group === 'technical-plan' && isActiveTaskStatus(task.status));
    if (busy || technicalPlanStore.loadTechnicalPlan().contentGenerationTask?.status === 'paused') {
      throw new Error('当前投标任务未结束，请完成后再导出');
    }
    exportOccupied = true;
    let released = false;
    return () => { if (!released) { released = true; exportOccupied = false; } };
  }

  // 人工写入也使用同一互斥状态，不影响调整 runner 自己的 Store 提交。
  function assertDocumentMutationIdle() {
    if (exportOccupied || isActiveTaskStatus(activeTasks.get('bid-document-adjustment')?.status)) {
      throw new Error('投标文件正在调整或导出，请完成后再操作');
    }
  }

  function findBusyTechnicalPlanTask() {
    return [...activeTasks.values()].find(task => task.group === 'technical-plan' && isActiveTaskStatus(task.status));
  }

  // 启用前正文须由正文任务完整生成：新增或未完成的小节仍交给正文会话增量生成。
  function getDocumentAdjustmentEnableBlocker() {
    if (exportOccupied) return '投标文件正在导出，请完成后再启用 AI 调整';
    const busy = findBusyTechnicalPlanTask();
    if (busy) return `${getTaskDefinition(busy.type).label}任务执行中，请等待完成`;
    const plan = technicalPlanStore.loadTechnicalPlan();
    if (!plan.outlineData?.outline?.length) return '当前没有可调整的投标文件';
    if (plan.contentGenerationTask?.status !== 'success') return '请先完成正文生成，再启用 AI 调整';
    if (collectPendingSectionIds(plan).length) return '有新增或未完成的小节，请先点击“继续生成正文”';
    return '';
  }

  // 启用后正文任务不再运行，调整只受导出和其他技术方案任务互斥。
  function getDocumentAdjustmentBlocker() {
    if (!technicalPlanStore.isDocumentAdjustmentEnabled()) return '请先在正文页点击“AI调整”并确认启用';
    if (exportOccupied) return '投标文件正在导出，请完成后再调整';
    const busy = findBusyTechnicalPlanTask();
    if (busy) return `${getTaskDefinition(busy.type).label}任务执行中，请等待完成`;
    if (!technicalPlanStore.loadTechnicalPlan().outlineData?.outline?.length) return '当前没有可调整的投标文件';
    return '';
  }

  // 正文页“重新编制”与调整后的自动重新编制共用；正文任务运行或暂停时不允许，避免与正文副流程同时写模版。
  function startRulePageCompile(payload) {
    const contentStatus = technicalPlanStore.loadTechnicalPlan().contentGenerationTask?.status;
    if (isActiveTaskStatus(contentStatus) || contentStatus === 'paused') {
      throw new Error('正文任务未结束，请完成或重置后再重新编制');
    }
    return startManagedTask('rule-page-compile', payload, runRulePageCompileTask, {}, { primarySession: true });
  }

  // AI 调整改变目录结构后规则和页码已失效，调整结束后自动重新编制；启动失败保持待编制，可手动“重新编制”。
  function recompileRulePageAfterAdjustment() {
    const plan = technicalPlanStore.loadTechnicalPlan();
    if (!plan.bidDocumentAdjustmentTask?.stats?.adjustment?.rule_page_recompile) return;
    if (!hasRulePageChapters(technicalPlanStore, plan.outlineData?.outline)) return;
    try {
      startRulePageCompile();
    } catch (error) {
      console.error('[task-service] 调整后重新编制规则和页码启动失败:', error);
    }
  }

  // 每条要求单独登记受管任务，底层持久 Session 持续复用。
  function startBidDocumentAdjustment(payload) {
    if (isActiveTaskStatus(activeTasks.get('bid-document-adjustment')?.status)) throw new Error('上一条调整要求正在处理中');
    if (payload.resume) {
      const previous = technicalPlanStore.readDocumentAdjustmentTask()?.stats?.adjustment;
      if (!previous) throw new Error('没有可继续的调整任务');
      payload = { origin: previous.origin, requirement: previous.requirement, sectionIds: previous.section_ids,
        failureId: previous.failure_id, exportOptions: previous.export_options };
    }
    const blocker = getDocumentAdjustmentBlocker();
    if (blocker) throw new Error(blocker);
    return startManagedTask('bid-document-adjustment', payload, runBidDocumentAdjustmentTask, {}, {
      primarySession: true, afterSettled: recompileRulePageAfterAdjustment,
    });
  }

  // 用户确认后启用 AI 调整；导出失败时确认启用的同时开始修复这次失败。
  function enableDocumentAdjustment({ exportFailureId } = {}) {
    const blocker = getDocumentAdjustmentEnableBlocker();
    if (blocker) throw new Error(blocker);
    technicalPlanStore.enableDocumentAdjustment();
    if (exportFailureId) {
      const { snapshot } = readExportFailure(app, exportFailureId);
      startBidDocumentAdjustment({ origin: 'export', failureId: exportFailureId,
        exportOptions: { exportFormat: snapshot.export_format, exportTemplateScope: snapshot.export_template_scope } });
    }
    return technicalPlanStore.loadTechnicalPlan();
  }

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
    patch.bidDocumentAdjustmentTask = technicalPlanStore.readDocumentAdjustmentTask();
    patch.documentAdjustmentEnabled = technicalPlanStore.isDocumentAdjustmentEnabled();
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = task || state?.[taskField];
    }

    if (task.type === 'bid-analysis') {
      copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
      if (state.outlineData === null) {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'bid-section-extraction') {
      copyPatchFields(patch, state, [
        'bidSectionMode',
        'bidSectionAutoMode',
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
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, [
        'outlineWordControlSnapshot',
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'bidTemplateExists',
      ]);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'global-facts-generation') {
      copyPatchFields(patch, state, ['globalFacts', 'globalFactsAdjustmentTask']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'global-facts-adjustment') {
      copyPatchFields(patch, state, ['globalFacts']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'rule-page-compile') {
      copyPatchFields(patch, state, ['contentGenerationRuntime']);
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentGenerationRuntime']);
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

  function buildFeasibilityReportSnapshot(task, state = {}) {
    const patch = {};
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = state?.[taskField] || task;
    }
    copyPatchFields(patch, state, [
      'step',
      'projectInfo',
      'sourceFiles',
      'analysisMarkdown',
      'outlineTemplate',
      'targetWords',
      'referenceDocumentIds',
      'keyParametersMarkdown',
      'outlineData',
      'analysisTask',
      'outlineTask',
      'outlineAdjustmentTask',
      'parametersTask',
      'contentTask',
      'humanWritingTask',
    ]);
    return { feasibilityReportPatch: patch };
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
    if (definition.stateKey === 'blindCheck') {
      return { blindCheckPatch: state };
    }
    if (definition.stateKey === 'feasibilityReport') {
      return buildFeasibilityReportSnapshot(task, state, eventPatch);
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
    if (definition.stateKey === 'blindCheck') {
      return { blindCheck: blindCheckStore.loadBlindCheck() };
    }
    if (definition.stateKey === 'feasibilityReport') {
      return buildSnapshot(definition, feasibilityReportStore.loadFeasibilityReport(), task);
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
    if (getTaskDefinition(type).group === 'technical-plan' && exportOccupied) throw new Error('投标文件正在导出，请完成后再启动任务');
    const conflict = getActiveTaskConflict(type, payload);
    if (!conflict) {
      const definition = getTaskDefinition(type);
      if (definition.group === 'technical-plan') {
        const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
        const pausedContentTask = technicalPlan.contentGenerationTask;
        if (pausedContentTask?.status === 'paused') {
          const developerRestart = type === 'content-generation'
            && payload?.developerRestart
            && Boolean(aiService?.isDeveloperMode?.());
          if (type === 'content-generation' && (payload?.resume || developerRestart)) {
            return;
          }
          throw new Error('正文生成已暂停，请先继续当前正文生成任务或重置技术方案后再启动新的任务。');
        }
      }
      if (definition.group === 'feasibility-report' && feasibilityReportStore) {
        const report = feasibilityReportStore.loadFeasibilityReport() || {};
        if (report.contentTask?.status === 'paused') {
          if (type === 'feasibility-content' && (payload?.resume || payload?.onlyMissing)) {
            return;
          }
          throw new Error('可研正文生成已暂停，请先继续当前正文生成或重置可研后再启动新的任务。');
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
    if (definition.stateKey === 'blindCheck') {
      blindCheckStore.updateBlindCheckWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'feasibilityReport') {
      feasibilityReportStore.updateFeasibilityReportWithoutReload(partial);
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
    if (definition.stateKey === 'blindCheck') {
      return blindCheckStore.loadBlindCheck();
    }
    if (definition.stateKey === 'feasibilityReport') {
      return feasibilityReportStore.loadFeasibilityReport();
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
      businessFillReviewWaiter: null,
      businessFillReviewAutoConfirmationId: null,
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
      // 商务模版字段值确认：signal 中止（暂停）时拒绝等待并注销自动确认，自动确认以 null 提交表示保留已存值。
      waitForBusinessFillReview({ signal, onAutoAnswerAtChange } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        this.releaseBusinessFillReview();
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        promise.catch(() => undefined);
        const onAbort = () => this.releaseBusinessFillReview(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        this.businessFillReviewWaiter = {
          resolve: (value) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        };
        const confirmationId = `business-fill-review:${currentTask.task_id}`;
        this.businessFillReviewAutoConfirmationId = confirmationId;
        autoConfirmationService.register({
          id: confirmationId,
          submit: () => this.confirmBusinessFillReview({ taskId: currentTask.task_id, values: null }),
          onStateChange: ({ auto_answer_at: autoAnswerAt }) => onAutoAnswerAtChange?.(autoAnswerAt || null),
        });
        return promise;
      },
      releaseBusinessFillReview(error) {
        const waiter = this.businessFillReviewWaiter;
        this.businessFillReviewWaiter = null;
        autoConfirmationService.unregister(this.businessFillReviewAutoConfirmationId);
        this.businessFillReviewAutoConfirmationId = null;
        if (waiter && error) waiter.reject(error);
        return waiter;
      },
      confirmBusinessFillReview(request = {}) {
        if (type !== 'content-generation' || request.taskId !== currentTask.task_id) {
          throw new Error('正文任务已变化，请重新打开后再确认');
        }
        const waiter = this.releaseBusinessFillReview();
        if (!waiter) throw new Error('当前正文任务不在商务模版确认阶段');
        waiter.resolve(Array.isArray(request.values) ? { values: request.values } : null);
        return { success: true };
      },
      // 用户修改字段值后停止本次自动确认。
      suppressBusinessFillReviewAutoConfirmation(request = {}) {
        if (type === 'content-generation' && request.taskId === currentTask.task_id) {
          autoConfirmationService.suppress(this.businessFillReviewAutoConfirmationId);
        }
        return { success: true };
      },
      cancel(reason = '后台任务已取消') {
        const error = new Error(reason);
        error.code = 'TASK_CANCELLED';
        this.outlineSelectionWaiter?.reject?.(error);
        this.outlineSelectionWaiter = null;
        autoConfirmationService.unregister(this.outlineSelectionAutoConfirmationId);
        this.outlineSelectionAutoConfirmationId = null;
        this.releaseBusinessFillReview(error);
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
        this.releaseBusinessFillReview(new Error('正文任务已结束'));
      },
    };
    activeTaskControls.set(type, taskControl);

    const applyTaskPatch = (partial) => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running'
        ? 'pausing'
        : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || partial.pause_requested,
        logs: partial.logs ? normalizeLogs(partial.logs) : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(type, currentTask);
      return currentTask;
    };

    // 仅更新内存并推送 Renderer，用于无恢复价值的高频展示状态。
    const updateTask = (partial, workspaceState = {}, eventPatch) => {
      const nextTask = applyTaskPatch(partial);
      emit(nextTask, buildSnapshot(definition, { ...(workspaceState || {}), [taskField]: nextTask }, nextTask, eventPatch));
      return nextTask;
    };

    // 将业务状态和任务状态作为同一个 checkpoint 落库，并在提交后统一推送事件。
    const checkpointTask = (taskPartial, workspacePartial = {}, eventPatch) => {
      if (taskControl.signal.aborted) {
        throw taskControl.signal.reason || new Error('后台任务已取消');
      }
      const nextTask = applyTaskPatch(taskPartial);
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
        : definition.stateKey === 'feasibilityReport'
          ? feasibilityReportStore
          : definition.stateKey === 'blindCheck'
            ? blindCheckStore
            : duplicateCheckStore;
    const runnerAiService = aiService?.withQueueScope ? aiService.withQueueScope(queueScopeId, taskControl.signal) : aiService;
    const agentTaskContextProvider = () => createAgentUserTaskContext(type, definition, payload, currentTask);
    const runnerAgentService = agentService.bindTaskContext(
      agentTaskContextProvider,
      {
        queueScopeId,
        signal: taskControl.signal,
        primary_session: startOptions.primarySession === true,
      },
    );
    const runnerOrdinaryAgentService = agentService.bindTaskContext(
      agentTaskContextProvider,
      {
        queueScopeId,
        signal: taskControl.signal,
      },
    );
    runner({ app, technicalPlanExport, templateStore, aiService: runnerAiService, agentService: runnerAgentService, ordinaryAgentService: runnerOrdinaryAgentService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, openXmlHelperService, credentialLibraryService, updateTask, checkpointTask, payload, taskControl, previousState }).catch((error) => {
      if (!taskControl.signal.aborted) {
        checkpointTask({ status: 'error', error: error.message || '任务执行失败' });
      }
    }).finally(() => {
      const aborted = taskControl.signal.aborted;
      taskControl.dispose();
      if (aiService?.resumeQueueScope) {
        aiService.resumeQueueScope(queueScopeId);
      }
      if (activeTasks.get(type) === currentTask) activeTasks.delete(type);
      if (activeTaskControls.get(type) === taskControl) activeTaskControls.delete(type);
      resolveSettled();
      // 后续任务在本任务移出活动列表后启动；取消（如重置）时不衔接。
      if (!aborted) startOptions.afterSettled?.();
    });

    return currentTask;
  }

  // 取消技术方案任务并等待退出；替换原文或全流程重置也清除待选段解析。
  async function cancelTechnicalPlanTasks(reason, taskTypes) {
    if (exportOccupied) throw new Error('投标文件正在导出，请完成后再操作');
    const typeFilter = Array.isArray(taskTypes) && taskTypes.length ? new Set(taskTypes) : null;
    const controls = [];
    for (const [type, task] of activeTasks.entries()) {
      const definition = getTaskDefinition(type);
      const control = activeTaskControls.get(type);
      if (definition.group !== 'technical-plan' || !isActiveTaskStatus(task.status) || !control?.cancel) continue;
      if (typeFilter && !typeFilter.has(type)) continue;
      controls.push(control);
      control.cancel(reason);
    }
    await Promise.all(controls.map((control) => control.waitForSettlement()));
    if (!typeFilter) pendingBidAnalysis = null;
  }

  // 取消废标检查任务并等待退出，避免清空下游后旧任务继续提交 checkpoint。
  async function cancelRejectionCheckTasks(reason, taskTypes) {
    const typeFilter = Array.isArray(taskTypes) && taskTypes.length ? new Set(taskTypes) : null;
    const controls = [];
    for (const [type, task] of activeTasks.entries()) {
      const definition = getTaskDefinition(type);
      const control = activeTaskControls.get(type);
      if (definition.group !== 'rejection-check' || !isActiveTaskStatus(task.status) || !control?.cancel) continue;
      if (typeFilter && !typeFilter.has(type)) continue;
      controls.push(control);
      control.cancel(reason);
    }
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  // 取消暗标检查任务并等待助手进程退出，再替换或清空待检文档；taskTypes 为空时取消整组。
  async function cancelBlindCheckTasks(reason, taskTypes) {
    const typeFilter = Array.isArray(taskTypes) && taskTypes.length ? new Set(taskTypes) : null;
    const controls = [];
    for (const [type, task] of activeTasks.entries()) {
      const control = activeTaskControls.get(type);
      if (getTaskDefinition(type).group !== 'blind-check' || !isActiveTaskStatus(task.status) || !control?.cancel) continue;
      if (typeFilter && !typeFilter.has(type)) continue;
      controls.push(control);
      control.cancel(reason);
    }
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  async function cancelFeasibilityReportTasks(reason, taskTypes) {
    const typeFilter = Array.isArray(taskTypes) && taskTypes.length ? new Set(taskTypes) : null;
    const controls = [];
    for (const [type, task] of activeTasks.entries()) {
      const definition = getTaskDefinition(type);
      const control = activeTaskControls.get(type);
      if (definition.group !== 'feasibility-report' || !isActiveTaskStatus(task.status) || !control?.cancel) continue;
      if (typeFilter && !typeFilter.has(type)) continue;
      controls.push(control);
      control.cancel(reason);
    }
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  function recoverInterruptedContentGenerationTask(technicalPlan) {
    if (activeTasks.has('content-generation')) {
      return;
    }

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

  function recoverInterruptedOutlineGenerationTask(technicalPlan) {
    if (activeTasks.has('outline-generation')) {
      return;
    }

    const outlineTask = technicalPlan.outlineGenerationTask;
    if (!isActiveTaskStatus(outlineTask?.status)) {
      return;
    }

    const agentState = outlineTask.stats?.agent || {};
    let persistentTask = null;
    let templatePersistentTask = null;
    try {
      persistentTask = agentService.loadPersistentTask(OUTLINE_AGENT_TASK_KEY);
    } catch {}
    try {
      templatePersistentTask = agentService.loadPersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
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
        primarySession: agentService.isPrimarySession({ task_key: OUTLINE_AGENT_TASK_KEY }),
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
    if (templatePersistentTask) {
      try {
        agentService.updatePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY, {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    try { technicalPlanStore.clearBidTemplate(); } catch {}
    const recoveredStats = { ...(outlineTask.stats || {}) };
    delete recoveredStats.outline_selection;
    if (recoveredStats.agent) {
      recoveredStats.agent = {
        ...recoveredStats.agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    if (recoveredStats.template_agent) {
      recoveredStats.template_agent = {
        ...recoveredStats.template_agent,
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

  function recoverInterruptedOutlineAdjustmentTask(technicalPlan) {
    if (activeTasks.has('outline-adjustment')) {
      return;
    }

    const adjustmentTask = technicalPlan.outlineAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { outlineAdjustmentTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-adjustment'), partial, recoveredTask));
  }

  function recoverInterruptedBidTemplateExtractionTask(technicalPlan) {
    if (activeTasks.has('bid-template-extraction')) {
      return;
    }

    const extractionTask = technicalPlan.bidTemplateExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const message = '上次投标模版提取未完成，请在目录页点击“下一步”重新提取。';
    const recoveredTask = {
      ...extractionTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(extractionTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(extractionTask.logs) ? extractionTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { bidTemplateExtractionTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-template-extraction'), partial, recoveredTask));
  }

  // 重新编制中断后记为失败，编制状态记为中断，正文页可再次重新编制。
  function recoverInterruptedRulePageCompileTask(technicalPlan) {
    if (activeTasks.has('rule-page-compile')) {
      return;
    }

    const compileTask = technicalPlan.rulePageCompileTask;
    if (!isActiveTaskStatus(compileTask?.status)) {
      return;
    }

    const message = '上次规则和页码编制未完成，请在正文页重新编制。';
    const recoveredTask = {
      ...compileTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(compileTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(compileTask.logs) ? compileTask.logs : []), message],
      updated_at: now(),
    };
    const runtime = technicalPlan.contentGenerationRuntime;
    const partial = {
      rulePageCompileTask: recoveredTask,
      ...(runtime?.rule_page ? { contentGenerationRuntime: { ...runtime, rule_page: { ...runtime.rule_page, status: 'interrupted', error: null } } } : {}),
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('rule-page-compile'), partial, recoveredTask));
  }

  function recoverInterruptedGlobalFactsAdjustmentTask(technicalPlan) {
    if (activeTasks.has('global-facts-adjustment')) {
      return;
    }

    const adjustmentTask = technicalPlan.globalFactsAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次全局事实 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { globalFactsAdjustmentTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-adjustment'), partial, recoveredTask));
  }

  function recoverInterruptedBidAnalysisTask(technicalPlan) {
    if (activeTasks.has('bid-analysis')) {
      return;
    }

    const bidAnalysisTask = technicalPlan.bidAnalysisTask;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) {
      return;
    }

    const message = '上次招标文件解析未完成，请重新解析';
    const interruptedBidAnalysisTasks = {};
    for (const [itemId, item] of Object.entries(technicalPlan.bidAnalysisTasks || {})) {
      if (item?.status === 'running') {
        interruptedBidAnalysisTasks[itemId] = {
          ...item,
          status: 'error',
          error: message,
        };
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
    const partial = Object.keys(interruptedBidAnalysisTasks).length
      ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: interruptedBidAnalysisTasks }
      : { bidAnalysisTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-analysis'), partial, recoveredTask));
  }

  function recoverInterruptedBidSectionExtractionTask(technicalPlan) {
    if (activeTasks.has('bid-section-extraction')) {
      return;
    }

    const extractionTask = technicalPlan.bidSectionExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const detectingMode = extractionTask.stats?.bid_section_stage === 'detection';
    const message = detectingMode ? '上次自动识别标段未完成，请重试' : '上次多标段识别未完成，请重新识别';
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
      ...(detectingMode ? {} : { bidSectionExtractionStatus: 'error', bidSectionExtractionError: message }),
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-section-extraction'), partial, recoveredTask));
  }

  function recoverInterruptedGlobalFactsTask(technicalPlan) {
    if (activeTasks.has('global-facts-generation')) {
      return;
    }

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

  function recoverInterruptedRejectionCheckTasks(state) {
    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';
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

  function recoverInterruptedDuplicateCheckTask(state) {
    if (activeTasks.has('duplicate-analysis')) {
      return;
    }
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

  function recoverInterruptedBlindCheckExtractionTask(state) {
    if (activeTasks.has('blind-check-preset-extraction') || state.extractionTask?.status !== 'running') return;
    const message = '上次格式要求提取未完成，请重新提取';
    const recoveredTask = {
      ...state.extractionTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const partial = { extractionTask: recoveredTask };
    blindCheckStore.updateBlindCheckWithoutReload(partial);
    emit(recoveredTask, { blindCheckPatch: partial });
  }

  function recoverInterruptedBlindCheckFixTask(state) {
    if (activeTasks.has('blind-check-fix') || state.fixTask?.status !== 'running') return;
    const message = '上次修复未完成，请重新修复';
    const recoveredTask = {
      ...state.fixTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const partial = { fixTask: recoveredTask };
    if (state.fixResult?.status === 'running') partial.fixResult = { status: 'error', error: message, groups: [], updatedAt: now() };
    blindCheckStore.updateBlindCheckWithoutReload(partial);
    emit(recoveredTask, { blindCheckPatch: partial });
  }

  function recoverInterruptedBlindCheckTask(state) {
    if (activeTasks.has('blind-check-run') || state.checkTask?.status !== 'running') return;
    const message = '上次检查未完成，请重新检查';
    const recoveredTask = {
      ...state.checkTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const partial = { checkTask: recoveredTask };
    if (state.result?.status === 'running') partial.result = { status: 'error', error: message, groups: [], updatedAt: now() };
    if (state.review?.status === 'running') partial.review = { status: 'error', error: '上次 AI 复核未完成，请重新检查', review: null, updatedAt: now() };
    blindCheckStore.updateBlindCheckWithoutReload(partial);
    emit(recoveredTask, { blindCheckPatch: partial });
  }

  function recoverInterruptedFeasibilityTasks(state) {
    if (!feasibilityReportStore) return;
    const markError = (task, message) => {
      if (!isActiveTaskStatus(task?.status)) return undefined;
      return {
        ...task,
        status: 'error',
        progress: 100,
        error: message,
        logs: [...(Array.isArray(task.logs) ? task.logs : []), message],
        updated_at: now(),
      };
    };
    const interruptMessage = '上次任务因应用关闭而中断，请重新开始。';
    const pausedMessage = '上次正文生成因应用关闭而暂停，可点击继续恢复。';
    const partial = {};
    const analysisTask = markError(state.analysisTask, interruptMessage);
    const outlineTask = markError(state.outlineTask, interruptMessage);
    const parametersTask = markError(state.parametersTask, interruptMessage);
    const humanWritingTask = markError(state.humanWritingTask, interruptMessage);
    if (analysisTask) partial.analysisTask = analysisTask;
    if (outlineTask) partial.outlineTask = outlineTask;
    if (parametersTask) partial.parametersTask = parametersTask;
    if (humanWritingTask) partial.humanWritingTask = humanWritingTask;
    if (isActiveTaskStatus(state.outlineAdjustmentTask?.status)) {
      const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
      partial.outlineAdjustmentTask = {
        ...state.outlineAdjustmentTask,
        status: 'error',
        progress: Math.max(0, Math.min(99, Number(state.outlineAdjustmentTask.progress || 0) || 0)),
        pause_requested: false,
        error: message,
        logs: [...(Array.isArray(state.outlineAdjustmentTask.logs) ? state.outlineAdjustmentTask.logs : []), message],
        updated_at: now(),
      };
    }
    if (isActiveTaskStatus(state.contentTask?.status)) {
      partial.contentTask = {
        ...state.contentTask,
        status: 'paused',
        pause_requested: false,
        logs: [...(Array.isArray(state.contentTask.logs) ? state.contentTask.logs : []), pausedMessage],
        updated_at: now(),
      };
    }
    if (!Object.keys(partial).length) return;
    feasibilityReportStore.updateFeasibilityReportWithoutReload(partial);
    const recovered = partial.contentTask || analysisTask || outlineTask || partial.outlineAdjustmentTask || parametersTask || humanWritingTask;
    if (recovered) emit(recovered, { feasibilityReportPatch: partial });
  }

  const technicalPlanRecoveryState = technicalPlanStore.loadTechnicalPlan() || {};
  if (isActiveTaskStatus(technicalPlanRecoveryState.bidDocumentAdjustmentTask?.status)) {
    technicalPlanStore.updateTechnicalPlanWithoutReload({ bidDocumentAdjustmentTask: {
      ...technicalPlanRecoveryState.bidDocumentAdjustmentTask, status: 'error',
      error: '上次投标文件调整已中断，已保存的内容保留，可在 AI 对话中继续。',
      updated_at: now(),
    } });
  }
  const rejectionCheckRecoveryState = rejectionCheckStore.loadRejectionCheck() || {};
  const duplicateCheckRecoveryState = duplicateCheckStore.loadDuplicateCheck() || {};
  const feasibilityReportRecoveryState = feasibilityReportStore?.loadFeasibilityReport?.() || {};
  const blindCheckRecoveryState = blindCheckStore.loadBlindCheck() || {};
  recoverInterruptedBidSectionExtractionTask(technicalPlanRecoveryState);
  recoverInterruptedBidAnalysisTask(technicalPlanRecoveryState);
  recoverInterruptedOutlineGenerationTask(technicalPlanRecoveryState);
  recoverInterruptedOutlineAdjustmentTask(technicalPlanRecoveryState);
  recoverInterruptedBidTemplateExtractionTask(technicalPlanRecoveryState);
  recoverInterruptedRulePageCompileTask(technicalPlanRecoveryState);
  recoverInterruptedContentGenerationTask(technicalPlanRecoveryState);
  recoverInterruptedGlobalFactsTask(technicalPlanRecoveryState);
  recoverInterruptedGlobalFactsAdjustmentTask(technicalPlanRecoveryState);
  recoverInterruptedRejectionCheckTasks(rejectionCheckRecoveryState);
  recoverInterruptedDuplicateCheckTask(duplicateCheckRecoveryState);
  recoverInterruptedBlindCheckTask(blindCheckRecoveryState);
  recoverInterruptedBlindCheckFixTask(blindCheckRecoveryState);
  recoverInterruptedBlindCheckExtractionTask(blindCheckRecoveryState);
  recoverInterruptedFeasibilityTasks(feasibilityReportRecoveryState);

  // 判断缓存清单及已选范围是否可直接用于本次解析。
  function getBidSectionReadiness(plan) {
    const listReady = plan.bidSectionExtractionStatus === 'success' && plan.bidSections.length >= 2;
    const selected = plan.tenderFile.selectedSectionId;
    const selectionReady = listReady && Boolean(plan.tenderFile.selectedSectionTitle)
      && plan.bidSections.some((section) => section.id === selected);
    return { listReady, selectionReady };
  }

  // 同一个受管任务准备解析范围；等释放任务锁后再解析或等待选段。
  function startBidSectionPreparation(payload, originalHash) {
    let preparedMode;
    return startManagedTask('bid-section-extraction', payload, async (context) => {
      const { previousState: plan, workspaceStore, aiService: scopedAiService, checkpointTask, taskControl } = context;
      let mode = plan.bidSectionAutoEnabled ? plan.bidSectionAutoMode : plan.bidSectionMode;
      const logs = [];
      const stats = { bid_section_stage: 'detection' };
      if (mode === null) {
        logs.push('正在自动识别单标段或多标段。');
        checkpointTask({ progress: 5, stats, logs });
        const markdown = workspaceStore.readOriginalTenderMarkdown().trim();
        if (!markdown) throw new Error('原始招标文件内容为空，请重新上传');
        mode = await detectBidSectionMode(markdown, scopedAiService, taskControl.signal);
        logs.push(mode === 'single' ? '已识别为单标段。' : '已识别为多标段。');
        checkpointTask({ progress: 30, logs }, { bidSectionAutoMode: mode });
      }

      preparedMode = mode;
      const { listReady } = getBidSectionReadiness(plan);
      if (mode === 'multiple' && (plan.bidSectionMode !== mode || !listReady)) {
        await runBidSectionExtractionTask(context);
        return;
      }

      let eventPatch;
      if (plan.bidSectionMode !== mode) {
        workspaceStore.saveGenerationConfig({ bidSectionMode: mode });
        eventPatch = { technicalPlanPatch: workspaceStore.loadTechnicalPlan() };
      }
      checkpointTask({ status: 'success', progress: 100, stats, logs }, {}, eventPatch);
    }, {}, {
      afterSettled() {
        // 标段提取会自行记录失败，不能仅凭 runner 返回判断识别成功。
        const plan = technicalPlanStore.loadTechnicalPlan();
        if (plan.bidSectionExtractionTask?.status !== 'success' || plan.tenderFile?.originalContentHash !== originalHash
          || plan.bidSectionMode !== preparedMode || (plan.bidSectionAutoEnabled && plan.bidSectionAutoMode !== preparedMode)) return;
        if (preparedMode === 'multiple' && !getBidSectionReadiness(plan).selectionReady) {
          pendingBidAnalysis = { payload, originalHash };
        } else {
          startManagedTask('bid-analysis', payload, runBidAnalysisTask);
        }
      },
    });
  }

  return {
    beginTechnicalPlanExport,
    assertDocumentMutationIdle,
    getDocumentAdjustmentEnableBlocker,
    getDocumentAdjustmentBlocker,
    startBidDocumentAdjustment,
    enableDocumentAdjustment,
    subscribe,
    subscribeCallback,
    // 单独提取标段只更新清单，不启动招标解析。
    startBidSectionExtraction(payload) {
      const task = startManagedTask('bid-section-extraction', payload, runBidSectionExtractionTask);
      pendingBidAnalysis = null;
      return task;
    },
    // 对解析请求统一准备范围；已有选择可直接解析，待选时不占任务锁。
    startBidAnalysis(payload) {
      const plan = technicalPlanStore.loadTechnicalPlan();
      if (!plan.tenderFile) throw new Error('请先上传招标文件，再开始解析');
      const { originalContentHash: originalHash } = plan.tenderFile;
      const mode = plan.bidSectionAutoEnabled ? plan.bidSectionAutoMode : plan.bidSectionMode;
      const { listReady, selectionReady } = getBidSectionReadiness(plan);
      const preparing = mode !== plan.bidSectionMode || (mode === 'multiple' && !listReady);
      if (!preparing && mode === 'multiple' && !selectionReady) {
        pendingBidAnalysis = { payload, originalHash };
        return { phase: 'waiting-selection' };
      }
      const task = preparing
        ? startBidSectionPreparation(payload, originalHash)
        : startManagedTask('bid-analysis', payload, runBidAnalysisTask);
      pendingBidAnalysis = null;
      return { phase: preparing ? 'preparing' : 'analysis-started', taskId: task.task_id };
    },
    // 保存投标范围后取走同一份原请求，重复确认不会再启动解析。
    selectBidSection(section) {
      assertDocumentMutationIdle();
      const result = technicalPlanStore.selectBidSection(section);
      if (pendingBidAnalysis) {
        const { payload, originalHash } = pendingBidAnalysis;
        pendingBidAnalysis = null;
        if (technicalPlanStore.loadTechnicalPlan().tenderFile?.originalContentHash === originalHash) {
          startManagedTask('bid-analysis', payload, runBidAnalysisTask);
        }
      }
      return result;
    },
    // 只有显式放弃选段才取消待续接请求，切页不取消。
    cancelPendingBidAnalysis() {
      pendingBidAnalysis = null;
    },
    // 生成范围、原方案目录方式、字数和参考知识库只读第 2 步已保存的生成设置，启动时不回写。
    startOutlineGeneration(payload) {
      return startManagedTask('outline-generation', payload, runOutlineGenerationTaskV2, {
        bidTemplateExists: false,
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineAdjustmentTask: undefined,
        bidTemplateExtractionTask: undefined,
        globalFactsTask: undefined,
        globalFactsAdjustmentTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
        bidDocumentAdjustmentTask: undefined,
      }, {
        primarySession: true,
        beforeStart: () => {
          technicalPlanStore.clearDocumentAdjustment();
          agentService.deletePersistentTask(OUTLINE_AGENT_TASK_KEY);
          agentService.deletePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
          agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
          agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
          agentService.deletePersistentTask(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY);
          agentService.deletePersistentTask(RULE_PAGE_AGENT_TASK_KEY);
          technicalPlanStore.clearBidTemplate();
        },
      });
    },
    startOutlineAdjustment(payload) {
      return startManagedTask('outline-adjustment', payload, runOutlineAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: OUTLINE_AGENT_TASK_KEY }),
      });
    },
    // 目录变更后按当前目录重新提取投标模版（新会话，不依赖目录会话）；先清空旧模版，避免旧产物让提取校验误判完成。
    startBidTemplateExtraction(payload) {
      // 启用 AI 调整后正文任务不再运行，重新提取会使商务填写无法补齐。
      if (technicalPlanStore.isDocumentAdjustmentEnabled()) {
        throw new Error('已启用 AI 调整，不能重新提取商务模版；如需重新提取，请先重置正文阶段');
      }
      return startManagedTask('bid-template-extraction', payload, runBidTemplateExtractionTask, {}, {
        primarySession: true,
        beforeStart: () => {
          agentService.deletePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
          technicalPlanStore.clearBidTemplate();
        },
      });
    },
    startRulePageCompile,
    startGlobalFactsGeneration(payload) {
      return startManagedTask('global-facts-generation', payload, runGlobalFactsTaskV2, {
        invalidateContentGeneration: true,
        globalFacts: [],
        globalFactsAdjustmentTask: undefined,
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      }, {
        primarySession: true,
        beforeStart: () => agentService.deletePersistentTask(GLOBAL_FACTS_AGENT_TASK_KEY),
      });
    },
    startGlobalFactsAdjustment(payload) {
      return startManagedTask('global-facts-adjustment', payload, runGlobalFactsAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: GLOBAL_FACTS_AGENT_TASK_KEY }),
      });
    },
    // 正文生成、单节修改共用任务管理；启用 AI 调整后只允许全文重新生成（同时退出 AI 调整）。
    startContentGeneration(payload) {
      const technicalPlan = technicalPlanStore.loadTechnicalPlan();
      if (technicalPlan.documentAdjustmentEnabled && (payload?.targetItemId || !(payload?.regenerate || payload?.developerRestart))) {
        throw new Error('已启用 AI 调整，后续修改请通过 AI 调整完成；如需重新生成，请先重置正文阶段');
      }
      if (!technicalPlan.outlineWordControlSnapshot) {
        throw new Error('当前目录没有字数控制生效快照，请重新生成目录');
      }
      const taskPayload = payload?.developerRestart ? { ...payload, regenerate: true } : payload;
      const sectionRegeneration = !taskPayload?.developerRestart && Boolean(taskPayload?.targetItemId
        || ((taskPayload?.resume || taskPayload?.retryFailedSections || taskPayload?.retry_failed_sections)
          && technicalPlan.contentGenerationRuntime?.target_item_id));
      if (sectionRegeneration && isActiveTaskStatus(activeTasks.get('content-generation')?.status)) {
        throw new Error('当前正文任务正在执行，请等待完成后再修改小节');
      }
      const continuing = taskPayload?.resume || [
        'retryContentCorrection', 'retry_content_correction', 'retryFailedSections', 'retry_failed_sections',
      ].some(field => taskPayload?.[field]);
      const pendingSectionIds = collectPendingSectionIds(technicalPlan);
      // 商务模版尚未填写完成、规则和页码尚未编制时同样需要启动，由正文任务按需只执行副 Agent。
      const businessFillPending = technicalPlanStore.hasBidTemplate()
        && technicalPlan.contentGenerationRuntime?.business_fill?.phase !== 'completed';
      const rulePagePending = hasRulePageChapters(technicalPlanStore, technicalPlan.outlineData?.outline)
        && technicalPlan.contentGenerationRuntime?.rule_page?.phase !== 'completed';
      // 普通生成没有待办时直接返回已有结果，避免 beforeStart 删除产物会话。
      if (!sectionRegeneration && !continuing && !taskPayload?.regenerate
        && technicalPlan.contentGenerationTask?.status === 'success'
        && !businessFillPending
        && !rulePagePending
        && !pendingSectionIds.length) {
        const task = technicalPlan.contentGenerationTask;
        emit(task, { technicalPlanPatch: technicalPlan });
        return task;
      }
      const initialState = sectionRegeneration || continuing
        ? { contentGenerationRuntime: { ...technicalPlan.contentGenerationRuntime, generation_started: true } }
        : prepareContentGenerationStart(technicalPlan, taskPayload);
      return startManagedTask('content-generation', taskPayload, sectionRegeneration ? runContentSectionRegenerationTask : runContentGenerationTask, initialState, {
        primarySession: true,
        beforeStart: () => {
          if (sectionRegeneration) return;
          // 只有明确全文重生才删除正文会话并退出 AI 调整；局部新增继续使用原 Session。
          if (!continuing && taskPayload?.regenerate) {
            agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
            technicalPlanStore.clearDocumentAdjustment();
          }
          if (technicalPlan.originalPlanFile?.markdownPath && !continuing) {
            agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
          }
        },
      });
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
    pauseFeasibilityContent() {
      const task = activeTasks.get('feasibility-content');
      const control = activeTaskControls.get('feasibility-content');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && aiService?.pauseQueueScope) {
          aiService.pauseQueueScope(control.queueScopeId);
        }
        return control.requestPause();
      }

      const report = feasibilityReportStore?.loadFeasibilityReport?.() || {};
      const contentTask = report.contentTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }

      throw new Error('当前没有正在生成的可研正文任务。');
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
    startBlindCheck(payload) {
      return startManagedTask('blind-check-run', payload, runBlindCheckTask);
    },
    startBlindCheckFix(payload) {
      return startManagedTask('blind-check-fix', payload, runBlindCheckFixTask);
    },
    startBlindCheckPresetExtraction(payload) {
      return startManagedTask('blind-check-preset-extraction', payload, runBlindCheckPresetExtractionTask);
    },
    startFeasibilityAnalysis(payload) {
      return startManagedTask('feasibility-analysis', payload, runFeasibilityAnalysisTask, {
        outlineData: null,
        keyParametersMarkdown: '',
        outlineTask: null,
        outlineAdjustmentTask: null,
        parametersTask: null,
        contentTask: null,
        humanWritingTask: null,
      });
    },
    startFeasibilityOutline(payload) {
      return startManagedTask('feasibility-outline', payload, runFeasibilityOutlineTask, {
        outlineTemplate: payload?.outlineTemplate,
        targetWords: payload?.targetWords,
        referenceDocumentIds: payload?.referenceDocumentIds,
        outlineData: null,
        keyParametersMarkdown: '',
        outlineAdjustmentTask: null,
        parametersTask: null,
        contentTask: null,
        humanWritingTask: null,
      }, {
        primarySession: true,
        beforeStart: () => agentService.deletePersistentTask(FEASIBILITY_OUTLINE_AGENT_TASK_KEY),
      });
    },
    startFeasibilityOutlineAdjustment(payload) {
      return startManagedTask('feasibility-outline-adjustment', payload, runFeasibilityOutlineAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: FEASIBILITY_OUTLINE_AGENT_TASK_KEY }),
      });
    },
    startFeasibilityParameters(payload) {
      return startManagedTask('feasibility-parameters', payload, runFeasibilityParametersTask, {
        contentTask: null,
        humanWritingTask: null,
      });
    },
    startFeasibilityContent(payload) {
      const incremental = Boolean(payload?.onlyMissing || payload?.resume);
      if (incremental) {
        return startManagedTask('feasibility-content', payload, runFeasibilityContentTask, {});
      }
      const report = feasibilityReportStore?.loadFeasibilityReport?.() || {};
      const initialPartial = { humanWritingTask: null };
      if (report.outlineData?.outline?.length) {
        initialPartial.outlineData = {
          ...report.outlineData,
          outline: clearContent(report.outlineData.outline),
        };
      }
      return startManagedTask('feasibility-content', payload, runFeasibilityContentTask, initialPartial);
    },
    startFeasibilityHumanWriting(payload) {
      return startManagedTask('feasibility-human-writing', payload, runFeasibilityHumanWritingTask);
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
    confirmBusinessFillReview(payload) {
      const control = activeTaskControls.get('content-generation');
      if (!control) throw new Error('当前没有等待确认的商务模版');
      return control.confirmBusinessFillReview(payload);
    },
    suppressBusinessFillReviewAutoConfirmation(payload) {
      return activeTaskControls.get('content-generation')?.suppressBusinessFillReviewAutoConfirmation(payload) || { success: true };
    },
    getBusinessFillReview() {
      return loadBusinessFillReview({ workspaceStore: technicalPlanStore, credentialLibraryService, openXmlHelperService });
    },
    // 商务模版填写完成后编辑字段值；与正文并行不冲突，正文任务运行中时同步任务内存中的状态，避免后续 checkpoint 覆盖。
    async saveBusinessFillReview(payload = {}) {
      assertDocumentMutationIdle();
      const editor = activeTaskControls.get('content-generation')?.businessFillEditor;
      const state = editor ? editor.getState() : technicalPlanStore.readContentGenerationRuntime()?.business_fill;
      if (state?.phase !== 'completed') throw new Error('商务模版尚未填写完成，暂不能编辑');
      const next = await editBusinessFillValues({
        workspaceStore: technicalPlanStore,
        credentialLibraryService,
        openXmlHelperService,
        state,
        values: payload.values || [],
      });
      activeTaskControls.get('content-generation')?.businessFillEditor?.apply(next);
      return { contentGenerationRuntime: technicalPlanStore.saveBusinessFillRuntime(next) };
    },
    async resetTechnicalPlan() {
      await cancelTechnicalPlanTasks('技术方案已重置，后台任务已取消');
      // 空闲常驻的 openxml 助手不在任务取消范围内,重置前显式关掉,确保没有进程握着招标原件
      await openXmlHelperService.close?.();
      return technicalPlanStore.clearTechnicalPlan();
    },
    // 仅重置正文阶段，保留目录、全局事实和生成配置。
    async resetContentGeneration() {
      // 正文页单独运行的“重新编制”也使用正文会话和运行时，一并取消并等待结束后再清理。
      await cancelTechnicalPlanTasks('正文生成阶段已重置，后台任务已取消', ['content-generation', 'rule-page-compile', 'bid-document-adjustment']);
      technicalPlanStore.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true });
      return technicalPlanStore.loadTechnicalPlan();
    },
    importTenderDocument(filePaths) {
      return technicalPlanStore.importTenderDocument(filePaths, {
        beforeCommit: async () => {
          await cancelTechnicalPlanTasks('招标文件已更新，后台任务已取消');
          await openXmlHelperService.close?.();
        },
      });
    },
    removeTenderDocument(sourceId) {
      return technicalPlanStore.removeTenderDocument(sourceId, {
        beforeCommit: async () => {
          await cancelTechnicalPlanTasks('招标文件已更新，后台任务已取消');
          await openXmlHelperService.close?.();
        },
      });
    },
    importOriginalPlanDocument(filePaths) {
      assertDocumentMutationIdle();
      return technicalPlanStore.importOriginalPlanDocument(filePaths);
    },
    removeOriginalPlanDocument() {
      assertDocumentMutationIdle();
      return technicalPlanStore.removeOriginalPlanDocument();
    },
    async resetRejectionCheck() {
      await cancelRejectionCheckTasks('废标项检查已重置，后台任务已取消');
      return rejectionCheckStore.clearRejectionCheck();
    },
    importRejectionCheckDocument(role, filePaths) {
      const documentRole = role === 'bid' ? 'bid' : 'tender';
      return rejectionCheckStore.importDocument(role, filePaths, {
        beforeCommit: () => cancelRejectionCheckTasks(
          documentRole === 'bid' ? '投标文件已更新，后台任务已取消' : '招标文件已更新，后台任务已取消',
          documentRole === 'bid' ? ['rejection-check-run'] : undefined,
        ),
      });
    },
    importRejectionCheckTenderFromTechnicalPlan() {
      return rejectionCheckStore.importTenderFromTechnicalPlan({
        beforeCommit: () => cancelRejectionCheckTasks('招标文件已更新，后台任务已取消'),
      });
    },
    removeRejectionCheckDocument(role, documentId) {
      const documentRole = role === 'bid' ? 'bid' : 'tender';
      return rejectionCheckStore.removeDocument(role, documentId, {
        beforeCommit: () => cancelRejectionCheckTasks(
          documentRole === 'bid' ? '投标文件已更新，后台任务已取消' : '招标文件已更新，后台任务已取消',
          documentRole === 'bid' ? ['rejection-check-run'] : undefined,
        ),
      });
    },
    // 暗标 AI 复核的持久会话属于当前待检文档，换文件、移除和重置时连同结果一起删除。
    async resetBlindCheck() {
      await cancelBlindCheckTasks('暗标合规检查已重置，后台任务已取消');
      const state = blindCheckStore.clearBlindCheck();
      agentService.deletePersistentTask(BLIND_CHECK_AGENT_TASK_KEY);
      return state;
    },
    async importBlindCheckFile(filePath) {
      const state = await blindCheckStore.importFile(filePath, {
        beforeCommit: () => cancelBlindCheckTasks('待检文档已更换，后台任务已取消', BLIND_CHECK_DOCUMENT_TASK_TYPES),
      });
      agentService.deletePersistentTask(BLIND_CHECK_AGENT_TASK_KEY);
      return state;
    },
    async removeBlindCheckFile() {
      const state = await blindCheckStore.removeFile({
        beforeCommit: () => cancelBlindCheckTasks('待检文档已移除，后台任务已取消', BLIND_CHECK_DOCUMENT_TASK_TYPES),
      });
      agentService.deletePersistentTask(BLIND_CHECK_AGENT_TASK_KEY);
      return state;
    },
    async resetFeasibilityReport() {
      await cancelFeasibilityReportTasks('可研报告已重置，后台任务已取消');
      return feasibilityReportStore.clearFeasibilityReport();
    },
    importFeasibilitySourceDocuments(filePaths) {
      return feasibilityReportStore.importSourceDocuments(filePaths, {
        beforeCommit: () => cancelFeasibilityReportTasks('可研资料已更新，后台任务已取消'),
      });
    },
    removeFeasibilitySourceDocument(sourceId) {
      return feasibilityReportStore.removeSourceDocument(sourceId, {
        beforeCommit: () => cancelFeasibilityReportTasks('可研资料已更新，后台任务已取消'),
      });
    },
    async saveFeasibilityProjectInfo(projectInfo) {
      await cancelFeasibilityReportTasks('项目信息已更新，后台任务已取消');
      return feasibilityReportStore.saveProjectInfo(projectInfo, { clearDownstream: true });
    },
    async saveFeasibilityAnalysis(markdown) {
      await cancelFeasibilityReportTasks('资料分析已更新，后台任务已取消');
      return feasibilityReportStore.saveAnalysis(markdown);
    },
    async saveFeasibilityOutline(payload) {
      await cancelFeasibilityReportTasks('报告目录已更新，后台任务已取消');
      return feasibilityReportStore.saveOutline(payload);
    },
    async saveFeasibilityKeyParameters(markdown) {
      await cancelFeasibilityReportTasks('关键参数已更新，后台任务已取消');
      return feasibilityReportStore.saveKeyParameters(markdown);
    },
    getActiveTasks() {
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
