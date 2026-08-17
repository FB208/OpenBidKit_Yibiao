const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');
const {
  OUTLINE_OUTPUT_FILE,
  OUTLINE_JSON_SCHEMA,
  buildFinalOutline,
  stripOutlineInternalFields,
  readJson,
  formatProgressTitle,
} = require('./outlineGenerationTaskV2.cjs');

// 只保留 Agent 目录结构字段，正文等业务字段不进入 Agent 工作区。
function buildAgentOutlineInput(outlineData) {
  const strip = (items, root) => (items || []).map((item) => {
    const hasChildren = Array.isArray(item?.children) && item.children.length;
    return {
      id: String(item?.id || ''),
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim() || String(item?.title || '').trim(),
      ...(root ? { attr: item?.attr } : {}),
      ...(hasChildren
        ? { children: strip(item.children, false) }
        : {
          content_mode: item?.content_mode,
          ...(item?.content_mode === 'other' && String(item?.content_mode_note || '').trim()
            ? { content_mode_note: String(item.content_mode_note).trim() }
            : {}),
        }),
    };
  });
  return { outline: strip(outlineData?.outline || [], true) };
}

function createOutlineAdjustmentPrompt(requirement) {
  return `用户已经在最终目录基础上提出新的调整要求。程序已把当前最新的完整目录覆盖写入 ${OUTLINE_OUTPUT_FILE}（用户可能在主界面手动修改过目录，请以该文件为准，不要沿用你记忆中的旧目录）。

用户的调整要求：
${requirement}

请按以下要求完成目录调整：
1. 先读取 ${OUTLINE_OUTPUT_FILE}，理解当前目录结构，再严格按照用户的调整要求修改目录；与要求无关的目录保持原样，不要顺带重写。
2. 修改后仍须保持完整根结构 {"outline":[一级目录节点]}：一级目录包含 attr（从"通用""商务""资信""技术""其他"中选择），子目录不包含 attr；所有 id 使用与父子位置一致的层级点号编号（一级为 1、2，二级为 2.1、2.2，依此类推）。
3. 每个最终叶子节点必须填写 content_mode：技术方案正文为 ai-generate；从招标文件提取后按模板填写为 template-fill；需要在 Word 页码确定后回填为 point-to-point；其他特殊内容为 other，并用 content_mode_note 说明。父节点只包含 children，不包含 content_mode 或 content_mode_note。
4. 任意非叶子节点的 children 至少包含两个节点，目录最多六级；title 只写纯标题，不包含章节编号或 Markdown 标记。
5. 如果用户要求含糊或存在多种理解，选择最符合投标文件专业惯例的做法直接执行，不要调用 ask-user 反复确认；只有当要求明显违反上述结构规则且无法合理变通时，才在最终回复中说明未执行的部分及原因。
6. 将调整后的完整目录覆盖写回 ${OUTLINE_OUTPUT_FILE}。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${OUTLINE_OUTPUT_FILE}"}；校验失败后必须先修改文件，再重新校验。
7. 全部完成后，用简体中文输出一段简短的最终总结（不超过 200 字，不使用 Markdown 标题），说明本次实际做了哪些目录调整；如有未能执行的要求，一并说明原因。该总结会直接展示给用户。`;
}

// 复用目录生成的持久 Agent 会话，按用户要求调整已生成的目录。
async function runOutlineAdjustmentTask({ agentService, workspaceStore, updateTask, checkpointTask, taskControl, payload }) {
  const requirement = String(payload?.requirement || '').trim();
  if (!requirement) {
    throw new Error('调整要求不能为空');
  }
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  if (!storedPlan.outlineData?.outline?.length) {
    throw new Error('当前没有可调整的目录，请先完成目录生成');
  }
  if (!agentService.hasPersistentTaskSession(OUTLINE_AGENT_TASK_KEY)) {
    throw new Error('目录生成的 Agent 工作空间不存在，请重新生成目录后再使用 AI 调整');
  }

  let logs = ['开始 AI 调整目录'];
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
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    run_id: task.task_id,
    status: 'running',
    phase: 'outline-adjustment',
    agent_connection: 'running',
    error: null,
  });

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '技术方案目录 AI 调整',
    prompt: createOutlineAdjustmentPrompt(requirement),
    output_file: OUTLINE_OUTPUT_FILE,
    files: [{
      path: OUTLINE_OUTPUT_FILE,
      content: JSON.stringify(buildAgentOutlineInput(storedPlan.outlineData), null, 2),
    }],
    signal: taskControl.signal,
    persistent_task: {
      task_key: OUTLINE_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'outline-adjustment',
    json_validation_schemas: { [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA },
    max_retries: 0,
    onActivity: publishAgentActivity,
  });

  const adjustedOutline = buildFinalOutline(readJson(agentResult.output_content, OUTLINE_OUTPUT_FILE));
  const persistedOutline = stripOutlineInternalFields(adjustedOutline);
  const summary = String(agentResult.assistant_text || '').trim() || '目录已按要求调整完成。';

  // 目录调整属于目录变更，saveOutline(replace) 会按既有规则清空旧正文与生成缓存。
  const saved = workspaceStore.saveOutline({
    outlineData: {
      ...persistedOutline,
      project_name: storedPlan.outlineData.project_name,
      project_overview: storedPlan.outlineData.project_overview,
    },
    reason: 'replace',
  });

  logs = [...logs, '目录 AI 调整完成'];
  checkpointTask({
    status: 'success',
    progress: 100,
    error: undefined,
    logs,
    stats: {
      ...(task.stats || {}),
      adjustment: { requirement, summary },
    },
  }, {}, {
    outlineData: saved.outlineData,
    technicalPlanPatch: {
      outlineData: saved.outlineData,
      contentGenerationTask: undefined,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentIllustrationPlan: undefined,
      contentGenerationRuntime: undefined,
    },
  });
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

module.exports = { runOutlineAdjustmentTask };
