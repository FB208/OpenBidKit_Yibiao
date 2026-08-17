const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const {
  GLOBAL_FACTS_OUTPUT_FILE,
  GLOBAL_FACTS_JSON_SCHEMA,
  readJson,
  formatProgressTitle,
} = require('./globalFactsTaskV2.cjs');
const {
  normalizeGlobalFactsResponse,
  validateGlobalFactsResponse,
} = require('./globalFactsTask.cjs');

function buildAgentFactsInput(groups) {
  return {
    groups: (Array.isArray(groups) ? groups : []).map((group) => ({
      id: String(group?.id || ''),
      title: String(group?.title || '').trim(),
      content: String(group?.content || ''),
    })),
  };
}

function createGlobalFactsAdjustmentPrompt(requirement) {
  return `用户已经在当前全局事实基础上提出新的调整要求。程序已把当前最新的完整结果覆盖写入 ${GLOBAL_FACTS_OUTPUT_FILE}（用户可能在主界面手动修改过，请以该文件为准，不要沿用你记忆中的旧内容）。

用户的调整要求：
${requirement}

请按以下要求完成调整：
1. 先读取 ${GLOBAL_FACTS_OUTPUT_FILE}，理解当前内容，再严格按照用户的调整要求修改；与要求无关的项保持原样，不要顺带重写。
2. 修改后仍须保持完整根结构 {"groups":[{"id":"...","title":"...","content":"..."}]}：每项包含 id、title、content。
3. 材料或用户要求足以判断时直接执行。不确定且不同选择会实质影响结果时，可以自行决定是否调用 ask-user；不要为了确认而反复提问。
4. 将调整后的完整结果覆盖写回 ${GLOBAL_FACTS_OUTPUT_FILE}。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${GLOBAL_FACTS_OUTPUT_FILE}"}；校验失败后必须先修改文件，再重新校验。
5. 全部完成后，用简体中文输出一段简短的最终总结（不超过 200 字，不使用 Markdown 标题），说明本次实际做了哪些调整；如有未能执行的要求，一并说明原因。该总结会直接展示给用户。`;
}

// 复用全局事实生成的持久 Agent 会话，按用户要求调整已生成的结果。
async function runGlobalFactsAdjustmentTask({ agentService, workspaceStore, updateTask, checkpointTask, taskControl, payload }) {
  const requirement = String(payload?.requirement || '').trim();
  if (!requirement) {
    throw new Error('调整要求不能为空');
  }
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  if (!Array.isArray(storedPlan.globalFacts) || !storedPlan.globalFacts.length) {
    throw new Error('当前没有可调整的全局事实，请先完成全局事实设定');
  }
  if (!agentService.hasPersistentTaskSession(GLOBAL_FACTS_AGENT_TASK_KEY)) {
    throw new Error('全局事实设定的 Agent 工作空间不存在，请重新生成后再使用 AI 调整');
  }

  let logs = ['开始 AI 调整全局事实'];
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

  // 持久任务的 run_id 与当前业务任务对齐后才能 resume 同一 Session。
  agentService.updatePersistentTask(GLOBAL_FACTS_AGENT_TASK_KEY, {
    run_id: task.task_id,
    status: 'running',
    phase: 'global-facts-adjustment',
    agent_connection: 'running',
    error: null,
  });

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '全局事实设定 AI 调整',
    prompt: createGlobalFactsAdjustmentPrompt(requirement),
    output_file: GLOBAL_FACTS_OUTPUT_FILE,
    files: [{
      path: GLOBAL_FACTS_OUTPUT_FILE,
      content: JSON.stringify(buildAgentFactsInput(storedPlan.globalFacts), null, 2),
    }],
    signal: taskControl.signal,
    persistent_task: {
      task_key: GLOBAL_FACTS_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'global-facts-adjustment',
    json_validation_schemas: { [GLOBAL_FACTS_OUTPUT_FILE]: GLOBAL_FACTS_JSON_SCHEMA },
    max_retries: 0,
    onActivity: publishAgentActivity,
  });

  const generated = readJson(agentResult.output_content, GLOBAL_FACTS_OUTPUT_FILE);
  const normalized = normalizeGlobalFactsResponse(generated);
  validateGlobalFactsResponse(normalized);
  const summary = String(agentResult.assistant_text || '').trim() || '全局事实已按要求调整完成。';

  logs = [...logs, '全局事实 AI 调整完成'];
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
    globalFacts: normalized.groups,
    invalidateContentGeneration: true,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentIllustrationPlan: undefined,
    contentGenerationRuntime: undefined,
  });
  agentService.updatePersistentTask(GLOBAL_FACTS_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

module.exports = { runGlobalFactsAdjustmentTask };
