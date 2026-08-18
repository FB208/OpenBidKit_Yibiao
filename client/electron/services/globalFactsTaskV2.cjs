const { buildBidSectionContextHint } = require('../utils/bidSectionContext.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const {
  formatBidAnalysisFactsForPrompt,
  formatOutlineForPrompt,
  loadKnowledgeItems,
  normalizeGlobalFactsMode,
  normalizeGlobalFactsResponse,
  normalizeReferenceDocumentIds,
  validateGlobalFactsResponse,
} = require('./globalFactsTask.cjs');

const GLOBAL_FACTS_OUTPUT_FILE = 'global-facts.json';

const GLOBAL_FACTS_JSON_SCHEMA = {
  type: 'object',
  required: ['groups'],
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'content'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

function formatProgressTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return Array.from(title).slice(0, 20).join('');
}

function readJson(content, label) {
  try {
    return JSON.parse(String(content || '').trim());
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${error?.message || String(error)}`);
  }
}

function sanitizeFileName(value, fallback = '招标文件') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .replace(/\.md$/i, '');
  const stem = cleaned || fallback;
  return Array.from(stem).slice(0, 80).join('');
}

function padIndex(index) {
  return String(index + 1).padStart(2, '0');
}

function buildMissingValueRule(mode) {
  if (mode === 'omit') {
    return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值时，该项仍须保留，写成不涉及具体时间、地点、人员、业绩、证书、规格型号、工艺步骤、数量指标的正确笼统承诺，表明本方案按招标要求执行该项，但不展开具体做法。严禁省略该项，也严禁杜撰具体值。必须包含工期、运维期或交货时间中的至少一个相关变量；没有具体值时同样使用笼统承诺，不要编造日期或周期。笼统但正确的承诺口径不是空泛内容，定稿时不得因不够具体而删除。';
  }
  if (mode === 'placeholder') {
    return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值时，该项仍须保留，值必须逐字写成【待填写】，不要改写成“待定”“TBD”或其他说法，也不要编造具体值。严禁省略该项。必须包含工期、运维期或交货时间中的至少一个相关变量；没有具体值时使用【待填写】。【待填写】不是空泛内容，定稿时不得因不够具体而删除。';
  }
  return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值，但该信息对全文一致性重要时，根据项目语境补足一套合理、稳定、不冲突的具体事实值。必须包含工期、运维期或交货时间中的至少一个相关变量；分段或材料不足时，若项目概述或招标解析结果中已有明确内容应写入，否则按项目语境补足具体周期。';
}

function buildJsonExample(mode) {
  if (mode === 'placeholder') {
    return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：【待填写】。\\n- 技术负责人：【待填写】。"
    }
  ]
}`;
  }
  if (mode === 'omit') {
    return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：按招标文件对该岗位的要求配备。\\n- 技术负责人：按招标文件对该岗位的要求配备。"
    }
  ]
}`;
  }
  return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：张伟，负责总体协调。\\n- 技术负责人：李明，负责方案设计和联调验收。"
    }
  ]
}`;
}

function hasSelectedBidSection(storedPlan) {
  return storedPlan?.bidSectionMode === 'multiple' && Boolean(storedPlan?.tenderFile?.selectedSectionId);
}

function readWorkingCopySource(workspaceStore, fileName = '当前投标范围', isWorkingCopy = true) {
  const markdown = String(workspaceStore.readTenderMarkdown?.() || '').trim();
  if (!markdown) return [];
  return [{ fileName, markdown, isWorkingCopy }];
}

function collectTenderSourceFiles(workspaceStore, storedPlan) {
  if (hasSelectedBidSection(storedPlan)) {
    return readWorkingCopySource(workspaceStore, '当前投标范围', true);
  }

  const listed = Array.isArray(storedPlan.tenderFiles) ? storedPlan.tenderFiles : [];
  const sources = [];
  listed.forEach((file, index) => {
    const markdown = String(workspaceStore.readTenderSourceMarkdown?.(file?.id) || '').trim();
    if (!markdown) return;
    sources.push({
      fileName: file?.fileName || `招标文件${index + 1}`,
      markdown,
      isWorkingCopy: false,
    });
  });
  if (sources.length) return sources;
  return readWorkingCopySource(workspaceStore, storedPlan.tenderFile?.fileName || '招标文件', false);
}

