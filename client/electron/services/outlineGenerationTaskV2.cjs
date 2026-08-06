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
  let materialInstructions;
  let taskInstruction;
  if (originalOnly) {
    files = [
      { path: '原方案.md', content: originalPlan },
    ];
    materialInstructions = `工作区材料职责：
- 原方案.md：本次任务的唯一依据。完整读取后，从中提取一级目录并判断目录属性，不参考工作区外的其他材料。`;
    taskInstruction = '只根据原方案材料提取一级目录。';
  } else {
    files = [
      { path: '项目概述.md', content: storedPlan.projectOverview || '' },
      { path: '技术评分信息.md', content: storedPlan.techRequirements || '' },
      { path: '响应文件要求.md', content: responseFileRequirements },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
    ];
    materialInstructions = hasOriginalPlan
      ? `工作区材料职责：
- 原方案.md：核心依据，首先完整读取，用于确定一级目录主体、顺序和表达；与其他材料冲突时以原方案为准。
- 响应文件要求.md：读取原方案后使用，用于检查响应文件组成和一级目录缺项；只补充不与原方案冲突的内容。
- 项目概述.md：理解项目背景、范围以及编写目录标题和说明时参考。
- 技术评分信息.md：检查评分内容覆盖、完善目录说明和判断目录属性时参考。`
      : `工作区材料职责：
- 响应文件要求.md：核心依据，首先完整读取，用于确定一级目录。
- 项目概述.md：理解项目背景、范围以及编写目录标题和说明时参考。
- 技术评分信息.md：检查评分内容覆盖、完善目录说明和判断目录属性时参考。`;
    taskInstruction = hasOriginalPlan
      ? '以原方案为主，结合响应文件要求生成一级目录，并使用项目概述和技术评分信息完善结果。'
      : '基于响应文件要求生成一级目录，并使用项目概述和技术评分信息完善结果。';
  }

  const outputFile = 'outline.json';
  const prompt = `请只在当前工作目录内工作。

请完整阅读工作区内的全部输入材料；遇到长文件时分段处理，确保不遗漏与一级目录有关的内容。

${materialInstructions}

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
3. title 是目录标题。
4. description 是目录说明。
5. attr 是目录属性，必须根据工作空间材料从“通用”“商务”“资信”“技术”“其他”中选择一个填写。其中封面、总目录、编制说明、总体说明等跨部分内容归为“通用”；确实无法归入其他类别的内容才归为“其他”。
6. ${outputFile} 必须是可被 JSON.parse 直接解析的纯 JSON，不要包含 Markdown 代码块、解释文字或其他内容。`;

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

  await agentService.runTask({
    title: '技术方案一级目录生成 V2',
    prompt,
    output_file: outputFile,
    files,
    onActivity: publishAgentActivity,
  });

  logs = [...logs, '一级目录生成完成'];
  task = updateTask({ status: 'success', progress: 100, error: undefined, logs });
  technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: task });
  updateTask(task, technicalPlan);
}

module.exports = { runOutlineGenerationTaskV2 };
