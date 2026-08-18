const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');
const {
  buildOutlineTemplateMarkdown,
  formatProjectInfo,
} = require('./feasibilityReportPrompts.cjs');

const OUTLINE_OUTPUT_FILE = 'outline.json';
const TITLE_PREFIX_PATTERN = /^第?[一二三四五六七八九十百零〇\d.、\s]+[章节篇]?\s*/;

function createOutlineNodeSchema(level) {
  const properties = {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
  };
  if (level < 3) {
    properties.children = {
      type: 'array',
      minItems: 1,
      items: createOutlineNodeSchema(level + 1),
    };
  }
  return {
    type: 'object',
    required: ['title', 'description'],
    additionalProperties: false,
    properties,
  };
}

const OUTLINE_JSON_SCHEMA = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: createOutlineNodeSchema(1),
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

function trimToThreeLevels(items = [], level = 1) {
  return (items || []).map((item) => {
    if (level >= 3 || !item.children?.length) {
      const leaf = { ...item };
      delete leaf.children;
      return leaf;
    }
    return { ...item, children: trimToThreeLevels(item.children, level + 1) };
  });
}

function assignOutlineIds(items = [], prefix = '') {
  return (items || []).map((item, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    const children = item.children?.length ? assignOutlineIds(item.children, id) : undefined;
    return {
      id,
      title: String(item.title || '未命名章节').trim() || '未命名章节',
      description: String(item.description || '').trim(),
      ...(children ? { children } : {}),
    };
  }).slice(0, prefix ? 20 : 16);
}

function normalizeOutline(items = [], level = 1) {
  if (!Array.isArray(items) || level > 3) return [];
  return items.map((item) => {
    const title = String(item?.title || '').replace(TITLE_PREFIX_PATTERN, '').trim();
    const children = normalizeOutline(item?.children, level + 1);
    return {
      title: title || '未命名章节',
      description: String(item?.description || '').trim(),
      ...(children.length ? { children } : {}),
    };
  }).filter((item) => (item.title && item.title !== '未命名章节') || String(item.description || '').trim() || item.children?.length);
}

function buildAgentOutlineInput(outlineData) {
  const strip = (items) => (items || []).map((item) => {
    const hasChildren = Array.isArray(item?.children) && item.children.length;
    return {
      id: String(item?.id || ''),
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      ...(hasChildren ? { children: strip(item.children) } : {}),
    };
  });
  return { outline: strip(outlineData?.outline || []) };
}

function formatKnowledgeItemFile(item) {
  const title = String(item?.title || '知识库条目').trim();
  const resume = String(item?.resume || '').trim() || '无';
  const content = String(item?.content || '').trim();
  return `# ${title}\n\n简介：${resume}\n\n${content}`.trim();
}

function loadKnowledgeItems(knowledgeBaseService, documentIds) {
  if (!Array.isArray(documentIds) || !documentIds.length || !knowledgeBaseService?.readReferences) return [];
  const items = [];
  const seen = new Set();
  try {
    const references = knowledgeBaseService.readReferences(documentIds) || [];
    for (const reference of Array.isArray(references) ? references : []) {
      if (reference?.document?.status && reference.document.status !== 'success') continue;
      const documentId = String(reference?.document?.id || '').trim();
      for (const item of Array.isArray(reference?.items) ? reference.items : []) {
        const itemId = String(item?.id || '').trim();
        const title = String(item?.title || '').trim();
        const content = String(item?.content || '').trim();
        const resume = String(item?.resume || item?.summary || '').trim();
        if (!title || (!content && !resume)) continue;
        const id = `${documentId}::${itemId || title}`;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, title, resume, content });
      }
    }
  } catch {
    return [];
  }
  return items;
}

function buildFileCatalog({ hasKnowledge }) {
  const lines = [
    '- 项目参数.md：用户填写的项目基础参数，用于确定目录口径；缺项按【待补充】理解，不要编造。',
    '- 资料分析.md：STEP 03 已提取的九板块事实，是细化二三级目录的主要依据。',
    '- 大纲模板.md：必须覆盖的一级章节，以及可按项目调整的建议二级目录。',
  ];
  if (hasKnowledge) {
    lines.push('- 参考知识库/条目-*.md：补充已有章节的写作重点，不要仅因知识库出现新话题就新增一级章。');
  }
  lines.push('- 材料说明.md：本次实际提供的文件清单，与上述用途一致。');
  return lines.join('\n');
}