function formatKnowledgeItemFile(item) {
  const title = String(item?.title || '知识库条目').trim();
  const resume = String(item?.resume || '').trim() || '无';
  const content = String(item?.content || '').trim();
  return `# ${title}\n\n简介：${resume}\n\n${content}`.trim();
}

function buildFileCatalog({ tenderPaths, isWorkingCopy, hasSectionHint, knowledgeCount, hasOriginalPlan }) {
  const lines = [];
  if (tenderPaths.length) {
    const listed = tenderPaths.join('、');
    if (isWorkingCopy) {
      lines.push(`- ${listed}：排除其他标段后的当前投标范围正文，用于确定大项并提取明确事实；不要扩展到其他标段。`);
    } else {
      const multiNote = tenderPaths.length > 1 ? '；多份都要看' : '';
      lines.push(`- ${listed}：招标原文，用于确定大项并提取明确事实${multiNote}。`);
    }
  }
  lines.push('- 项目概述.md：项目背景和术语，用于确定大项，不作为商务/资格材料来源。');
  lines.push('- 招标解析结果.md：Step02 已抽出的项目信息、甲方信息、交货和服务要求，用于确定大项并提取明确值。');
  lines.push('- 技术方案目录.md：已确认目录，用于判断正文会反复用到哪些统一口径。');
  if (hasSectionHint) {
    lines.push('- 标段说明.md：本次投标范围，只关注该范围内的事实。');
  }
  if (knowledgeCount > 0) {
    lines.push('- 参考知识库/条目-*.md：补充已有大项的具体内容。');
  }
  if (hasOriginalPlan) {
    lines.push('- 原方案.md：已有方案扩写底稿，补充已有大项的具体内容。');
  }
  lines.push('- 材料说明.md：本次实际提供的文件清单，与上述用途一致。');
  return lines.join('\n');
}

function buildWorkPrinciples({ hasKnowledge, hasOriginalPlan }) {
  const supplementNames = [
    hasKnowledge ? '知识库' : '',
    hasOriginalPlan ? '原方案' : '',
  ].filter(Boolean);
  const principles = [
    '1. 先根据招标文件、项目概述、招标解析结果和技术方案目录，确定全部全局事实大项（id、title）。凡这些材料表明后续正文需要统一口径的事项，都必须建项；招标文件有多份时要综合全部招标原文，不要因为某一份没写就漏项。',
  ];
  let fillRule = '2. 再为每个大项填写 content。优先使用招标文件和招标解析结果中的明确值';
  if (supplementNames.length) {
    fillRule += `；然后再用${supplementNames.join('、')}补充这些已有大项的具体内容`;
  }
  principles.push(`${fillRule}。`);

  let next = 3;
  if (supplementNames.length) {
    principles.push(`${next}. ${supplementNames.join('和')}只用于补充已有大项的 content，不要靠它们新增大项。`);
    next += 1;
  }
  principles.push(`${next}. 全局事实不是招标要求摘录、评分规则或待办清单，而是正文要统一采用的方案事实、响应设定、承诺口径或执行安排。材料给出的是要求或约束时，不要原样摘录要求句，应转写为本方案统一口径。`);
  next += 1;
  principles.push(`${next}. 每条 content 只写简体中文短 bullet，回答“后续正文遇到这个事项时统一写什么”。不写分析过程、来源说明、风险提示、正文草稿、商务报价或资格材料。`);
  next += 1;
  principles.push(`${next}. 必须包含工期、运维期或交货时间中的至少一个相关变量；缺具体值时按本任务给定的写法填写，不要省略该项。`);
  next += 1;
  principles.push(`${next}. 材料较长时用检索定位，不要因为一次读不完就漏项。`);
  if (hasKnowledge) {
    next += 1;
    principles.push(`${next}. 用参考知识库补充已有大项的具体内容，不要仅因知识库出现新话题就新增大项。`);
  }
  if (hasOriginalPlan) {
    next += 1;
    principles.push(`${next}. 用原方案补充已有大项的具体内容；原方案与招标明确事实冲突时，原方案已落地的安排优先替换对应 bullet。不要仅因原方案出现新话题就新增大项。`);
  }
  return principles.join('\n');
}

