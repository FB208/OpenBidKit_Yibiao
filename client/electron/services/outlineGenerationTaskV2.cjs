const OUTLINE_JSON_SCHEMA = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'attr'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[1-9]\\d*$' },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          attr: { type: 'string', enum: ['通用', '商务', '资信', '技术', '其他'] },
        },
      },
    },
  },
};

const DEFAULT_SELECTED_ATTRIBUTES_BY_WORKFLOW = {
  'technical-plan': ['技术'],
  'existing-plan-expansion': ['技术'],
};

// 将 Agent 活动消息整理成页面使用的短标题。
function formatProgressTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return Array.from(title).slice(0, 20).join('');
}

/**
 * 运行 V2 目录生成工作流。
 */
async function runOutlineGenerationTaskV2({ agentService, workspaceStore, updateTask }) {
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const hasOriginalPlan = Boolean(storedPlan.originalPlanFile);
  const originalOnly = hasOriginalPlan && storedPlan.outlineExpansionMode === 'original-only';
  const originalPlan = hasOriginalPlan ? workspaceStore.readOriginalPlanMarkdown() : '';
  const responseFileRequirements = storedPlan.bidAnalysisTasks?.responseFileRequirements?.content || '';

  let files;
  let taskInstruction;
  if (originalOnly) {
    files = [
      { path: '原方案.md', content: originalPlan },
    ];
    taskInstruction = '只根据原方案材料提取一级目录。';
  } else {
    files = [
      { path: '响应文件要求.md', content: responseFileRequirements },
      { path: '项目概述.md', content: storedPlan.projectOverview || '' },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
    ];
    taskInstruction = hasOriginalPlan
      ? '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解项目背景和术语，不得从中提取或擅自补充任何一级目录；原方案.md 仅用于在响应文件要求明确的范围内参考标题表达，不得据此新增目录。'
      : '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解项目背景和术语，不得从中提取或擅自补充任何一级目录。';
  }

  const outputFile = 'outline.json';
  const prompt = `请只在当前工作目录内工作。

任务：
我们的目标是为编写响应文件/投标文件，准备一级目录。
${taskInstruction}

请生成一级目录 JSON，并将最终结果写入 ${outputFile}。

JSON 格式：
{
  "outline": [
    {
      "id": "1",
      "title": "目录标题",
      "description": "目录说明",
      "attr": "目录属性"
    }
  ]
}

字段要求：
1. outline 中只包含一级目录，不要生成 children 或其他层级。
2. id 是从 1 开始且不重复的连续序号字符串。
3. title 必须是可直接用于投标文件目录的正式标题。不得使用“附件1”“附件一”“附件X”等形式，也不得将其作为标题前缀；材料中出现“附件X：正式标题”时，只保留后面的正式标题。
4. description 是目录说明。
5. attr 是目录属性，必须根据工作空间材料从“通用”“商务”“资信”“技术”“其他”中选择一个填写。其中封面、总目录、编制说明、总体说明等跨部分内容归为“通用”；确实无法归入其他类别的内容才归为“其他”。
6. ${outputFile} 必须是可被 JSON.parse 直接解析的纯 JSON，不要包含 Markdown 代码块、解释文字或其他内容。
7. 程序已为 ${outputFile} 预置校验 Schema。写入完成后必须调用 json-validation 校验，调用参数只填写 {"file_path":"${outputFile}"}，不要自行构造或传入 schema；校验失败时修复文件并重新校验。`;

  let logs = ['开始生成一级目录'];
  let currentProgress = 10;
  let task = updateTask({ status: 'running', progress: currentProgress, logs });
  let technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: task });
  updateTask(task, technicalPlan);

  // 将 Agent 可见活动同步到目录生成过程，不保存活动详情。
  function publishAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;

    const latestTitle = logs[logs.length - 1];
    if (title === latestTitle) return;

    currentProgress = Math.max(currentProgress, 50);
    logs = [...logs, title];
    task = updateTask({ status: 'running', progress: currentProgress, logs });
    technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: task });
    updateTask(task, technicalPlan);
  }

  const agentResult = await agentService.runTask({
    title: '技术方案一级目录生成 V2',
    prompt,
    output_file: outputFile,
    files,
    json_validation_schemas: { [outputFile]: OUTLINE_JSON_SCHEMA },
    onActivity: publishAgentActivity,
  });

  const generatedOutline = JSON.parse(agentResult.output_content);
  const defaultSelectedAttributes = DEFAULT_SELECTED_ATTRIBUTES_BY_WORKFLOW[storedPlan.workflowKind]
    || DEFAULT_SELECTED_ATTRIBUTES_BY_WORKFLOW['technical-plan'];
  const outlineSelection = {
    items: generatedOutline.outline,
    selected_ids: generatedOutline.outline
      .filter((item) => defaultSelectedAttributes.includes(item.attr))
      .map((item) => item.id),
    confirmed: false,
  };

  logs = [...logs, '一级目录生成完成'];
  task = updateTask({
    status: 'success',
    progress: 100,
    error: undefined,
    logs,
    stats: { outline_selection: outlineSelection },
  });
  technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: task });
  updateTask(task, technicalPlan);
}

module.exports = { runOutlineGenerationTaskV2 };
