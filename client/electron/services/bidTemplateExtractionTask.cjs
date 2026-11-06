const { collectTemplateItems } = require('./outlineFormatExtraction.cjs');
const { formatProgressTitle } = require('./outlineGenerationTaskV2.cjs');
const { collectOutlineLeaves } = require('./technicalPlanOutline.cjs');
const { runTemplateExtractionTask } = require('./templateExtractionTask.cjs');

// 按当前目录计算应进入投标模版的条目：原文位置按稳定 ID 取自一级目录确认记录，提取规则与目录生成时相同。
function collectCurrentTemplateItems(plan) {
  const sources = new Map();
  const collectSources = (items) => {
    for (const item of items || []) {
      if (item.source) sources.set(item.id, item.source);
      collectSources(item.children);
    }
  };
  collectSources(plan.outlineGenerationTask?.stats?.outline_selection?.items);
  const withSources = (items) => (items || []).map((item) => ({
    ...item,
    ...(sources.has(item.id) ? { source: sources.get(item.id) } : {}),
    ...(item.children?.length ? { children: withSources(item.children) } : {}),
  }));
  return collectTemplateItems(withSources(plan.outlineData?.outline));
}

// “下一步”前核对投标模版：当前非 AI 叶子按提取规则应进入模版却没有对应章节，或填写方式（自动填写、规则和页码）与章节不一致。
// 技术文件独立成册、没有招标 Word 原件或正文已开始时不检查。
function inspectBidTemplate(workspaceStore) {
  const plan = workspaceStore.loadTechnicalPlan();
  const result = { added: [], changed: [] };
  const outlineMode = plan.outlineGenerationTask?.stats?.agent?.resume_payload?.outline_mode || plan.outlineMode;
  if (!plan.outlineData?.outline?.length
    || outlineMode === 'standalone-technical'
    || !workspaceStore.listTenderSourceDocxRelativePaths().length
    || plan.contentGenerationTask
    || plan.contentGenerationRuntime?.generation_started) {
    return result;
  }
  const chapters = new Map((workspaceStore.hasBidTemplate() ? workspaceStore.readBidTemplateFields().chapters || [] : [])
    .filter((chapter) => chapter.id)
    .map((chapter) => [chapter.id, chapter]));
  const leaves = new Map(collectOutlineLeaves(plan.outlineData.outline)
    .filter(({ item }) => item.content_mode !== 'ai-generate')
    .map(({ item }) => [item.id, item]));
  for (const item of collectCurrentTemplateItems(plan)) {
    const leaf = leaves.get(item.id);
    if (!leaf) continue;
    const chapter = chapters.get(item.id);
    const rulePage = item.rule_page === true;
    const entry = { id: item.id, number: leaf.number, title: leaf.title, auto_fill: item.auto_fill, rule_page: rulePage };
    if (!chapter) result.added.push(entry);
    else if ((chapter.auto_fill !== false) !== item.auto_fill || (chapter.rule_page === true) !== rulePage) result.changed.push(entry);
  }
  return result;
}

// 按当前目录重新提取投标模版：与目录生成时的提取流程相同，在新会话中进行；旧模版已在任务启动前清空。
async function runBidTemplateExtractionTask({ agentService, aiService, workspaceStore, openXmlHelperService, updateTask, checkpointTask, taskControl }) {
  const items = collectCurrentTemplateItems(workspaceStore.loadTechnicalPlan());
  let logs = ['开始按当前目录重新提取投标模版'];
  let progress = 5;
  let task = checkpointTask({ status: 'running', progress, logs }, {}, {
    technicalPlanPatch: { bidTemplateExists: false, bidTemplateChapterIds: [] },
  }).task;

  function publish(message, nextProgress = progress) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    progress = Math.max(progress, nextProgress);
    task = updateTask({ status: 'running', progress, logs });
  }

  publish(`共 ${items.length} 个目录需要抽进投标模版`, 15);

  await runTemplateExtractionTask({
    agentService,
    aiService,
    workspaceStore,
    openXmlHelperService,
    taskId: task.task_id,
    items,
    signal: taskControl.signal,
    onActivity(event = {}) {
      const title = formatProgressTitle(event.message);
      if (title && event.visible !== false) publish(title);
    },
    onStep(event = {}) {
      publish(`第 ${event.step}/${event.total} 步：${event.message}`, Math.min(95, 20 + Math.round(75 * (event.step || 0) / (event.total || 1))));
    },
  });

  const bidTemplateExists = workspaceStore.hasBidTemplate();
  checkpointTask({ status: 'success', progress: 100, error: undefined, logs: [...logs, '投标模版已重新提取'] }, {}, {
    technicalPlanPatch: {
      bidTemplateExists,
      bidTemplateChapterIds: bidTemplateExists
        ? (workspaceStore.readBidTemplateFields().chapters || []).map((chapter) => chapter.id).filter(Boolean)
        : [],
    },
  });
}

module.exports = {
  inspectBidTemplate,
  runBidTemplateExtractionTask,
};
