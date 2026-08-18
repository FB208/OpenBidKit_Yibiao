const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');
const {
  OUTLINE_OUTPUT_FILE,
  OUTLINE_JSON_SCHEMA,
  readJson,
  formatProgressTitle,
  buildAgentOutlineInput,
  finalizeOutline,
  loadLightweightKnowledgeItems,
  allowedKnowledgeIdSet,
} = require('./feasibilityOutlineTask.cjs');

function createFeasibilityOutlineAdjustmentPrompt(requirement) {
  return `用户已经在当前可行性研究报告目录基础上提出新的调整要求。程序已把当前最新的完整目录覆盖写入 ${OUTLINE_OUTPUT_FILE}（用户可能在主界面手动修改过目录，请以该文件为准，不要沿用你记忆中的旧目录）。

用户的调整要求：
${requirement}

请按以下要求完成目录调整：
1. 先读取 ${OUTLINE_OUTPUT_FILE}，理解当前目录结构，再严格按照用户的调整要求修改；与要求无关的节点保持原样，不要顺带重写。
2. 修改后仍须保持完整根结构 {"outline":[...]}：每项包含 title、description，非叶子项再包含 children。叶子可保留或填写 knowledge_item_ids。不要写入 content。
3. 目录最多三级。title 只写纯标题，不要带章节编号或 Markdown 标记。与调整无关的叶子 knowledge_item_ids 应原样保留。
4. 材料或用户要求足以判断时直接执行，不要调用 ask-user。
5. 将调整后的完整目录覆盖写回 ${OUTLINE_OUTPUT_FILE}。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${OUTLINE_OUTPUT_FILE}"}；校验失败后必须先修改文件，再重新校验。
6. 全部完成后，用简体中文输出一段简短的最终总结（不超过 200 字，不使用 Markdown 标题），说明本次实际做了哪些目录调整；如有未能执行的要求，一并说明原因。该总结会直接展示给用户。`;
}

async function runFeasibilityOutlineAdjustmentTask({
  agentService,
  workspaceStore,
  knowledgeBaseService,
  updateTask,
  checkpointTask,
  taskControl,
  payload,
}) {
  const requirement = String(payload?.requirement || '').trim();
  if (!requirement) {
    throw new Error('调整要求不能为空');
  }
  const state = workspaceStore.loadFeasibilityReport() || {};
  if (!state.outlineData?.outline?.length) {
    throw new Error('当前没有可调整的目录，请先完成报告目录生成');
  }
  if (!agentService.hasPersistentTaskSession(FEASIBILITY_OUTLINE_AGENT_TASK_KEY)) {
    throw new Error('报告目录生成的 Agent 工作空间不存在，请重新生成后再使用 AI 调整');
  }

  let logs = ['开始 AI 调整报告目录。'];
  let currentProgress = 10;
  let task = checkpointTask({ status: 'running', progress: currentProgress, logs }).task;

  function publish(message, progress) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    currentProgress = Math.max(currentProgress, progress || currentProgress);
    task = updateTask({ status: 'running', progress: currentProgress, logs });
  }

  function publishAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;
    publish(title, Math.max(currentProgress, 20));
  }

  agentService.updatePersistentTask(FEASIBILITY_OUTLINE_AGENT_TASK_KEY, {
    run_id: task.task_id,
    status: 'running',
    phase: 'feasibility-outline-adjustment',
    agent_connection: 'running',
    error: null,
  });

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '可研报告目录 AI 调整',
    prompt: createFeasibilityOutlineAdjustmentPrompt(requirement),
    output_file: OUTLINE_OUTPUT_FILE,
    files: [{
      path: OUTLINE_OUTPUT_FILE,
      content: JSON.stringify(buildAgentOutlineInput(state.outlineData), null, 2),
    }],
    signal: taskControl.signal,
    persistent_task: {
      task_key: FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'feasibility-outline-adjustment',
    json_validation_schemas: { [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA },
    max_retries: 0,
    onActivity: publishAgentActivity,
  });

  const allowedKnowledgeIds = allowedKnowledgeIdSet(
    loadLightweightKnowledgeItems(knowledgeBaseService, state.referenceDocumentIds || []),
  );
  const outline = finalizeOutline(readJson(agentResult.output_content, OUTLINE_OUTPUT_FILE), allowedKnowledgeIds);
  const summary = String(agentResult.assistant_text || '').trim() || '报告目录已按要求调整完成。';
  const saved = workspaceStore.saveOutline({
    outlineData: {
      outline,
      project_name: state.outlineData.project_name || state.projectInfo?.projectName,
      project_overview: state.outlineData.project_overview,
    },
    reason: 'replace',
  });

  logs = [...logs, '报告目录 AI 调整完成。'];
  checkpointTask({
    status: 'success',
    progress: 100,
    error: undefined,
    logs,
    stats: {
      ...(task.stats || {}),
      adjustment: { requirement, summary },
    },
  }, {
    outlineData: saved.outlineData,
    keyParametersMarkdown: saved.keyParametersMarkdown,
    parametersTask: null,
    contentTask: null,
    humanWritingTask: null,
  });
  agentService.updatePersistentTask(FEASIBILITY_OUTLINE_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

module.exports = { runFeasibilityOutlineAdjustmentTask };