function createGlobalFactsPrompt({ fileCatalog, hasKnowledge, hasOriginalPlan, globalFactsMode }) {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：整理后续技术方案正文必须统一采用的全局事实变量，写入 ${GLOBAL_FACTS_OUTPUT_FILE}。

工作流程由你自主安排，但必须遵守下面的材料用途和先后原则。

材料用途：
${fileCatalog}

工作原则：
${buildWorkPrinciples({ hasKnowledge, hasOriginalPlan })}

缺具体值时的写法：
${buildMissingValueRule(globalFactsMode)}

输出：
1. 只写入 ${GLOBAL_FACTS_OUTPUT_FILE}，必须是纯 JSON，不要 Markdown 代码块。
2. 根对象只有 groups；每项包含 id、title、content。
3. 程序已为该文件预置 Schema。写入后调用 json-validation，只传 {"file_path":"${GLOBAL_FACTS_OUTPUT_FILE}"}；失败则先改文件再校验，直到通过。

格式示意：
${buildJsonExample(globalFactsMode)}`;
}

async function runGlobalFactsTaskV2({
  agentService,
  workspaceStore,
  knowledgeBaseService,
  updateTask,
  checkpointTask,
  taskControl,
  payload,
}) {
  let logs = ['开始生成全局事实变量。'];
  let currentProgress = 5;
  let task = checkpointTask({ status: 'running', progress: currentProgress, logs }, { globalFacts: [] }).task;

  function publish(message, progress, statsPatch = {}) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    currentProgress = Math.max(currentProgress, progress || currentProgress);
    task = updateTask({
      status: 'running',
      progress: currentProgress,
      logs,
      stats: { ...(task.stats || {}), ...statsPatch },
    });
  }

  function updateAgentState(partial = {}) {
    const checkpoint = checkpointTask({
      stats: {
        ...(task.stats || {}),
        agent: {
          ...(task.stats?.agent || {}),
          task_key: GLOBAL_FACTS_AGENT_TASK_KEY,
          run_id: task.task_id,
          resume_payload: {
            globalFactsMode: payload?.globalFactsMode || payload?.global_facts_mode,
          },
          ...partial,
        },
      },
    });
    task = checkpoint.task;
  }

  function publishAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;
    publish(title, Math.max(currentProgress, 20));
  }

  function syncAgentCheckpoint(checkpoint) {
    updateAgentState({
      status: checkpoint.status,
      phase: checkpoint.phase,
      agent_connection: checkpoint.agent_connection,
      session_file: checkpoint.session_file,
    });
  }

  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const globalFactsMode = normalizeGlobalFactsMode(payload?.globalFactsMode || payload?.global_facts_mode || storedPlan.globalFactsMode);
  const tenderSources = collectTenderSourceFiles(workspaceStore, storedPlan);
  if (!tenderSources.length) {
    throw new Error('请先上传招标文件，再生成全局事实');
  }

  const outlineData = storedPlan.outlineData;
  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成全局事实');
  }

  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
    originalPlanMarkdown = String(workspaceStore.readOriginalPlanMarkdown?.() || '').trim();
    if (!originalPlanMarkdown) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
  }

  const selectedSectionId = storedPlan.tenderFile?.selectedSectionId;
  const selectedSection = selectedSectionId && Array.isArray(storedPlan.bidSections)
    ? storedPlan.bidSections.find((section) => section.id === selectedSectionId)
    : null;
  const usingWorkingCopy = tenderSources.some((source) => source.isWorkingCopy);
  const sectionHint = usingWorkingCopy
    ? buildBidSectionContextHint(selectedSection, {
      hasSelectedSection: true,
    })
    : '';

  const referenceDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const knowledgeItems = referenceDocumentIds.length
    ? loadKnowledgeItems(knowledgeBaseService, referenceDocumentIds, publish)
    : [];
  if (!referenceDocumentIds.length) {
    publish('未选择参考知识库。', 8);
  }

  publish('正在准备全局事实工作区材料。', 12);

  const tenderFiles = tenderSources.map((source, index) => {
    if (source.isWorkingCopy) {
      return {
        path: '招标文件/招标文件-当前投标范围.md',
        content: source.markdown,
      };
    }
    const fileName = sanitizeFileName(source.fileName, `招标文件${index + 1}`);
    return {
      path: `招标文件/招标文件-${padIndex(index)}-${fileName}.md`,
      content: source.markdown,
    };
  });
  const files = [
    ...tenderFiles,
    { path: '项目概述.md', content: String(storedPlan.projectOverview || '').trim() || '未提供项目概述。' },
    { path: '招标解析结果.md', content: formatBidAnalysisFactsForPrompt(storedPlan) },
    { path: '技术方案目录.md', content: formatOutlineForPrompt(outlineData.outline || []) },
  ];
  if (sectionHint) {
    files.push({ path: '标段说明.md', content: sectionHint });
  }
  knowledgeItems.forEach((item, index) => {
    files.push({
      path: `参考知识库/条目-${index + 1}.md`,
      content: formatKnowledgeItemFile(item),
    });
  });
  if (originalPlanMarkdown) {
    files.push({ path: '原方案.md', content: originalPlanMarkdown });
  }

  const fileCatalog = buildFileCatalog({
    tenderPaths: tenderFiles.map((file) => file.path),
    isWorkingCopy: usingWorkingCopy,
    hasSectionHint: Boolean(sectionHint),
    knowledgeCount: knowledgeItems.length,
    hasOriginalPlan: Boolean(originalPlanMarkdown),
  });
  files.push({
    path: '材料说明.md',
    content: `本次任务实际提供的材料如下。只使用这些文件，不要猜测未提供的材料。\n\n${fileCatalog}`,
  });

  const prompt = createGlobalFactsPrompt({
    fileCatalog,
    hasKnowledge: knowledgeItems.length > 0,
    hasOriginalPlan: Boolean(originalPlanMarkdown),
    globalFactsMode,
  });

  updateAgentState({ status: 'running', phase: 'global-facts', agent_connection: 'running', session_file: '' });
  publish('Agent 正在整理全局事实变量。', 18);

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '全局事实变量生成',
    prompt,
    output_file: GLOBAL_FACTS_OUTPUT_FILE,
    files,
    signal: taskControl.signal,
    persistent_task: {
      task_key: GLOBAL_FACTS_AGENT_TASK_KEY,
      mode: 'create',
    },
    initial_stage: 'global-facts',
    initial_stage_index: 0,
    json_validation_schemas: {
      [GLOBAL_FACTS_OUTPUT_FILE]: GLOBAL_FACTS_JSON_SCHEMA,
    },
    max_retries: 0,
    onActivity: publishAgentActivity,
    onCheckpoint: syncAgentCheckpoint,
  });

  const generated = readJson(agentResult.output_content, GLOBAL_FACTS_OUTPUT_FILE);
  const normalized = normalizeGlobalFactsResponse(generated);
  validateGlobalFactsResponse(normalized);

  publish(`全局事实变量整理完成：${normalized.groups.length} 个大项。`, 95);
  const finalCheckpoint = checkpointTask(
    { status: 'success', progress: 100, logs: [...logs, '全局事实变量生成完成。'] },
    { globalFacts: normalized.groups },
  );
  task = finalCheckpoint.task;
  agentService.updatePersistentTask(GLOBAL_FACTS_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

module.exports = {
  GLOBAL_FACTS_OUTPUT_FILE,
  GLOBAL_FACTS_JSON_SCHEMA,
  readJson,
  formatProgressTitle,
  runGlobalFactsTaskV2,
};