function createFeasibilityOutlinePrompt({ fileCatalog, hasKnowledge, targetWords }) {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：在给定大纲框架内形成完整、可执行、可编辑的三级以内可行性研究报告目录，写入 ${OUTLINE_OUTPUT_FILE}。

材料用途：
${fileCatalog}

工作原则：
1. 你是可行性研究报告总编。一级目录原则上保留大纲模板主框架；项目明显不适用时可以合并或调整，但不得遗漏结论、风险、影响和投资相关内容。
2. 二、三级目录必须结合本项目资料具体化，避免只有空泛通用标题。大纲模板中的建议二级目录只是参考，可按资料合并、拆分或改写。
3. description 写明本节应论证的重点、已知资料和缺失资料处理要求。
4. 不要输出正文 content，不要编造金额、财务指标或资料中尚未出现的项目事实。本阶段不计算 NPV、IRR 或投资回收期。
5. 目录最多三级。title 只写纯标题，不要带章节编号或 Markdown 标记。
6. 目标总字数约 ${Number(targetWords) || 30000} 字，叶子章节的 description 应能支撑后续按该总量分配写作。
${hasKnowledge ? '7. 用参考知识库补充已有章节的写作重点，不要仅因知识库出现新话题就新增一级章。' : ''}

输出：
1. 只写入 ${OUTLINE_OUTPUT_FILE}，必须是纯 JSON，不要 Markdown 代码块。
2. 根对象只有 outline；每项包含 title、description，非叶子项再包含 children。
3. 程序已为该文件预置 Schema。写入后调用 json-validation，只传 {"file_path":"${OUTLINE_OUTPUT_FILE}"}；失败则先改文件再校验，直到通过。

格式示意：
{
  "outline": [
    {
      "title": "概述",
      "description": "本章说明",
      "children": [
        {
          "title": "项目概况",
          "description": "本节写作重点",
          "children": [
            {
              "title": "建设内容与规模",
              "description": "叶子章节写作重点"
            }
          ]
        }
      ]
    }
  ]
}`;
}

function finalizeOutline(raw) {
  const outline = assignOutlineIds(trimToThreeLevels(normalizeOutline(raw?.outline || [])));
  if (!outline.length) throw new Error('模型未返回可用目录');
  return outline;
}

async function runFeasibilityOutlineTask({
  agentService,
  workspaceStore,
  knowledgeBaseService,
  updateTask,
  checkpointTask,
  taskControl,
}) {
  const state = workspaceStore.loadFeasibilityReport();
  if (!String(state.analysisMarkdown || '').trim()) throw new Error('请先完成资料分析');

  let logs = ['开始生成报告目录。'];
  let currentProgress = 8;
  let task = checkpointTask({ status: 'running', progress: currentProgress, logs }).task;

  function publish(message, progress) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    currentProgress = Math.max(currentProgress, progress || currentProgress);
    task = updateTask({ status: 'running', progress: currentProgress, logs });
  }

  function updateAgentState(partial = {}) {
    const checkpoint = checkpointTask({
      stats: {
        ...(task.stats || {}),
        agent: {
          ...(task.stats?.agent || {}),
          task_key: FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
          run_id: task.task_id,
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

  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, state.referenceDocumentIds || []);
  publish(knowledgeItems.length ? `已读取 ${knowledgeItems.length} 条知识库参考。` : '本次未使用知识库条目。', 12);
  publish('正在准备目录生成工作区材料。', 16);

  const files = [
    { path: '项目参数.md', content: formatProjectInfo(state.projectInfo) },
    { path: '资料分析.md', content: String(state.analysisMarkdown || '').trim() || '资料未提供。' },
    { path: '大纲模板.md', content: buildOutlineTemplateMarkdown(state.outlineTemplate, state.targetWords) },
  ];
  knowledgeItems.forEach((item, index) => {
    files.push({
      path: `参考知识库/条目-${index + 1}.md`,
      content: formatKnowledgeItemFile(item),
    });
  });
  const fileCatalog = buildFileCatalog({ hasKnowledge: knowledgeItems.length > 0 });
  files.push({
    path: '材料说明.md',
    content: `本次任务实际提供的材料如下。只使用这些文件，不要猜测未提供的材料。\n\n${fileCatalog}`,
  });

  updateAgentState({ status: 'running', phase: 'feasibility-outline', agent_connection: 'running', session_file: '' });
  publish('Agent 正在生成报告目录。', 22);

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '可研报告目录生成',
    prompt: createFeasibilityOutlinePrompt({
      fileCatalog,
      hasKnowledge: knowledgeItems.length > 0,
      targetWords: state.targetWords,
    }),
    output_file: OUTLINE_OUTPUT_FILE,
    files,
    signal: taskControl.signal,
    persistent_task: {
      task_key: FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
      mode: 'create',
    },
    initial_stage: 'feasibility-outline',
    initial_stage_index: 0,
    json_validation_schemas: {
      [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA,
    },
    max_retries: 0,
    onActivity: publishAgentActivity,
    onCheckpoint: syncAgentCheckpoint,
  });

  const outline = finalizeOutline(readJson(agentResult.output_content, OUTLINE_OUTPUT_FILE));
  publish(`已生成 ${outline.length} 个一级目录。`, 95);
  checkpointTask({ status: 'success', progress: 100, logs: [...logs, '报告目录生成完成。'] }, {
    outlineData: {
      outline,
      project_name: state.projectInfo.projectName,
      project_overview: String(state.analysisMarkdown || '').slice(0, 400),
    },
    keyParametersMarkdown: '',
    outlineAdjustmentTask: null,
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

module.exports = {
  OUTLINE_OUTPUT_FILE,
  OUTLINE_JSON_SCHEMA,
  readJson,
  formatProgressTitle,
  buildAgentOutlineInput,
  finalizeOutline,
  runFeasibilityOutlineTask,
};
