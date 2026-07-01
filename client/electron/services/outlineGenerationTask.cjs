const { getBidAnalysisTasks } = require('./bidAnalysisTask.cjs');

function formatSuggestions(suggestions) {
  if (!suggestions?.length) return '';
  return `\n\n本轮修正建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

function formatOldOutlineForPrompt(oldOutline) {
  if (!oldOutline) return '';
  return typeof oldOutline === 'string' ? oldOutline : JSON.stringify(oldOutline, null, 2);
}

function formatOutlineItemLabel(item, fallback = '未命名目录') {
  const id = String(item?.id || '').trim();
  const title = String(item?.title || '').trim() || fallback;
  return id ? `${id} ${title}` : title;
}

function childrenOutlineJsonExample(parentId) {
  const id = String(parentId || '1').trim() || '1';
  return `{
  "children": [
    {
      "id": "${id}.1",
      "title": "二级目录标题",
      "description": "二级目录说明",
      "children": [
        {
          "id": "${id}.1.1",
          "title": "三级目录标题",
          "description": "三级目录说明"
        },
        {
          "id": "${id}.1.2",
          "title": "三级目录标题",
          "description": "三级目录说明"
        }
      ]
    }
  ]
}`;
}

function childrenOutlineFixedStructureRules() {
  return `结构要求：
1. 顶层 children 只能放当前一级目录的直接子目录，也就是二级目录。
2. 每个二级目录都必须包含非空 children 数组，children 内是三级目录。
3. 不要把评分细项直接作为没有子节点的二级目录；应先归纳二级主题，再在其下展开三级响应要点、实施措施、证明材料或验收标准。
4. 三级目录只包含 id、title、description，不要继续包含 children。`;
}

function childrenOutlineParentNumberingRules(parentId) {
  const id = String(parentId || '1').trim() || '1';
  return `当前一级目录编号要求：
1. 编号必须以当前一级目录编号 ${id} 为前缀，例如二级 ${id}.1，三级 ${id}.1.1。

返回示例：
${childrenOutlineJsonExample(id)}`;
}

function childrenOutlineStructureRules(parentId) {
  return `${childrenOutlineFixedStructureRules()}

${childrenOutlineParentNumberingRules(parentId)}`;
}

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const KNOWLEDGE_CONTEXT_LIMIT_RATIO = 0.7;
const MAX_KNOWLEDGE_ADDITIONS = 60;
const MAX_KNOWLEDGE_UPDATES = 120;
const PROMPT_CACHE_WARMUP_DELAY_MS = 5000;

function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}
const FINAL_AGENT_OUTPUT_FILE = 'outline-agent-result.json';
const FINAL_AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const RECOVERABLE_OLD_OUTLINE_ERRORS = ['模型返回的旧方案目录数据格式无效'];
const RECOVERABLE_REQUIREMENT_GROUP_ERRORS = ['模型返回的技术评分大类格式无效'];
const RECOVERABLE_ALIGNED_OUTLINE_ERRORS = [
  '模型返回的目录数据格式无效',
  '子目录不能为空',
  '完整目录至少需要三级结构',
  '一级目录数量必须与技术评分大类数量一致',
  '一级目录标题必须严格等于技术评分大类标题',
  '一级目录映射的技术评分大类ID不正确',
];
const RECOVERABLE_FINAL_REVIEW_ERRORS = ['模型返回的最终目录审核结果格式无效'];

function renderKnowledgeItemForPrompt(item, index) {
  return [
    `## 知识条目 ${index + 1}`,
    `title: ${String(item.title || '').trim()}`,
    `resume:\n${String(item.resume || '').trim()}`,
  ].join('\n');
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function getMessagesContentLength(messages) {
  return (messages || []).reduce((sum, message) => sum + String(message?.role || 'user').length + String(message?.content || '').length + 64, 0);
}

function getKnowledgeSegmentLimit(aiService, sharedMessages) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const contextLengthLimit = normalizePositiveInteger(config?.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
  const requestBudget = Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
  const fixedMessagesLength = getMessagesContentLength(generateKnowledgePatchMessages(sharedMessages, { index: 999, total: 999, content: '' }));
  return Math.max(1, requestBudget - fixedMessagesLength);
}

function buildKnowledgeSegments(knowledgeItems, aiService, sharedMessages) {
  const segmentLimit = getKnowledgeSegmentLimit(aiService, sharedMessages);
  const blocks = (knowledgeItems || [])
    .map((item, index) => renderKnowledgeItemForPrompt(item, index))
    .filter((block) => block.trim());
  const segments = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    segments.push({ content: current.join('\n\n'), itemCount: current.length, contentLength: currentLength });
    current = [];
    currentLength = 0;
  };

  for (const block of blocks) {
    const nextLength = currentLength + block.length + (current.length ? 2 : 0);
    if (current.length && nextLength > segmentLimit) {
      flush();
    }
    current.push(block);
    currentLength += block.length + (current.length > 1 ? 2 : 0);
  }
  flush();

  return segments.map((segment, index) => ({ ...segment, index: index + 1, total: segments.length, segmentLimit }));
}

function formatKnowledgePatchOutlineContext(items) {
  const lines = [];
  function visit(nodes, level = 1, ancestors = []) {
    (nodes || []).forEach((item) => {
      const id = String(item?.id || '').trim();
      const title = String(item?.title || '').trim();
      const description = String(item?.description || '').trim();
      const updateState = level === 1 ? 'update:locked' : 'update:allowed';
      const addState = level >= 1 && level <= 3 ? `add:L${level + 1}` : 'add:locked';
      const parentTitle = ancestors.length ? ` | parent:${ancestors[ancestors.length - 1].title || '未命名目录'}` : '';
      lines.push(`${id || 'unknown'} | L${level} | ${updateState} | ${addState}${parentTitle} | ${title || '未命名目录'} | ${description}`);
      if (item?.children?.length) visit(item.children, level + 1, [...ancestors, { id, title }]);
    });
  }
  visit(items || []);
  return lines.join('\n');
}

function getMissingRequiredBidAnalysisLabels(storedPlan) {
  const bidAnalysisTasks = storedPlan?.bidAnalysisTasks || {};
  return getBidAnalysisTasks('key')
    .filter((task) => {
      const state = bidAnalysisTasks[task.id];
      return state?.status !== 'success' || !String(state.content || '').trim();
    })
    .map((task) => task.label);
}

function normalizeReferenceDocumentIds(payload) {
  return Array.isArray(payload?.reference_knowledge_document_ids)
    ? [...new Set(payload.reference_knowledge_document_ids.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

function normalizeOutlineExpansionMode(payload, storedPlan) {
  const value = payload?.outline_expansion_mode || payload?.outlineExpansionMode || storedPlan?.outlineExpansionMode;
  return value === 'original-only' ? 'original-only' : 'ai-complement';
}

function loadOutlineKnowledgeItems(knowledgeBaseService, documentIds, log) {
  if (!documentIds.length) return [];
  if (!knowledgeBaseService?.getOutlineReferences) {
    log('未找到知识库读取服务，跳过参考知识库。', 6);
    return [];
  }

  try {
    log(`正在读取 ${documentIds.length} 个参考知识库文档。`, 6);
    const result = knowledgeBaseService.getOutlineReferences(documentIds);
    const items = Array.isArray(result?.items) ? result.items : [];
    log(items.length ? `已读取 ${items.length} 条轻量知识条目。` : '未读取到可用知识库条目，将按普通目录生成。', 7);
    return items;
  } catch (error) {
    log(`读取参考知识库失败，将按普通目录生成：${error.message || String(error)}`, 7);
    return [];
  }
}

function readExpandOutlinePrompt(options = {}) {
  const lead = options.omitExpertRole
    ? '请严格基于用户提交的标书技术方案原文完成目录提取任务。'
    : '你是一个专业的标书编写专家。请严格基于用户提交的标书技术方案原文完成目录提取任务。';
  return `${lead}

要求：
1. 目录结构要全面覆盖技术标的所有必要目录，包含多级目录
2. 如果技术方案中有章节名称，则直接使用技术方案中的章节名称
3. 如果技术方案中没有章节名称，则结合全文，总结出章节名称
4. 返回标准 JSON 格式，包含章节编号、标题、描述和子章节，注意编号要连贯
5. 除了 JSON 结果外，不要输出任何其他内容

JSON 格式要求：
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": "",
      "children": [
        {
          "id": "1.1",
          "title": "",
          "description": "",
          "children": [
            {
              "id": "1.1.1",
              "title": "",
              "description": ""
            }
          ]
        }
      ]
    }
  ]
}`;
}

function buildOriginalPlanSourceMessage(fileContent) {
  return { role: 'user', content: `以下是技术方案，请先完整阅读：\n\n${fileContent}` };
}

function buildOriginalOutlineExtractionInstructionMessage(options = {}) {
  return {
    role: 'user',
    content: `${readExpandOutlinePrompt(options)}

请从上述技术方案中提取完整目录结构，确保覆盖技术标的所有必要目录，并按要求返回标准 JSON。`,
  };
}

function buildExpandOutlineMessages(fileContent) {
  return [
    buildOriginalPlanSourceMessage(fileContent),
    buildOriginalOutlineExtractionInstructionMessage(),
  ];
}

function buildOriginalOutlineAdditionsMessages(originalPlanMarkdown, extractedOutline) {
  return [
    buildOriginalPlanSourceMessage(originalPlanMarkdown),
    { role: 'user', content: `第一次提取出的目录 JSON：\n${JSON.stringify(extractedOutline, null, 2)}` },
    {
      role: 'user',
      content: `你是一个严格的旧方案目录补漏专家。请基于原方案全文和第一次提取出的目录，检查是否遗漏了明显章节。

本轮只做补漏，不重新生成完整目录。请只返回需要补充的目录项 JSON。

要求：
1. 只返回补充项，不要返回完整目录。
2. 不要修改、删除、重命名、重排已有目录。
3. parent_id 为空字符串表示追加为新的一级目录；parent_id 不为空时必须逐字复制第一次目录 JSON 中已有的 id。
4. title 必须是目录标题；description 是目录说明，缺失时可用标题含义概括。
5. children 可选，用于补充下级目录；不要输出超过三级目录深度的内容。
6. 不要依赖或生成最终编号，程序会在合并后重新编号。
7. 如果没有明确遗漏，返回 {"additions":[]}。
8. 只返回 JSON，不要输出解释文字。

返回格式：
{
  "additions": [
    {
      "parent_id": "1.2",
      "title": "补充目录标题",
      "description": "补充目录说明",
      "children": [
        { "title": "补充子目录标题", "description": "补充子目录说明" }
      ]
    }
  ]
}`,
    },
  ];
}

function buildOutlineSharedContextMessages({ overview, requirements, oldOutline }) {
  const messages = [
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
  ];
  const formattedOldOutline = formatOldOutlineForPrompt(oldOutline);
  if (formattedOldOutline) {
    messages.push({ role: 'user', content: `已有目录：\n${formattedOldOutline}` });
  }
  return messages;
}

function extractRequirementGroupsMessages({ overview, requirements, oldOutline }, suggestions) {
  const instructionPrompt = `你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质等非技术类条目
2. 每个大类都必须适合作为技术标一级目录标题，标题要专业、简洁、完整
3. 同一大类下的细项、子项、分值说明、评分标准要归入 detail_points，不要拆成多个一级目录
4. requirement_id 必须唯一，使用 R1、R2、R3 这种格式
5. description 需要概括该大类关注的核心内容
6. detail_points 中保留该大类下的关键评分细项，使用简洁短句
7. 如果提供了“已有目录”，提取结果用于识别原目录未覆盖的评分项缺口，在已有目录上补齐，不要重构、删除、重排原目录
8. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出任何其他内容

JSON 格式要求：
{
  "groups": [
    {
      "requirement_id": "R1",
      "title": "",
      "description": "",
      "detail_points": ["", ""]
    }
  ]
}`;
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `${instructionPrompt}\n\n请提取所有适合作为技术标一级目录的技术评分大类，保持顺序稳定，并把每个大类下的评分细项归入 detail_points。${formatSuggestions(suggestions)}` },
  ];
}

function generateAlignedChildrenMessages({ overview, requirements, parentItem, group, oldOutline, suggestions }) {
  const detailLines = (group.detail_points || [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item}`)
    .join('\n');
  const detailContent = detailLines || '- 未提供明确细项，请根据评分大类描述合理展开';
  const suggestionText = formatSuggestions(suggestions).trim();
  const instructionPrompt = `你是一个专业的标书编写专家。请围绕指定的技术评分大类，为已经固定好的一级目录生成二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他评分大类内容
4. 如果提供了原方案目录基础，当前输出是补充候选目录，应尽量复用原目录中相关表达，只补充缺失内容，不要提出删除或重排原目录
5. 返回标准 JSON，格式为 {"children": [...]}，每个节点必须包含 id、title、description
6. 除了 JSON 结果外，不要输出任何其他内容

${childrenOutlineFixedStructureRules()}`;
  const messages = [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${group.requirement_id}\n标题：${group.title}\n描述：${group.description}\n细项：\n${detailContent}` },
    { role: 'user', content: childrenOutlineParentNumberingRules(parentItem.id) },
  ];
  if (suggestionText) {
    messages.push({ role: 'user', content: suggestionText });
  }
  messages.push({ role: 'user', content: '请基于以上资料，只返回当前一级目录下的 {"children": [...]} JSON。' });
  return messages;
}

function generateChildrenStructureRepairMessages({ invalidContent, issues }, parentItem, group) {
  const detailLines = (group?.detail_points || [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item}`)
    .join('\n');
  const groupBlock = group ? `
当前对应的技术评分大类：
requirement_id：${group.requirement_id || ''}
标题：${group.title || ''}
描述：${group.description || ''}
细项：
${detailLines || '- 未提供明确细项'}` : '';
  return [
    {
      role: 'user',
      content: `你是一个严格的 JSON 修复器。请把模型输出修复为“当前一级目录下的二级和三级目录”JSON。

必须满足：
1. 顶层只能有 children 数组，不要输出一级目录本身
2. 顶层 children 是二级目录，每个二级目录都必须包含非空 children 数组
3. 二级目录的 children 内是三级目录，三级目录只包含 id、title、description，不要继续包含 children
4. 优先保留原结果中的二级目录标题、说明和顺序，只在每个二级目录下补齐合理三级目录
5. 不要把评分细项直接作为没有子节点的二级目录
6. 只返回 JSON，不要输出解释文字

${childrenOutlineStructureRules(parentItem?.id)}`,
    },
    { role: 'user', content: `当前一级目录：
编号：${parentItem?.id || ''}
标题：${parentItem?.title || ''}
描述：${parentItem?.description || ''}${groupBlock}` },
    { role: 'user', content: `错误列表：
${(issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n')}` },
    { role: 'user', content: `待修复内容：
\`\`\`json
${String(invalidContent || '').slice(0, 60000)}
\`\`\`` },
  ];
}

function getFinalOutlineModeLabel(context) {
  if (context.workflowKind !== 'existing-plan-expansion') return '普通技术方案目录生成';
  return context.outlineExpansionMode === 'original-only' ? '已有方案扩写-仅使用原方案目录' : '已有方案扩写-AI补充目录';
}

function getFinalOutlineConstraintText(context) {
  if (context.workflowKind !== 'existing-plan-expansion') {
    return `硬性约束：
1. 一级目录必须与提供的 groups 数量一致、顺序一致、标题完全一致。
2. 每个一级目录的 source_requirement_id 必须等于对应 group.requirement_id。
3. 完整目录整体至少包含三级结构。`;
  }
  if (context.outlineExpansionMode === 'original-only') {
    return `硬性约束：
1. 完整目录整体至少包含三级结构。
2. 目录层级不能超过四级。
3. 优先保留原方案目录结构和表达，但允许为了覆盖评分要求做必要修复。`;
  }
  return `硬性约束：
1. 原方案已有一级目录必须作为最终目录前缀保留，不能删除或重排。
2. 完整目录整体至少包含三级结构。
3. 目录层级不能超过四级。`;
}

function buildFinalOutlineReviewMessages(context) {
  const messages = [
    { role: 'user', content: `项目概述：\n${context.payload?.overview || ''}` },
    { role: 'user', content: `技术评分要求：\n${context.payload?.requirements || ''}` },
  ];
  messages.push(
    { role: 'user', content: `待最终审核目录 JSON：\n${JSON.stringify(context.outline, null, 2)}` },
    {
      role: 'user',
      content: `你是严格的技术标目录最终审核专家。请判断待审核目录是否已经可以保存为最终目录。

审核重点：
1. 是否覆盖技术评分要求中的关键评分项。
2. 是否存在明显重复、归属错位、遗漏或结构不合理。
3. 如果不通过，suggestions 必须给出具体、局部、可执行的修改建议。

只返回 JSON，格式为 {"passed": true, "suggestions": []}，不要返回完整目录，不要输出解释文字。`,
    },
  );
  return messages;
}

function getFinalAgentOutputShape(context) {
  const isAligned = context.workflowKind !== 'existing-plan-expansion';
  return isAligned
    ? `{
  "groups": [
    {
      "requirement_id": "R1",
      "title": "一级目录标题，必须与对应一级目录 title 完全一致",
      "description": "评分大类说明",
      "detail_points": ["评分细项"]
    }
  ],
  "outline": []
}`
    : `{
  "outline": []
}`;
}

function buildOriginalOutlineExtractionAgentPrompt(context) {
  const outputFile = context.outputFile;
  const reason = String(context.recoveryReason || '').trim();
  return `请在当前工作目录中完成原方案目录提取，并把可供程序读取的结果保存到 ${outputFile}。

${reason ? `本次恢复触发原因：${reason}\n` : ''}workspace 文件说明：
- original-plan.md：用户提交的原方案全文，是提取旧目录的主要依据。
- final-review.json：如果存在，记录本次切换到 Agent 的原因或程序审核意见，可作为排查参考。

工作方式由你自行决定。可以按章节标题、编号、目录页、正文层级或关键词逐步定位，也可以创建草稿、索引、中间 JSON 或笔记文件辅助分析；不需要一次性读完或一次性写完。

最终需要的结果：
- 提取原方案已有目录、章节标题和明显隐含章节，不改写成新标书目录。
- 如果原文存在明确章节编号和标题，优先保留原文表达；如果没有明确编号，可按原文结构归纳章节标题。
- 目录最多保留四级，节点只包含 id、title、description 和 children。
- 编号可以自行整理，程序会再次统一编号；但层级关系需要正确。
- 任务结束时，${outputFile} 是可被 JSON.parse 直接解析的纯 JSON 文件，不包含 Markdown 代码块或解释文字。
- JSON 顶层格式为：
{
  "outline": []
}
- 不输出 groups、正文 content、图片、表格、Mermaid、审查说明或额外字段。`;
}

function buildOutlineAgentRecoveryPrompt(context) {
  if (context.recoveryKind === 'original-outline-extraction') {
    return buildOriginalOutlineExtractionAgentPrompt(context);
  }

  const outputFile = context.outputFile;
  const outputShape = getFinalAgentOutputShape(context);
  const reason = String(context.recoveryReason || '').trim();
  return `请在当前工作目录中完成技术标目录生成或修复，并把可供程序读取的结果保存到 ${outputFile}。

当前目录生成模式：${getFinalOutlineModeLabel(context)}

${reason ? `本次恢复触发原因：${reason}\n` : ''}

workspace 文件说明：
- project-overview.md：项目概述、建设背景和投标对象。
- technical-requirements.md：技术评分要求、招标需求和需要覆盖的响应点。
- workflow.json：本次目录模式、恢复类型和程序后续校验会使用的 hard_constraints。
- current-outline.json：当前候选目录，可能为空、不完整或存在审核指出的问题。
- final-review.json：程序或模型对当前目录的审核结论、问题和修改建议。
- requirement-groups.json：如果存在，记录技术评分大类及细项，通常用于约束一级目录。
- original-outline.json：如果存在，记录用户原方案旧目录，已有方案扩写时应尽量承接其结构。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间 JSON，并逐步编辑 ${outputFile}；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部目录。

最终需要的结果：
- 生成一份可以直接保存为技术方案目录的 JSON，目录覆盖技术评分要求，并处理 final-review.json 中指出的问题。
- 如果 current-outline.json 为空或不完整，可以直接构建完整目录；如果已有目录可用，优先做定向修复。
- 如果 requirement-groups.json 存在，最终一级目录和 groups 应保持可校验的一致关系；如果你判断 groups 本身有误，可以同步修正 groups 和目录。
- 如果 original-outline.json 存在，优先在原目录基础上补充和修复，避免无目的全量重写。
- 修复可包括删除重复项、迁移错位目录、补充缺失目录、合并明显重复目录和重新编号。
- 任务结束时，${outputFile} 是可被 JSON.parse 直接解析的纯 JSON 文件，不包含 Markdown 代码块或解释文字。
- JSON 顶层格式为：
${outputShape}
- 不输出正文 content、图片、表格、Mermaid、审查说明或额外字段。
- 编号可以自行整理，程序会再次统一编号；但层级关系需要正确，并满足 workflow.json 中的 hard_constraints。`;
}

function buildOutlineAgentRecoveryFiles(context) {
  const files = [
    { path: 'project-overview.md', content: String(context.payload?.overview || '') },
    { path: 'technical-requirements.md', content: String(context.payload?.requirements || '') },
    {
      path: 'workflow.json',
      content: JSON.stringify({
        mode: getFinalOutlineModeLabel(context),
        recovery_kind: context.recoveryKind || 'final-outline-repair',
        workflow_kind: context.workflowKind,
        outline_expansion_mode: context.outlineExpansionMode,
        hard_constraints: getFinalOutlineConstraintText(context),
      }, null, 2),
    },
  ];
  if (context.recoveryKind === 'original-outline-extraction') {
    files.push({ path: 'original-plan.md', content: String(context.originalPlanMarkdown || '') });
    if (context.finalReview) {
      files.push({ path: 'final-review.json', content: JSON.stringify(context.finalReview, null, 2) });
    }
    return files;
  }

  files.push(
    { path: 'current-outline.json', content: JSON.stringify(context.outline || { outline: [] }, null, 2) },
    { path: 'final-review.json', content: JSON.stringify(context.finalReview, null, 2) },
  );
  if (context.groups?.length) {
    files.push({ path: 'requirement-groups.json', content: JSON.stringify({ groups: context.groups }, null, 2) });
  }
  if (context.originalOutline?.outline?.length) {
    files.push({ path: 'original-outline.json', content: JSON.stringify(context.originalOutline, null, 2) });
  }
  return files;
}

function createSyntheticFinalReview(reason, error) {
  const message = error?.message || String(error || reason);
  return {
    passed: false,
    suggestions: [`${reason}：${message}`],
  };
}

function getErrorMessage(error) {
  return error?.message || String(error || '未知错误');
}

function shouldForceOutlineAgentRepair(payload) {
  return Boolean(payload?.debug_force_outline_agent_repair || payload?.debugForceOutlineAgentRepair);
}

function assertRecoverableOutlineError(error, markers) {
  const message = getErrorMessage(error);
  if (!(markers || []).some((marker) => message.includes(marker))) {
    throw error;
  }
}

function extractFencedAgentJsonBlocks(content) {
  const blocks = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = pattern.exec(content);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(content);
  }
  return blocks;
}

function extractBalancedAgentJsonCandidate(content) {
  const source = String(content || '');
  const start = source.search(/[\[{]/);
  if (start < 0) return '';

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack[stack.length - 1] !== char) return '';
      stack.pop();
      if (!stack.length) return source.slice(start, index + 1);
    }
  }

  return '';
}

function parseAgentJsonContent(content) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').trim();
  const candidates = [
    normalized,
    ...extractFencedAgentJsonBlocks(normalized),
    extractBalancedAgentJsonCandidate(normalized),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];
  let lastError = null;

  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Agent 未返回可解析的目录 JSON：${lastError?.message || '内容为空'}`);
}

function attachAlignedTopLevelMetadata(outline, groups) {
  const items = cloneOutlineItems(outline.outline || []).map((item, index) => ({
    ...item,
    source_requirement_id: groups[index]?.requirement_id || item.source_requirement_id,
    source_requirement_title: groups[index]?.title || item.source_requirement_title,
  }));
  return normalizeOutlineResponse({ outline: renumber(items) }, new Set());
}

function normalizeFinalAgentRepairResult(value, context) {
  const raw = Array.isArray(value) ? { outline: value } : requireObject(value, 'FinalAgentRepairResult');
  const rawGroups = raw.groups ?? raw.requirement_groups ?? raw.requirementGroups;
  let groups = context.groups || [];
  if (rawGroups !== undefined) {
    groups = normalizeRequirementGroupsResponse({ groups: rawGroups }).groups || [];
    validateRequirementGroups({ groups });
  }
  if (context.workflowKind !== 'existing-plan-expansion' && !groups.length) {
    throw new Error('Agent 修复结果缺少技术评分大类 groups');
  }

  const outlineSource = raw.outline === undefined || raw.outline === null
    ? raw
    : Array.isArray(raw.outline)
      ? { outline: raw.outline }
      : raw.outline;
  const parsedOutline = normalizeOutlineResponse(outlineSource, new Set());
  const renumberedOutline = normalizeOutlineResponse({ outline: renumber(parsedOutline.outline || []) }, new Set());
  const outline = context.workflowKind === 'existing-plan-expansion'
    ? renumberedOutline
    : attachAlignedTopLevelMetadata(renumberedOutline, groups);
  validateFinalOutline({ ...context, outline, groups });
  return { groups, outline };
}

function normalizeOriginalOutlineAgentResult(value) {
  const raw = Array.isArray(value) ? { outline: value } : requireObject(value, 'OriginalOutlineAgentResult');
  const outlineSource = raw.outline === undefined || raw.outline === null
    ? raw
    : Array.isArray(raw.outline)
      ? { outline: raw.outline }
      : raw.outline;
  const parsedOutline = normalizeOutlineResponse(outlineSource, new Set());
  const outline = finalizeOriginalOutline(parsedOutline);
  validateTopLevelOutline(outline);
  return { outline };
}

function normalizeAgentOutlineResult(value, context) {
  if (context.recoveryKind === 'original-outline-extraction') {
    return normalizeOriginalOutlineAgentResult(value);
  }
  return normalizeFinalAgentRepairResult(value, context);
}

function isAgentBusyResult(result) {
  return result?.status === 'busy' || result?.skipped === true;
}

function createAgentBusyError() {
  const error = new Error('Agent 正在处理其他任务，请稍后重新生成或重试目录修复。');
  error.code = 'AGENT_BUSY';
  error.userVisible = true;
  return error;
}

function createAgentActivityLogHandler(log, progress) {
  let lastKey = '';
  return (event = {}) => {
    const message = String(event.message || '').trim();
    if (!message || event.visible === false) return;
    const key = `${event.stage || ''}:${message}`;
    if (key === lastKey) return;
    lastKey = key;
    log(`Agent 实时进度：${message}`, progress);
  };
}

async function runOutlineAgentRecovery(agentService, context, log) {
  if (!agentService?.runTask) {
    throw new Error('Agent 服务尚未初始化，无法执行目录自主修复');
  }

  const outputFile = context.outputFile || FINAL_AGENT_OUTPUT_FILE;
  const agentContext = { ...context, outputFile };
  log(agentContext.startLogMessage || '已切换到 Agent 自主修复目录。', agentContext.startProgress || 99);
  const agentResult = await agentService.runTask({
    title: agentContext.title || '技术方案目录自主修复',
    prompt: buildOutlineAgentRecoveryPrompt(agentContext),
    output_file: outputFile,
    files: buildOutlineAgentRecoveryFiles(agentContext),
    timeout_ms: FINAL_AGENT_TIMEOUT_MS,
    onActivity: createAgentActivityLogHandler(log, agentContext.agentProgress || agentContext.startProgress || 99),
  });
  if (isAgentBusyResult(agentResult)) {
    throw createAgentBusyError();
  }

  const content = String(agentResult?.output_content || agentResult?.assistant_text || '').trim();
  if (!content) {
    throw new Error('Agent 未返回目录修复结果');
  }

  log(agentContext.validationLogMessage || 'Agent 修复完成，正在进行程序校验。', agentContext.validationProgress || 96);
  const parsed = parseAgentJsonContent(content);
  const result = normalizeAgentOutlineResult(parsed, agentContext);
  log(agentContext.successLogMessage || 'Agent 修复结果通过程序校验，准备返回目录。', agentContext.successProgress || 98);
  return result;
}

async function repairFinalOutlineWithAgent(agentService, context, log) {
  return runOutlineAgentRecovery(agentService, {
    ...context,
    recoveryKind: context.recoveryKind || 'final-outline-repair',
    title: context.title || '技术方案目录自主修复',
    startLogMessage: context.startLogMessage || '最终目录审核未通过，已切换到 Agent 自主修复目录。',
  }, log);
}

function formatTopLevelOutlineForPrompt(outlineItems) {
  return (outlineItems || []).map((item, index) => {
    const childState = item?.children?.length ? `已有 ${countOutlineItems(item.children)} 个下级目录` : '暂无下级目录';
    return `${index + 1}. id=${item?.id || ''} | title=${item?.title || ''} | description=${item?.description || ''} | ${childState}`;
  }).join('\n');
}

function buildExpansionTopLevelComplementMessages({ overview, requirements, oldOutline }) {
  const instructionPrompt = `你是一个严格的标书目录规划专家。请基于已有目录，判断原方案一级目录是否已覆盖评分大类，并只补充缺失的一级目录。

要求：
1. 原方案已有一级目录完全锁定，不能删除、重命名、重排或要求修改。
2. 如果某个评分大类可以由原方案已有一级目录承载，请填写 existing_root_id，必须逐字复制原方案一级目录 id。
3. 如果某个评分大类无法由已有一级目录承载，请 existing_root_id 返回空字符串，表示需要追加新的一级目录。
4. 追加的新一级目录标题要专业、简洁，适合作为技术标一级目录。
5. detail_points 中保留该评分大类下的关键评分细项，使用简洁短句。
6. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出解释文字。

返回格式：
{
  "groups": [
    {
      "requirement_id": "R1",
      "title": "评分大类或拟追加一级目录标题",
      "description": "该评分大类关注的核心内容",
      "detail_points": ["评分细项"],
      "existing_root_id": "原方案一级目录id，无法承载时为空字符串"
    }
  ]
}`;
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `${instructionPrompt}\n\n请先完成一级目录补充计划：识别每个技术评分大类由哪个原方案一级目录承载，无法承载的再作为新增一级目录追加。` },
  ];
}

function formatRequirementGroupForPrompt(group) {
  const detailLines = (group?.detail_points || [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item}`)
    .join('\n');
  return `requirement_id：${group?.requirement_id || ''}
标题：${group?.title || ''}
描述：${group?.description || ''}
细项：
${detailLines || '- 未提供明确细项，请结合当前一级目录标题和技术评分要求合理补充'}`;
}

function buildExpansionChildSharedMessages({ overview, requirements }) {
  return [
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
  ];
}

function buildExpansionMissingChildrenMessages(sharedMessages, parentItem, group, suggestions) {
  const suggestionText = formatSuggestions(suggestions).trim();
  const instructionPrompt = `你是一个专业的标书编写专家。当前一级目录暂无下级目录，请为该一级目录生成完整二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录。
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身。
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他一级目录内容。
4. 返回标准 JSON，格式为 {"children": [...]}，每个节点必须包含 id、title、description。
5. 除了 JSON 结果外，不要输出任何其他内容。

${childrenOutlineFixedStructureRules()}`;
  const messages = [
    ...sharedMessages,
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `当前对应的技术评分大类：\n${formatRequirementGroupForPrompt(group)}` },
    { role: 'user', content: childrenOutlineParentNumberingRules(parentItem.id) },
  ];
  if (suggestionText) {
    messages.push({ role: 'user', content: suggestionText });
  }
  messages.push({ role: 'user', content: '请基于以上资料，只返回当前一级目录下的 {"children": [...]} JSON。' });
  return messages;
}

function buildExpansionChildPatchMessages(sharedMessages, parentItem, group, suggestions) {
  const suggestionText = formatSuggestions(suggestions).trim();
  const instructionPrompt = `你是一个严格的原方案目录补充专家。下面会提供一段需要补充的目录及其所有下级目录，请只判断是否需要追加缺失下级目录。

要求：
1. 严禁删除、重命名、重排或修改任何已有目录标题。
2. 不要返回完整目录，只返回需要追加的下级目录 additions。
3. parent_id 必须逐字复制这段目录中已有的一级或二级目录 id；不能使用三级目录作为 parent_id。
4. 新增目录最多到三级；如果 parent_id 是一级目录，可以新增二级目录并可带三级 children；如果 parent_id 是二级目录，只能新增三级目录且不能包含 children。
5. 优先补齐已有二级目录下缺失的三级响应要点、实施措施、证明材料或验收标准。
6. 如果这段目录已经充分覆盖当前技术评分大类中的相关细项，返回 {"additions":[]}。
7. 只返回 JSON，不要输出解释文字。

返回格式：
{
  "additions": [
    {
      "parent_id": "1.1",
      "title": "新增目录标题",
      "description": "新增目录说明",
      "children": [
        { "title": "可选三级目录标题", "description": "可选三级目录说明" }
      ]
    }
  ]
}`;
  const messages = [
    ...sharedMessages,
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `你应该基于下面这段目录进行补充：\n${JSON.stringify(parentItem, null, 2)}` },
    { role: 'user', content: `当前对应的技术评分大类：\n${formatRequirementGroupForPrompt(group)}` },
  ];
  if (suggestionText) {
    messages.push({ role: 'user', content: suggestionText });
  }
  messages.push({ role: 'user', content: '请只返回需要追加的 additions JSON，不要改动已有目录。' });
  return messages;
}

function buildExpansionChildPatchRepairMessages({ invalidContent, issues }, parentItem, group) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const rootId = String(parentItem?.id || '1').trim() || '1';
  const secondLevelId = String((parentItem?.children || []).find((child) => child?.id)?.id || `${rootId}.1`).trim();
  return [
    {
      role: 'user',
      content: `你是一个严格的 JSON 修复器。请把模型输出修复为“目录段下级补充 patch”JSON。

必须满足：
1. 顶层只能有 additions 数组。
2. additions 只能追加下级目录，不能包含已有目录修改。
3. parent_id 必须来自这段目录中已有的一级或二级目录 id。
4. 新增目录最多到三级，三级目录不能包含 children。
5. 优先保留待修复内容中已经出现的 parent_id、title、description，只修复 JSON 结构、截断字符串和层级合法性。
6. 如果待修复内容里的 parent_id 是三级目录，请改挂到它所属的二级目录；例如 "${secondLevelId}.1" 应改为 "${secondLevelId}"，不要直接丢弃该新增项。
7. 不要因为 JSON 截断或字符串未闭合就直接返回空 additions；只有待修复内容完全没有可恢复的新增目录信息时，才返回 {"additions":[]}。
8. 只返回 JSON，不要输出解释文字。

返回格式示例：
{
  "additions": [
    {
      "parent_id": "${secondLevelId}",
      "title": "新增三级目录标题",
      "description": "新增三级目录说明"
    },
    {
      "parent_id": "${rootId}",
      "title": "新增二级目录标题",
      "description": "新增二级目录说明",
      "children": [
        { "title": "新增三级目录标题", "description": "新增三级目录说明" }
      ]
    }
  ]
}`,
    },
    { role: 'user', content: `你应该基于下面这段目录进行补充：\n${JSON.stringify(parentItem || {}, null, 2)}` },
    { role: 'user', content: `当前对应的技术评分大类：\n${formatRequirementGroupForPrompt(group)}` },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function formatOriginalTopLevelLockContext(originalOutline) {
  return (originalOutline?.outline || []).map((item, index) => (
    `${index + 1}. id=${item?.id || ''} | title=${item?.title || ''} | description=${item?.description || ''}`
  )).join('\n');
}

function getKnowledgePatchSamples(outlineItems) {
  const entries = Array.from(createOutlineNodeMap(outlineItems || []).entries());
  return {
    updateId: entries.find(([, info]) => info.level >= 2 && info.level <= 4)?.[0] || '',
    parentId: entries.find(([, info]) => info.level >= 1 && info.level <= 3)?.[0] || '',
  };
}

function buildKnowledgePatchSharedMessages({ overview, requirements, outline }) {
  const outlineItems = outline?.outline || [];
  const samples = getKnowledgePatchSamples(outlineItems);
  const instructionPrompt = `你是一个严格的标书目录增强专家。请根据参考知识库判断当前技术标目录的非一级目录是否需要优化。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 一级目录完全锁定：严禁新增、删除、重命名、修改说明或调整一级目录顺序。
3. 禁止删除任何已有目录，禁止调整任何已有目录的父级或顺序。
4. updates 只能修改已有二级、三级、四级目录的 title 或 description；id 必须逐字复制当前目录中的现有 ID。
5. additions 只能新增二级、三级、四级目录；parent_id 必须逐字复制现有一级、二级或三级目录 ID。
6. additions 会追加到父级 children 末尾，不允许指定插入位置，不允许输出 id。
7. 新增目录最多到四级，四级目录不能包含 children。
8. 不允许输出 bindings、knowledge_item_ids、outline、完整目录、正文、图片、表格或编排计划。
9. 不要把知识库条目绑定到目录；知识库只作为判断目录是否需要优化的参考材料。
10. 只处理与项目概述、技术评分要求、现有目录主题强相关且当前目录确实缺失或表述明显不佳的内容。
11. 如果没有确实需要修改或补充的目录，返回 {"updates":[],"additions":[]}。

返回格式：
{
  "updates": [
    { "id": "${samples.updateId}", "title": "可选：修改后的目录标题", "description": "可选：修改后的目录说明" }
  ],
  "additions": [
    {
      "parent_id": "${samples.parentId}",
      "title": "新增目录标题",
      "description": "新增目录说明",
      "children": [
        { "title": "可选下级目录标题", "description": "可选下级目录说明" }
      ]
    }
  ]
}`;
  return [
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `当前完整目录 JSON：\n${JSON.stringify(outline, null, 2)}` },
    { role: 'user', content: `可操作目录上下文（每行：id | 层级 | update状态 | add状态 | 标题 | 说明）：\n${formatKnowledgePatchOutlineContext(outlineItems)}` },
  ];
}

function generateKnowledgePatchMessages(sharedMessages, knowledgeSegment) {
  return [
    ...sharedMessages,
    { role: 'user', content: `参考知识库分段 ${knowledgeSegment.index}/${knowledgeSegment.total}（resume 未截断）：\n${knowledgeSegment.content}` },
    { role: 'user', content: '请只基于当前知识库分段返回目录增强 JSON：updates 和 additions。不要输出解释文字，不要输出完整目录。' },
  ];
}

function generateKnowledgeAdditionRepairMessages({ invalidContent, issues }, outline) {
  const issueLines = Array.isArray(issues) ? issues.map((item, index) => `${index + 1}. ${item}`).join('\n') : String(issues || '');
  return [
    {
      role: 'user',
      content: `你是一个严格的 JSON 修复器。请把模型输出修复为“知识库目录增强 patch”JSON。

必须满足：
1. 顶层只能有 updates 和 additions 数组。
2. updates 只能修改已有二级、三级、四级目录的 title 或 description，禁止修改一级目录。
3. additions 只能新增二级、三级、四级目录；parent_id 必须是现有一级、二级或三级目录 ID。
4. 四级目录不能包含 children。
5. 禁止输出 bindings、knowledge_item_ids、outline、完整目录、正文、图片、表格或解释文字。
6. 如果没有可修改或补充目录，返回 {"updates":[],"additions":[]}。

可操作目录上下文（每行：id | 层级 | update状态 | add状态 | 标题 | 说明）：
${formatKnowledgePatchOutlineContext(outline?.outline || [])}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组`);
  }
  return value;
}

function requireField(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`${label} 缺失`);
  }
  return String(value);
}

function normalizeKnowledgeItemIds(value, allowedKnowledgeIds) {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = value.map((id) => String(id || '').trim()).filter(Boolean);
  if (allowedKnowledgeIds instanceof Set) {
    return [...new Set(ids.filter((id) => allowedKnowledgeIds.has(id)))];
  }
  return [...new Set(ids)];
}

function normalizeOutlineItem(item, path = 'outline[]', allowedKnowledgeIds) {
  const raw = requireObject(item, path);
  const normalized = {
    id: requireField(raw.id, `${path}.id`),
    title: requireField(raw.title, `${path}.title`),
    description: requireField(raw.description, `${path}.description`),
  };

  if (raw.source_requirement_id !== undefined && raw.source_requirement_id !== null) {
    normalized.source_requirement_id = String(raw.source_requirement_id);
  }
  if (raw.source_requirement_title !== undefined && raw.source_requirement_title !== null) {
    normalized.source_requirement_title = String(raw.source_requirement_title);
  }
  if (raw.content !== undefined && raw.content !== null) {
    normalized.content = String(raw.content);
  }
  const knowledgeItemIds = normalizeKnowledgeItemIds(raw.knowledge_item_ids, allowedKnowledgeIds);
  if (knowledgeItemIds.length) {
    normalized.knowledge_item_ids = knowledgeItemIds;
  }
  if (raw.children !== undefined && raw.children !== null) {
    const children = requireArray(raw.children, `${path}.children`);
    if (children.length) {
      normalized.children = children.map((child, index) => normalizeOutlineItem(child, `${path}.children[${index}]`, allowedKnowledgeIds));
    }
  }

  return normalized;
}

function normalizeOutlineResponse(payload, allowedKnowledgeIds) {
  const raw = requireObject(payload, 'OutlineResponse');
  const outline = requireArray(raw.outline, 'outline');
  return { outline: outline.map((item, index) => normalizeOutlineItem(item, `outline[${index}]`, allowedKnowledgeIds)) };
}

function normalizeChildrenResponse(payload, allowedKnowledgeIds) {
  const raw = requireObject(payload, 'OutlineChildrenResponse');
  const children = requireArray(raw.children, 'children');
  return { children: children.map((item, index) => normalizeOutlineItem(item, `children[${index}]`, allowedKnowledgeIds)) };
}

function normalizeReviewResponse(payload) {
  const raw = requireObject(payload, 'OutlineReviewResponse');
  let passed = raw.passed;
  if (typeof passed === 'string') {
    passed = passed.toLowerCase() === 'true';
  }
  if (typeof passed !== 'boolean') {
    throw new Error('passed 必须是布尔值');
  }
  const suggestions = raw.suggestions === undefined || raw.suggestions === null
    ? []
    : requireArray(raw.suggestions, 'suggestions').map((item) => String(item));
  return { passed, suggestions };
}

function normalizeRequirementGroupsResponse(payload) {
  const raw = requireObject(payload, 'TechnicalRequirementGroupResponse');
  const groups = requireArray(raw.groups, 'groups').map((group, index) => {
    const item = requireObject(group, `groups[${index}]`);
    return {
      requirement_id: requireField(item.requirement_id, `groups[${index}].requirement_id`),
      title: requireField(item.title, `groups[${index}].title`),
      description: requireField(item.description, `groups[${index}].description`),
      detail_points: item.detail_points === undefined || item.detail_points === null
        ? []
        : requireArray(item.detail_points, `groups[${index}].detail_points`).map((point) => String(point)),
    };
  });
  return { groups };
}

function normalizeExpansionTopLevelPlanResponse(payload) {
  const raw = requireObject(payload, 'ExpansionTopLevelPlanResponse');
  const candidates = requireArray(raw.groups || raw.items || raw.requirements, 'groups');
  const groups = candidates.map((group, index) => {
    const item = requireObject(group, `groups[${index}]`);
    return {
      requirement_id: requireField(item.requirement_id, `groups[${index}].requirement_id`),
      title: requireField(item.title, `groups[${index}].title`),
      description: requireField(item.description, `groups[${index}].description`),
      detail_points: item.detail_points === undefined || item.detail_points === null
        ? []
        : requireArray(item.detail_points, `groups[${index}].detail_points`).map((point) => String(point)),
      existing_root_id: String(item.existing_root_id ?? item.existingRootId ?? '').trim(),
    };
  });
  return { groups };
}

function normalizeExpansionChildPatchResponse(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(raw.additions)
      ? raw.additions
      : [];
  const additions = candidates.map((addition) => {
    const node = normalizeOriginalOutlineAdditionNode(addition);
    if (!node) return null;
    return {
      parent_id: String(addition?.parent_id ?? addition?.parentId ?? '').trim(),
      ...node,
    };
  }).filter(Boolean);
  return { additions };
}

function validateExpansionChildPatchResponse(payload) {
  requireArray(payload.additions, 'additions');
}

function createSyntheticRequirementGroupFromRoot(item) {
  const title = String(item?.title || '未命名章节').trim() || '未命名章节';
  return {
    requirement_id: `ROOT_${String(item?.id || '').replace(/[^0-9A-Za-z_]+/g, '_') || 'X'}`,
    title,
    description: String(item?.description || title).trim() || title,
    detail_points: [],
  };
}

function mergeRequirementGroups(base, next, titleFallback) {
  if (!base) return next;
  const ids = [base.requirement_id, next.requirement_id].map((item) => String(item || '').trim()).filter(Boolean);
  const descriptions = [base.description, next.description].map((item) => String(item || '').trim()).filter(Boolean);
  const detailPoints = [...(base.detail_points || []), ...(next.detail_points || [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return {
    requirement_id: [...new Set(ids)].join(',') || base.requirement_id || next.requirement_id,
    title: String(titleFallback || base.title || next.title || '').trim(),
    description: [...new Set(descriptions)].join('；') || base.description || next.description || titleFallback || '',
    detail_points: [...new Set(detailPoints)],
    existing_root_id: base.existing_root_id || next.existing_root_id || '',
  };
}

function createOutlineNodeMap(items) {
  const map = new Map();
  function visit(nodes, level = 1, parent = null) {
    (nodes || []).forEach((item) => {
      const id = String(item?.id || '').trim();
      if (id) {
        map.set(id, { item, level, parent });
      }
      if (item?.children?.length) {
        visit(item.children, level + 1, item);
      }
    });
  }
  visit(items || []);
  return map;
}

function normalizeTitleKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function normalizeOriginalOutlineAdditionNode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const title = String(raw.title || raw.name || raw.heading || '').trim();
  if (!title) {
    return null;
  }

  const description = String(raw.description || raw.summary || raw.resume || title).trim() || title;
  const childCandidates = Array.isArray(raw.children) ? raw.children : [];
  const children = childCandidates
    .map((child) => normalizeOriginalOutlineAdditionNode(child))
    .filter(Boolean);
  return {
    title,
    description,
    ...(children.length ? { children } : {}),
  };
}

function normalizeOriginalOutlineAdditionsResponse(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(raw.additions)
      ? raw.additions
      : [];
  const additions = candidates.map((addition) => {
    const node = normalizeOriginalOutlineAdditionNode(addition);
    if (!node) return null;
    return {
      parent_id: String(addition?.parent_id ?? addition?.parentId ?? '').trim(),
      ...node,
    };
  }).filter(Boolean);
  return { additions };
}

function createSiblingTitleKeys(items) {
  return new Set((items || []).map((item) => normalizeTitleKey(item?.title)).filter(Boolean));
}

function createOutlineItemFromOriginalAddition(addition, targetLevel) {
  if (!addition || targetLevel > 3) {
    return null;
  }

  const title = String(addition.title || '').trim();
  if (!title) {
    return null;
  }

  const item = {
    id: '',
    title,
    description: String(addition.description || title).trim() || title,
  };
  if (targetLevel < 3 && Array.isArray(addition.children) && addition.children.length) {
    const seen = new Set();
    const children = [];
    for (const child of addition.children) {
      const key = normalizeTitleKey(child?.title);
      if (!key || seen.has(key)) continue;
      const childItem = createOutlineItemFromOriginalAddition(child, targetLevel + 1);
      if (!childItem) continue;
      seen.add(key);
      children.push(childItem);
    }
    if (children.length) item.children = children;
  }
  return item;
}

function appendOriginalOutlineAddition(siblings, addition, targetLevel) {
  const item = createOutlineItemFromOriginalAddition(addition, targetLevel);
  if (!item) return 0;

  const key = normalizeTitleKey(item.title);
  if (!key || createSiblingTitleKeys(siblings).has(key)) {
    return 0;
  }

  siblings.push(item);
  return countOutlineItems([item]);
}

function countOutlineItems(items) {
  return (items || []).reduce((sum, item) => sum + 1 + countOutlineItems(item.children || []), 0);
}

function applyOriginalOutlineAdditions(outlinePayload, additions) {
  const outline = cloneOutlineItems(outlinePayload?.outline || []);
  let appliedCount = 0;
  for (const addition of additions || []) {
    const parentId = String(addition?.parent_id || '').trim();
    if (!parentId) {
      appliedCount += appendOriginalOutlineAddition(outline, addition, 1);
      continue;
    }

    const nodeMap = createOutlineNodeMap(outline);
    const parent = nodeMap.get(parentId);
    if (!parent || parent.level >= 3) {
      continue;
    }

    parent.item.children = parent.item.children || [];
    appliedCount += appendOriginalOutlineAddition(parent.item.children, addition, parent.level + 1);
  }

  return { outline: { ...outlinePayload, outline }, appliedCount };
}

function finalizeOriginalOutline(outlinePayload) {
  return normalizeOutlineResponse({
    ...outlinePayload,
    outline: renumber(outlinePayload?.outline || []),
  }, new Set());
}

function countNestedArrayEntries(value, fieldName) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countNestedArrayEntries(item, fieldName), 0);
  }
  return Object.entries(value).reduce((sum, [key, child]) => {
    const current = key === fieldName && Array.isArray(child) ? child.length : 0;
    return sum + current + countNestedArrayEntries(child, fieldName);
  }, 0);
}

function summarizeRawKnowledgeAdditions(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    updates: Array.isArray(raw.updates) ? raw.updates.length : 0,
    additions: Array.isArray(payload) ? payload.length : (Array.isArray(raw.additions) ? raw.additions.length : 0),
    bindings: Array.isArray(raw.bindings) ? raw.bindings.length : 0,
    knowledge_refs: countNestedArrayEntries(payload, 'knowledge_item_ids'),
    children: countNestedArrayEntries(payload, 'children'),
  };
}

function formatAdditionSummary(summary) {
  return `updates=${summary.updates}，additions=${summary.additions}，bindings=${summary.bindings}，knowledge_refs=${summary.knowledge_refs}，children=${summary.children}`;
}

function getKnowledgeUpdateCandidates(payload) {
  if (Array.isArray(payload)) return [];
  const raw = requireObject(payload, 'KnowledgePatchResponse');
  if (raw.updates !== undefined && raw.updates !== null) return requireArray(raw.updates, 'updates');
  if (Array.isArray(raw.edits)) return raw.edits;
  if (Array.isArray(raw.modifications)) return raw.modifications;
  return [];
}

function getKnowledgeAdditionCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  const raw = requireObject(payload, 'KnowledgePatchResponse');
  if (raw.additions !== undefined && raw.additions !== null) return requireArray(raw.additions, 'additions');
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.directories)) return raw.directories;
  return [];
}

function hasForbiddenKnowledgePatchFields(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return raw.outline !== undefined
    || raw.bindings !== undefined
    || raw.knowledge_item_ids !== undefined
    || raw.knowledgeItemIds !== undefined
    || raw.content !== undefined
    || raw.markdown !== undefined
    || raw.table !== undefined
    || raw.tables !== undefined
    || raw.image !== undefined
    || raw.images !== undefined;
}

function createExistingChildTitleKeys(outlineItems) {
  const keys = new Set();
  function visit(nodes, parentId = '') {
    (nodes || []).forEach((item) => {
      const id = String(item?.id || '').trim();
      if (parentId) {
        const key = normalizeTitleKey(item?.title);
        if (key) keys.add(`${parentId}::${key}`);
      }
      if (id && item?.children?.length) visit(item.children, id);
    });
  }
  visit(outlineItems || [], '');
  return keys;
}

function resolveKnowledgeAdditionParent(parentId, context, stats) {
  const parentInfo = context.outlineNodeMap.get(parentId);
  if (!parentInfo) return null;
  if (parentInfo.level >= 1 && parentInfo.level <= 3) return { parentId, parentInfo };
  return null;
}

function normalizeKnowledgeUpdate(update, path, context, stats, issues) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    stats.dropped += 1;
    issues.push(`${path} 必须是对象`);
    return null;
  }

  const id = String(update.id || update.node_id || update.nodeId || '').trim();
  const nodeInfo = id ? context.outlineNodeMap.get(id) : null;
  if (!id || !nodeInfo || nodeInfo.level < 2 || nodeInfo.level > 4) {
    stats.dropped += 1;
    issues.push(`${path}.id=${id || '空'} 不是现有二级、三级或四级目录 ID`);
    return null;
  }

  const hasTitle = update.title !== undefined || update.name !== undefined;
  const hasDescription = update.description !== undefined || update.summary !== undefined || update.resume !== undefined;
  if (!hasTitle && !hasDescription) {
    stats.dropped += 1;
    issues.push(`${path} 至少需要包含 title 或 description`);
    return null;
  }

  const existingTitle = String(nodeInfo.item?.title || '').trim();
  const existingDescription = String(nodeInfo.item?.description || '').trim();
  const normalized = { id };

  if (hasTitle) {
    const title = String(update.title ?? update.name ?? '').trim();
    if (!title) {
      stats.dropped += 1;
      issues.push(`${path}.title 不能为空`);
      return null;
    }
    if (title !== existingTitle) normalized.title = title;
  }
  if (hasDescription) {
    const description = String(update.description ?? update.summary ?? update.resume ?? '').trim();
    if (!description) {
      stats.dropped += 1;
      issues.push(`${path}.description 不能为空`);
      return null;
    }
    if (description !== existingDescription) normalized.description = description;
  }

  if (normalized.title === undefined && normalized.description === undefined) {
    stats.dropped += 1;
    return null;
  }
  stats.retainedUpdates += 1;
  return normalized;
}

function normalizeKnowledgeAdditionNode(value, targetLevel, path, stats, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    stats.dropped += 1;
    issues.push(`${path} 必须是对象`);
    return null;
  }
  if (targetLevel > 4) {
    stats.dropped += 1;
    issues.push(`${path} 新增目录不能超过四级`);
    return null;
  }

  const title = String(value.title || value.name || '').trim();
  if (!title) {
    stats.dropped += 1;
    issues.push(`${path}.title 缺失或为空`);
    return null;
  }
  const description = String(value.description || value.summary || value.resume || title).trim() || title;
  const node = { title, description };
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  if (rawChildren.length) {
    if (targetLevel >= 4) {
      stats.dropped += 1;
      issues.push(`${path}.children 四级目录不能包含下级目录`);
      return null;
    }
    const childSeen = new Set();
    const children = [];
    rawChildren.forEach((child, index) => {
      const childNode = normalizeKnowledgeAdditionNode(child, targetLevel + 1, `${path}.children[${index}]`, stats, issues);
      const key = normalizeTitleKey(childNode?.title);
      if (!childNode || !key || childSeen.has(key)) return;
      childSeen.add(key);
      children.push(childNode);
    });
    if (children.length) node.children = children;
  }
  return node;
}

function normalizeKnowledgeAddition(addition, path, context, stats, seenKeys, issues) {
  if (!addition || typeof addition !== 'object' || Array.isArray(addition)) {
    stats.dropped += 1;
    issues.push(`${path} 必须是对象`);
    return null;
  }

  const rawParentId = String(addition.parent_id || addition.parentId || '').trim();
  if (!rawParentId) {
    stats.dropped += 1;
    issues.push(`${path}.parent_id 缺失`);
    return null;
  }
  const resolvedParent = resolveKnowledgeAdditionParent(rawParentId, context, stats);
  if (!resolvedParent) {
    stats.dropped += 1;
    issues.push(`${path}.parent_id=${rawParentId} 不是现有一级、二级或三级目录 ID`);
    return null;
  }

  const node = normalizeKnowledgeAdditionNode(addition, resolvedParent.parentInfo.level + 1, path, stats, issues);
  if (!node) return null;

  const dedupeKey = `${resolvedParent.parentId}::${normalizeTitleKey(node.title)}`;
  if (seenKeys.has(dedupeKey)) {
    stats.dropped += 1;
    return null;
  }
  seenKeys.add(dedupeKey);
  stats.retainedAdditions += 1;

  return { parent_id: resolvedParent.parentId, ...node };
}

function normalizeKnowledgeAdditionsResponse(payload, context) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawSummary = summarizeRawKnowledgeAdditions(payload);
  if (context.rawAttempts) context.rawAttempts.push(rawSummary);

  const updateCandidates = getKnowledgeUpdateCandidates(payload);
  const candidates = getKnowledgeAdditionCandidates(payload);
  const stats = { retainedUpdates: 0, retainedAdditions: 0, dropped: 0 };
  const issues = [];
  const seenKeys = createExistingChildTitleKeys(context.outline || []);
  const updates = [];
  const additions = [];

  updateCandidates.forEach((update, index) => {
    if (updates.length >= MAX_KNOWLEDGE_UPDATES) {
      stats.dropped += 1;
      return;
    }
    const normalized = normalizeKnowledgeUpdate(update, `updates[${index}]`, context, stats, issues);
    if (normalized) updates.push(normalized);
  });

  candidates.forEach((addition, index) => {
    if (additions.length >= MAX_KNOWLEDGE_ADDITIONS) {
      stats.dropped += 1;
      return;
    }
    const normalized = normalizeKnowledgeAddition(addition, `additions[${index}]`, context, stats, seenKeys, issues);
    if (normalized) additions.push(normalized);
  });
  if (context.normalizationStats) context.normalizationStats.push(stats);

  const shouldRepair = hasForbiddenKnowledgePatchFields(payload)
    || (!updates.length && !additions.length && (updateCandidates.length > 0 || candidates.length > 0) && issues.length > 0);
  if (shouldRepair) {
    const reason = issues.length ? issues.join('；') : '模型返回了禁止字段或完整目录，但没有可直接应用的目录增强 patch';
    if (context.debugLog) context.debugLog(`进入修复：${reason}`);
    throw new Error(`知识库目录增强 patch 格式无效：${reason}`);
  }

  return { updates, additions };
}

function validateKnowledgeAdditionsResponse(payload) {
  requireArray(payload.updates, 'updates');
  requireArray(payload.additions, 'additions');
}

function outlineDepth(items) {
  return items?.length ? 1 + Math.max(...items.map((item) => outlineDepth(item.children || []))) : 0;
}

function formatMissingOutlineLabels(items, limit = 8) {
  const labels = (items || []).map((item, index) => formatOutlineItemLabel(item, `第 ${index + 1} 个目录`));
  const visible = labels.slice(0, limit).join('、');
  return labels.length > limit ? `${visible} 等 ${labels.length} 个目录` : visible;
}

function validateCompleteOutline(payload) {
  const outline = payload.outline || [];
  if (!outline.length) throw new Error('目录不能为空');
  if (outlineDepth(outline) < 3) throw new Error('完整目录至少需要三级结构');
}

function validateTopLevelOutline(payload) {
  if (!(payload.outline || []).length) throw new Error('一级目录不能为空');
}

function validateChildrenOutline(payload) {
  const children = payload.children || [];
  if (!children.length) throw new Error('子目录不能为空');
}

function validateRequirementGroups(payload) {
  const groups = payload.groups || [];
  if (!groups.length) throw new Error('技术评分大类不能为空');
  const requirementIds = [];
  const titles = [];
  groups.forEach((group, index) => {
    const requirementId = String(group.requirement_id || '').trim();
    const title = String(group.title || '').trim();
    const description = String(group.description || '').trim();
    if (!requirementId) throw new Error(`第 ${index + 1} 个技术评分大类缺少 requirement_id`);
    if (!title) throw new Error(`第 ${index + 1} 个技术评分大类缺少标题`);
    if (!description) throw new Error(`第 ${index + 1} 个技术评分大类缺少描述`);
    requirementIds.push(requirementId);
    titles.push(title);
  });
  if (new Set(requirementIds).size !== requirementIds.length) throw new Error('技术评分大类 requirement_id 不能重复');
  if (new Set(titles).size !== titles.length) throw new Error('技术评分大类标题不能重复');
}

function buildTopLevelOutlineFromGroups(groups) {
  return groups.map((group, index) => {
    const title = String(group.title || '').trim();
    return {
      id: String(index + 1),
      title,
      description: String(group.description || title).trim(),
      source_requirement_id: String(group.requirement_id || `R${index + 1}`).trim(),
      source_requirement_title: title,
    };
  });
}

function validateAlignedTopLevelMapping(outlineItems, groups) {
  if (outlineItems.length !== groups.length) throw new Error('一级目录数量必须与技术评分大类数量一致');
  outlineItems.forEach((item, index) => {
    const expectedTitle = String(groups[index].title || '').trim();
    const actualTitle = String(item.title || '').trim();
    if (actualTitle !== expectedTitle) throw new Error(`第 ${index + 1} 个一级目录标题必须严格等于技术评分大类标题：${expectedTitle}`);
    const expectedRequirementId = String(groups[index].requirement_id || '').trim();
    const actualRequirementId = String(item.source_requirement_id || '').trim();
    if (actualRequirementId !== expectedRequirementId) throw new Error(`第 ${index + 1} 个一级目录映射的技术评分大类ID不正确：${expectedRequirementId}`);
  });
}

function validateOriginalTopLevelPrefix(originalOutlinePayload, finalOutlinePayload) {
  const originalRoots = originalOutlinePayload?.outline || [];
  const finalRoots = finalOutlinePayload?.outline || [];
  if (!originalRoots.length) return;
  if (finalRoots.length < originalRoots.length) {
    throw new Error('最终目录不能少于原方案一级目录数量');
  }
  originalRoots.forEach((item, index) => {
    const expectedTitle = String(item?.title || '').trim();
    const actualTitle = String(finalRoots[index]?.title || '').trim();
    if (actualTitle !== expectedTitle) {
      throw new Error(`最终目录必须保留原方案第 ${index + 1} 个一级目录：${expectedTitle}`);
    }
  });
}

function validateFinalOutline(context) {
  validateCompleteOutline(context.outline);
  if (context.workflowKind !== 'existing-plan-expansion') {
    validateAlignedTopLevelMapping(context.outline.outline || [], context.groups || []);
    return;
  }

  if (outlineDepth(context.outline?.outline || []) > 4) {
    throw new Error('最终目录层级不能超过四级');
  }

  if (context.outlineExpansionMode !== 'original-only') {
    validateOriginalTopLevelPrefix(context.originalOutline, context.outline);
  }
}

function buildExpansionTopLevelOutlineFromPlan(originalOutlinePayload, plan) {
  const outline = cloneOutlineItems(originalOutlinePayload?.outline || []);
  const originalRootIds = new Set(outline.map((item) => String(item?.id || '').trim()).filter(Boolean));
  const rootById = new Map(outline.map((item) => [String(item?.id || '').trim(), item]).filter(([id]) => Boolean(id)));
  const rootTitleKeys = new Set(outline.map((item) => normalizeTitleKey(item?.title)).filter(Boolean));
  const groupByTitleKey = new Map();
  let addedCount = 0;

  for (const group of plan?.groups || []) {
    const existingRootId = String(group?.existing_root_id || '').trim();
    const existingRoot = existingRootId && originalRootIds.has(existingRootId) ? rootById.get(existingRootId) : null;
    if (existingRoot) {
      const key = normalizeTitleKey(existingRoot.title);
      if (key && !groupByTitleKey.has(key)) {
        groupByTitleKey.set(key, { ...group, title: existingRoot.title, description: group.description || existingRoot.description });
      } else if (key) {
        groupByTitleKey.set(key, mergeRequirementGroups(groupByTitleKey.get(key), group, existingRoot.title));
      }
      continue;
    }

    const title = String(group?.title || '').trim();
    const key = normalizeTitleKey(title);
    if (!key || rootTitleKeys.has(key)) {
      continue;
    }

    outline.push({
      id: '',
      title,
      description: String(group.description || title).trim() || title,
      source_requirement_id: String(group.requirement_id || '').trim() || undefined,
      source_requirement_title: title,
    });
    rootTitleKeys.add(key);
    groupByTitleKey.set(key, group);
    addedCount += 1;
  }

  const normalized = normalizeOutlineResponse({ outline: renumber(outline) }, new Set());
  validateOriginalTopLevelPrefix(originalOutlinePayload, normalized);
  const rootGroupMap = new Map();
  (normalized.outline || []).forEach((item) => {
    const key = normalizeTitleKey(item.title);
    rootGroupMap.set(item.id, groupByTitleKey.get(key) || createSyntheticRequirementGroupFromRoot(item));
  });

  return { outline: normalized, rootGroupMap, addedCount };
}

function buildExpansionTopLevelFallback(originalOutlinePayload) {
  const normalized = normalizeOutlineResponse({
    outline: renumber(cloneOutlineItems(originalOutlinePayload?.outline || [])),
  }, new Set());
  const rootGroupMap = new Map();
  (normalized.outline || []).forEach((item) => {
    rootGroupMap.set(item.id, createSyntheticRequirementGroupFromRoot(item));
  });
  return { outline: normalized, rootGroupMap, addedCount: 0 };
}

function createExpansionPatchNode(addition, targetLevel) {
  if (!addition || targetLevel > 3) {
    return null;
  }

  const title = String(addition.title || '').trim();
  if (!title) {
    return null;
  }

  const item = {
    id: '',
    title,
    description: String(addition.description || title).trim() || title,
  };
  if (targetLevel < 3 && Array.isArray(addition.children) && addition.children.length) {
    const seen = new Set();
    const children = [];
    for (const child of addition.children) {
      const key = normalizeTitleKey(child?.title);
      if (!key || seen.has(key)) continue;
      const childItem = createExpansionPatchNode(child, targetLevel + 1);
      if (!childItem) continue;
      seen.add(key);
      children.push(childItem);
    }
    if (children.length) item.children = children;
  }
  return item;
}

function applyExpansionChildPatch(outlineItems, rootId, patch) {
  const nodeMap = createOutlineNodeMap(outlineItems);
  const rootInfo = nodeMap.get(rootId);
  if (!rootInfo || rootInfo.level !== 1) {
    return 0;
  }

  let addedCount = 0;
  for (const addition of patch?.additions || []) {
    const parentId = String(addition?.parent_id || '').trim();
    const parentInfo = nodeMap.get(parentId);
    if (!parentInfo || parentInfo.level < 1 || parentInfo.level >= 3) {
      continue;
    }
    if (parentId !== rootId && !String(parentId).startsWith(`${rootId}.`)) {
      continue;
    }

    parentInfo.item.children = parentInfo.item.children || [];
    const key = normalizeTitleKey(addition.title);
    if (!key || createSiblingTitleKeys(parentInfo.item.children).has(key)) {
      continue;
    }
    const item = createExpansionPatchNode(addition, parentInfo.level + 1);
    if (!item) {
      continue;
    }
    parentInfo.item.children.push(item);
    addedCount += countOutlineItems([item]);
  }

  return addedCount;
}

function mergeSupplementalChildren(targetItem, sourceChildren) {
  if (!Array.isArray(sourceChildren) || !sourceChildren.length) {
    return 0;
  }

  targetItem.children = targetItem.children?.length ? targetItem.children : [];
  const titleMap = new Map(targetItem.children
    .map((child) => [normalizeTitleKey(child?.title), child])
    .filter(([key]) => Boolean(key)));
  let addedCount = 0;
  for (const sourceChild of sourceChildren) {
    const key = normalizeTitleKey(sourceChild?.title);
    if (!key) continue;
    const existingChild = titleMap.get(key);
    if (existingChild) {
      if (!String(existingChild.description || '').trim() && sourceChild.description) {
        existingChild.description = sourceChild.description;
      }
      addedCount += mergeSupplementalChildren(existingChild, sourceChild.children || []);
      continue;
    }

    const [clonedChild] = cloneOutlineItems([sourceChild]);
    targetItem.children.push(clonedChild);
    titleMap.set(key, clonedChild);
    addedCount += countOutlineItems([clonedChild]);
  }

  if (!targetItem.children.length) {
    delete targetItem.children;
  }
  return addedCount;
}

function mergeOriginalOutlineWithAlignedAdditions(originalOutlinePayload, alignedOutlinePayload) {
  const outline = cloneOutlineItems(originalOutlinePayload?.outline || []);
  const rootTitleMap = new Map(outline
    .map((item) => [normalizeTitleKey(item?.title), item])
    .filter(([key]) => Boolean(key)));
  let addedCount = 0;
  for (const sourceRoot of alignedOutlinePayload?.outline || []) {
    const key = normalizeTitleKey(sourceRoot?.title);
    if (!key) continue;
    const existingRoot = rootTitleMap.get(key);
    if (existingRoot) {
      if (!String(existingRoot.description || '').trim() && sourceRoot.description) {
        existingRoot.description = sourceRoot.description;
      }
      addedCount += mergeSupplementalChildren(existingRoot, sourceRoot.children || []);
      continue;
    }

    const [clonedRoot] = cloneOutlineItems([sourceRoot]);
    outline.push(clonedRoot);
    rootTitleMap.set(key, clonedRoot);
    addedCount += countOutlineItems([clonedRoot]);
  }

  const merged = normalizeOutlineResponse({ outline: renumber(outline) }, new Set());
  validateOriginalTopLevelPrefix(originalOutlinePayload, merged);
  return { outline: merged, addedCount };
}

function renumber(items, parent = '') {
  return (items || []).map((item, index) => {
    const id = parent ? `${parent}.${index + 1}` : `${index + 1}`;
    const next = { ...item, id };
    if (item.children?.length) next.children = renumber(item.children, id);
    else delete next.children;
    return next;
  });
}

function cloneOutlineItems(items) {
  return (items || []).map((item) => ({
    ...item,
    ...(item.knowledge_item_ids?.length ? { knowledge_item_ids: [...item.knowledge_item_ids] } : {}),
    ...(item.children?.length ? { children: cloneOutlineItems(item.children) } : {}),
  }));
}

function createOutlineItemFromKnowledgeAddition(addition) {
  const children = Array.isArray(addition.children)
    ? addition.children.map((child) => createOutlineItemFromKnowledgeAddition(child)).filter(Boolean)
    : [];
  return {
    id: '',
    title: addition.title,
    description: addition.description,
    ...(children.length ? { children } : {}),
  };
}

function flattenKnowledgeOutlineRows(items, level = 1, parentId = '', rows = []) {
  (items || []).forEach((item, index) => {
    const id = String(item?.id || '').trim();
    rows.push({
      id,
      level,
      parentId,
      sortIndex: index,
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
    });
    if (item?.children?.length) {
      flattenKnowledgeOutlineRows(item.children, level + 1, id, rows);
    }
  });
  return rows;
}

function validateKnowledgePatchApplied(beforeItems, afterItems) {
  if ((beforeItems || []).length !== (afterItems || []).length) {
    throw new Error('知识库补目录不允许改变一级目录数量');
  }
  if (outlineDepth(afterItems || []) > 4) {
    throw new Error('知识库补目录后目录层级不能超过四级');
  }

  const beforeRows = flattenKnowledgeOutlineRows(beforeItems || []);
  const afterRows = flattenKnowledgeOutlineRows(afterItems || []);
  const beforeById = new Map(beforeRows.filter((row) => row.id).map((row) => [row.id, row]));
  const afterById = new Map(afterRows.filter((row) => row.id).map((row) => [row.id, row]));

  (beforeItems || []).forEach((beforeItem, index) => {
    const afterItem = afterItems[index];
    if (String(beforeItem.id || '').trim() !== String(afterItem?.id || '').trim()) {
      throw new Error('知识库补目录不允许修改一级目录 ID 或顺序');
    }
    if (String(beforeItem.title || '').trim() !== String(afterItem?.title || '').trim()) {
      throw new Error('知识库补目录不允许修改一级目录标题');
    }
    if (String(beforeItem.description || '').trim() !== String(afterItem?.description || '').trim()) {
      throw new Error('知识库补目录不允许修改一级目录说明');
    }
  });

  for (const beforeRow of beforeRows) {
    const afterRow = beforeRow.id ? afterById.get(beforeRow.id) : null;
    if (!afterRow) {
      throw new Error(`知识库补目录不允许删除已有目录：${beforeRow.id || beforeRow.title || '未命名目录'}`);
    }
    if (beforeRow.level !== afterRow.level || beforeRow.parentId !== afterRow.parentId) {
      throw new Error(`知识库补目录不允许改变已有目录层级或父级：${beforeRow.id}`);
    }
    if (beforeRow.sortIndex !== afterRow.sortIndex) {
      throw new Error(`知识库补目录不允许调整已有目录顺序：${beforeRow.id}`);
    }
  }

  for (const afterRow of afterRows) {
    if (afterRow.level > 4) {
      throw new Error(`知识库补目录不允许生成超过四级目录：${afterRow.id || afterRow.title || '未命名目录'}`);
    }
    if (!beforeById.has(afterRow.id) && (afterRow.level < 2 || afterRow.level > 4)) {
      throw new Error(`知识库补目录只能新增二级、三级、四级目录：${afterRow.id || afterRow.title || '未命名目录'}`);
    }
  }
}

function applyKnowledgeAdditions(outlinePayload, patch) {
  const beforeOutline = outlinePayload.outline || [];
  const outline = cloneOutlineItems(beforeOutline);
  const nodeMap = createOutlineNodeMap(outline);
  let updateCount = 0;
  let additionCount = 0;

  (patch.updates || []).forEach((update) => {
    const target = nodeMap.get(update.id);
    if (!target || target.level < 2 || target.level > 4) {
      return;
    }
    let changed = false;
    if (update.title !== undefined && String(target.item.title || '').trim() !== String(update.title || '').trim()) {
      target.item.title = String(update.title || '').trim();
      changed = true;
    }
    if (update.description !== undefined && String(target.item.description || '').trim() !== String(update.description || '').trim()) {
      target.item.description = String(update.description || '').trim();
      changed = true;
    }
    if (changed) updateCount += 1;
  });

  (patch.additions || []).forEach((addition) => {
    const parent = nodeMap.get(addition.parent_id);
    if (!parent || parent.level < 1 || parent.level > 3) {
      return;
    }
    const key = normalizeTitleKey(addition.title);
    if (!key || createSiblingTitleKeys(parent.item.children || []).has(key)) {
      return;
    }
    const nextItem = createOutlineItemFromKnowledgeAddition(addition);
    parent.item.children = [...(parent.item.children || []), nextItem];
    additionCount += countOutlineItems([nextItem]);
  });

  const normalized = normalizeOutlineResponse({ outline: renumber(outline) }, new Set());
  validateKnowledgePatchApplied(beforeOutline, normalized.outline);
  return { outline: normalized, updateCount, additionCount };
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

async function extractOriginalOutline(aiService, agentService, payload, originalPlanMarkdown, log) {
  log('正在从原方案中提取旧目录。', 8);
  let outline;
  try {
    outline = await collectJson(aiService, {
      messages: buildExpandOutlineMessages(originalPlanMarkdown),
      temperature: 0.7,
      normalizer: (value) => normalizeOutlineResponse(value, new Set()),
      validator: validateTopLevelOutline,
      progressCallback: (message) => log(message, 12),
      progressLabel: '旧方案目录提取',
      failureMessage: '模型返回的旧方案目录数据格式无效',
    });
  } catch (error) {
    assertRecoverableOutlineError(error, RECOVERABLE_OLD_OUTLINE_ERRORS);
    const finalReview = createSyntheticFinalReview('旧方案目录提取失败', error);
    const recovered = await runOutlineAgentRecovery(agentService, {
      recoveryKind: 'original-outline-extraction',
      title: '原方案目录自主提取',
      payload,
      originalPlanMarkdown,
      outline: { outline: [] },
      groups: [],
      finalReview,
      workflowKind: 'existing-plan-expansion',
      outlineExpansionMode: payload?.outlineExpansionMode || 'ai-complement',
      recoveryReason: finalReview.suggestions.join('；'),
      startLogMessage: `旧方案目录提取失败，已切换到 Agent 从原方案提取目录：${getErrorMessage(error)}`,
      startProgress: 14,
      validationLogMessage: 'Agent 已完成旧目录提取，正在校验目录结构。',
      validationProgress: 16,
      successLogMessage: 'Agent 旧目录提取结果通过程序校验。',
      successProgress: 18,
    }, log);
    return recovered.outline;
  }
  log('原方案旧目录提取完成，正在检查目录缺漏。', 14);

  let additions = { additions: [] };
  try {
    additions = await collectJson(aiService, {
      messages: buildOriginalOutlineAdditionsMessages(originalPlanMarkdown, outline),
      temperature: 0.3,
      normalizer: normalizeOriginalOutlineAdditionsResponse,
      progressCallback: (message) => log(message, 16),
      progressLabel: '旧方案目录补漏',
      failureMessage: '模型返回的旧方案目录补漏数据格式无效',
    });
  } catch (error) {
    log(`旧方案目录补漏失败，已使用首次提取目录：${error.message || '未知错误'}`, 17);
  }

  const mergeResult = additions.additions.length
    ? applyOriginalOutlineAdditions(outline, additions.additions)
    : { outline, appliedCount: 0 };
  const finalizedOutline = finalizeOriginalOutline(mergeResult.outline);
  log(mergeResult.appliedCount
    ? `原方案旧目录补漏完成，新增 ${mergeResult.appliedCount} 个目录项。`
    : '未发现旧目录缺漏，已整理目录编号。', 18);
  return finalizedOutline;
}

async function runParallelAndThrowAfterSettled(tasks) {
  const results = await Promise.allSettled(tasks);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
  return results.map((result) => result.value);
}

async function reviewFinalOutline(aiService, context, log) {
  log('开始最终目录审核。', 99);
  return collectJson(aiService, {
    messages: buildFinalOutlineReviewMessages(context),
    temperature: 0.3,
    normalizer: normalizeReviewResponse,
    progressCallback: (message) => log(message, 99),
    progressLabel: '最终目录审核',
    failureMessage: '模型返回的最终目录审核结果格式无效',
  });
}

async function runFinalOutlineGate({ aiService, agentService, payload, outline, groups, originalOutline, workflowKind, outlineExpansionMode, log }) {
  const context = {
    payload,
    outline,
    groups: groups || [],
    originalOutline,
    workflowKind,
    outlineExpansionMode,
  };
  if (shouldForceOutlineAgentRepair(payload)) {
    const finalReview = createSyntheticFinalReview('开发者模式强制触发 Agent 目录修复', new Error('本次目录生成启用了强制 Agent 修复调试开关'));
    const repaired = await repairFinalOutlineWithAgent(agentService, {
      ...context,
      finalReview,
      recoveryReason: finalReview.suggestions.join('；'),
      startLogMessage: '开发者模式已强制切换到 Agent 修复目录。',
    }, log);
    return { outline: repaired.outline, groups: repaired.groups || context.groups };
  }

  let finalReview;
  try {
    finalReview = await reviewFinalOutline(aiService, context, log);
  } catch (error) {
    assertRecoverableOutlineError(error, RECOVERABLE_FINAL_REVIEW_ERRORS);
    finalReview = createSyntheticFinalReview('最终目录审核结果格式无效，跳过审核 JSON 后由 Agent 自主审查并修复', error);
    const repaired = await repairFinalOutlineWithAgent(agentService, {
      ...context,
      finalReview,
      recoveryReason: finalReview.suggestions.join('；'),
      startLogMessage: `最终目录审核结果格式无效，已切换到 Agent 自主审查并修复目录：${getErrorMessage(error)}`,
    }, log);
    return { outline: repaired.outline, groups: repaired.groups || context.groups };
  }
  if (finalReview.passed) {
    try {
      validateFinalOutline(context);
    } catch (error) {
      const validationReview = createSyntheticFinalReview('最终目录程序校验未通过', error);
      const repaired = await repairFinalOutlineWithAgent(agentService, {
        ...context,
        finalReview: validationReview,
        recoveryReason: validationReview.suggestions.join('；'),
        startLogMessage: `最终目录审核通过但程序校验未通过，已切换到 Agent 修复目录：${getErrorMessage(error)}`,
      }, log);
      return { outline: repaired.outline, groups: repaired.groups || context.groups };
    }
    log('最终目录审核通过，准备保存目录。', 99);
    return { outline, groups: context.groups };
  }

  const repaired = await repairFinalOutlineWithAgent(agentService, { ...context, finalReview, recoveryReason: finalReview.suggestions.join('；') }, log);
  return { outline: repaired.outline, groups: repaired.groups || context.groups };
}

async function extractRequirementGroups(aiService, payload, suggestions, log) {
  const response = await collectJson(aiService, {
    messages: extractRequirementGroupsMessages(payload, suggestions),
    temperature: 0.3,
    normalizer: normalizeRequirementGroupsResponse,
    validator: validateRequirementGroups,
    progressCallback: (message) => log(message, 10),
    progressLabel: '技术评分大类',
    failureMessage: '模型返回的技术评分大类格式无效',
  });
  return response.groups || [];
}

async function generateAlignedChildrenForGroup(aiService, payload, parentItem, group, suggestions, log, progress) {
  const response = await collectJson(aiService, {
    messages: generateAlignedChildrenMessages({ ...payload, parentItem, group, suggestions }),
    temperature: 0.7,
    normalizer: (value) => normalizeChildrenResponse(value, new Set()),
    validator: validateChildrenOutline,
    repairMessagesBuilder: (context) => generateChildrenStructureRepairMessages(context, parentItem, group),
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
  return response;
}

async function generateExpansionTopLevelPlan(aiService, payload, log) {
  const response = await collectJson(aiService, {
    messages: buildExpansionTopLevelComplementMessages(payload),
    temperature: 0.3,
    normalizer: normalizeExpansionTopLevelPlanResponse,
    validator: validateRequirementGroups,
    progressCallback: (message) => log(message, 22),
    progressLabel: '原方案一级目录补充计划',
    failureMessage: '模型返回的原方案一级目录补充计划格式无效',
  });
  return response;
}

async function generateExpansionChildrenForRoot(aiService, sharedMessages, parentItem, group, log, progress) {
  if (parentItem.children?.length) {
    const patch = await collectJson(aiService, {
      messages: buildExpansionChildPatchMessages(sharedMessages, parentItem, group),
      temperature: 0.3,
      normalizer: normalizeExpansionChildPatchResponse,
      validator: validateExpansionChildPatchResponse,
      repairMessagesBuilder: (context) => buildExpansionChildPatchRepairMessages(context, parentItem, group),
      progressCallback: (message) => log(message, progress),
      progressLabel: `章节 ${parentItem.title || '未命名章节'} 下级目录补充`,
      failureMessage: '模型返回的下级目录补充数据格式无效',
    });
    return { mode: 'patch', rootId: parentItem.id, patch };
  }

  const response = await collectJson(aiService, {
    messages: buildExpansionMissingChildrenMessages(sharedMessages, parentItem, group),
    temperature: 0.7,
    normalizer: (value) => normalizeChildrenResponse(value, new Set()),
    validator: validateChildrenOutline,
    repairMessagesBuilder: (context) => generateChildrenStructureRepairMessages(context, parentItem, group),
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
  return { mode: 'children', rootId: parentItem.id, children: response.children || [] };
}

async function expansionComplementWorkflow(aiService, payload, originalOutline, log) {
  log('开始基于原方案目录补充一级目录。', 20);
  let topLevelResult;
  try {
    const plan = await generateExpansionTopLevelPlan(aiService, payload, log);
    topLevelResult = buildExpansionTopLevelOutlineFromPlan(originalOutline, plan);
    log(topLevelResult.addedCount
      ? `一级目录补充完成，追加 ${topLevelResult.addedCount} 个评分项缺口目录。`
      : '一级目录补充完成，未发现需要追加的一级目录。', 28);
  } catch (error) {
    topLevelResult = buildExpansionTopLevelFallback(originalOutline);
    log(`一级目录补充计划失败，已保留原方案目录继续下级补充和最终评审修复：${error.message || String(error)}`, 28);
  }

  const outline = topLevelResult.outline;
  const targets = outline.outline || [];
  if (!targets.length) {
    throw new Error('原方案目录为空，无法补充下级目录');
  }

  const childSharedMessages = buildExpansionChildSharedMessages(payload);
  const progressRange = { start: 32, end: 82 };
  let completedChildren = 0;
  const runTarget = async (item, index) => {
    const group = topLevelResult.rootGroupMap.get(item.id) || createSyntheticRequirementGroupFromRoot(item);
    let result;
    let failedMessage = '';
    try {
      result = await generateExpansionChildrenForRoot(aiService, childSharedMessages, item, group, log, progressRange.start);
    } catch (error) {
      failedMessage = error.message || String(error);
      result = { mode: 'skipped', rootId: item.id };
    }
    completedChildren += 1;
    const progress = progressRange.start + Math.round((completedChildren / Math.max(targets.length, 1)) * (progressRange.end - progressRange.start));
    log(failedMessage
      ? `第 ${index + 1}/${targets.length} 个一级目录的下级补充失败，已保留当前目录并交由最终评审修复：${item.title || '未命名章节'}；${failedMessage}`
      : `已完成第 ${index + 1}/${targets.length} 个一级目录的下级补充：${item.title || '未命名章节'}。`, progress);
    return { index, ...result };
  };

  log(`正在先处理第 1/${targets.length} 个一级目录以优化提示词缓存。`, progressRange.start);
  const firstResult = await runTarget(targets[0], 0);
  if (targets.length > 1) {
    log('提示词缓存预热完成，等待 5 秒后并发处理剩余一级目录。', progressRange.start);
    await waitForPromptCacheWarmup();
  }
  const remainingResults = targets.length > 1
    ? await runParallelAndThrowAfterSettled(targets.slice(1).map((item, offset) => runTarget(item, offset + 1)))
    : [];

  const outlineItems = cloneOutlineItems(outline.outline || []);
  let addedCount = 0;
  for (const result of [firstResult, ...remainingResults].sort((left, right) => left.index - right.index)) {
    const root = outlineItems.find((item) => item.id === result.rootId);
    if (!root) continue;
    if (result.mode === 'skipped') {
      continue;
    }
    if (result.mode === 'children') {
      root.children = result.children || [];
      addedCount += countOutlineItems(root.children || []);
      continue;
    }
    addedCount += applyExpansionChildPatch(outlineItems, result.rootId, result.patch);
  }

  const normalized = normalizeOutlineResponse({ outline: renumber(outlineItems) }, new Set());
  log(addedCount
    ? `原方案目录下级补充完成，新增 ${addedCount} 个目录项。`
    : '原方案目录下级补充完成，未发现需要追加的下级目录。', 96);
  return normalized;
}

async function buildAligned(aiService, payload, groups, suggestions, log, progressRange = { start: 30, end: 75 }) {
  const top = buildTopLevelOutlineFromGroups(groups);
  validateAlignedTopLevelMapping(top, groups);
  const childTotal = top.length;
  let completedChildren = 0;
  const runChild = async (item, index) => {
    const childrenResponse = await generateAlignedChildrenForGroup(aiService, payload, item, groups[index], suggestions, log, progressRange.start);
    const children = childrenResponse.children || [];
    completedChildren += 1;
    const progress = progressRange.start + Math.round((completedChildren / Math.max(childTotal, 1)) * (progressRange.end - progressRange.start));
    log(`已完成第 ${index + 1}/${childTotal} 个评分大类的二三级目录：${item.title || '未命名章节'}。`, progress);
    return { index, item, children };
  };
  log(`正在先生成第 1/${childTotal} 个评分大类的二三级目录以优化提示词缓存。`, progressRange.start);
  const firstResult = await runChild(top[0], 0);
  if (childTotal > 1) {
    log('提示词缓存预热完成，等待 5 秒后并发生成剩余评分大类目录。', progressRange.start);
    await waitForPromptCacheWarmup();
  }
  const remainingResults = childTotal > 1
    ? await runParallelAndThrowAfterSettled(top.slice(1).map((item, offset) => runChild(item, offset + 1)))
    : [];
  const childResults = [firstResult, ...remainingResults];
  const assembled = childResults
    .sort((left, right) => left.index - right.index)
    .map(({ item, children }) => ({ ...item, ...(children.length ? { children } : {}) }));
  log('评分项对齐目录生成完成，正在整理目录编号。', progressRange.end);
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) }, new Set());
  validateCompleteOutline(outline);
  validateAlignedTopLevelMapping(outline.outline || [], groups);
  return outline;
}

async function alignedWorkflow(aiService, agentService, payload, log) {
  log('开始提取技术评分大类。', 10);
  let groups;
  try {
    groups = await extractRequirementGroups(aiService, payload, undefined, log);
  } catch (error) {
    assertRecoverableOutlineError(error, RECOVERABLE_REQUIREMENT_GROUP_ERRORS);
    const finalReview = createSyntheticFinalReview('技术评分大类提取失败', error);
    const recovered = await runOutlineAgentRecovery(agentService, {
      recoveryKind: 'aligned-full-generation',
      title: '技术方案目录自主生成',
      payload,
      outline: { outline: [] },
      groups: [],
      finalReview,
      workflowKind: 'technical-plan',
      outlineExpansionMode: payload?.outlineExpansionMode || 'ai-complement',
      recoveryReason: finalReview.suggestions.join('；'),
      startLogMessage: `技术评分大类提取失败，已切换到 Agent 直接生成评分大类和目录：${getErrorMessage(error)}`,
      startProgress: 24,
      successLogMessage: 'Agent 已完成评分大类和目录生成，准备进入知识库补目录。',
      successProgress: 82,
    }, log);
    return recovered;
  }
  log('技术评分大类提取完成，正在构建一级目录。', 24);
  let outline;
  try {
    outline = await buildAligned(aiService, payload, groups, undefined, log, { start: 30, end: 75 });
  } catch (error) {
    assertRecoverableOutlineError(error, RECOVERABLE_ALIGNED_OUTLINE_ERRORS);
    const finalReview = createSyntheticFinalReview('评分项对齐目录生成失败', error);
    const topLevelOutline = normalizeOutlineResponse({ outline: buildTopLevelOutlineFromGroups(groups) }, new Set());
    const recovered = await runOutlineAgentRecovery(agentService, {
      recoveryKind: 'aligned-outline-generation',
      title: '评分项对齐目录自主生成',
      payload,
      outline: topLevelOutline,
      groups,
      finalReview,
      workflowKind: 'technical-plan',
      outlineExpansionMode: payload?.outlineExpansionMode || 'ai-complement',
      recoveryReason: finalReview.suggestions.join('；'),
      startLogMessage: `评分项对齐目录生成失败，已切换到 Agent 补齐完整目录：${getErrorMessage(error)}`,
      startProgress: 82,
      successLogMessage: 'Agent 已完成评分项对齐目录生成，准备进入知识库补目录。',
      successProgress: 82,
    }, log);
    return recovered;
  }
  log('目录主结果生成完成，准备进入知识库补目录。', 82);
  return { outline, groups };
}

function mergeKnowledgePatches(patches) {
  const updateMap = new Map();
  const additions = [];
  for (const patch of patches || []) {
    (patch.updates || []).forEach((update) => {
      const id = String(update?.id || '').trim();
      if (!id) return;
      const current = updateMap.get(id) || { id };
      updateMap.set(id, {
        ...current,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
      });
    });
    (patch.additions || []).forEach((addition) => additions.push(addition));
  }
  return { updates: Array.from(updateMap.values()), additions };
}

function summarizeKnowledgePatchStats(statsItems, patch) {
  const totals = (statsItems || []).reduce((acc, item) => ({
    retainedUpdates: acc.retainedUpdates + Number(item?.retainedUpdates || 0),
    retainedAdditions: acc.retainedAdditions + Number(item?.retainedAdditions || 0),
    dropped: acc.dropped + Number(item?.dropped || 0),
  }), { retainedUpdates: 0, retainedAdditions: 0, dropped: 0 });
  return {
    retainedUpdates: totals.retainedUpdates || (patch?.updates || []).length,
    retainedAdditions: totals.retainedAdditions || (patch?.additions || []).length,
    dropped: totals.dropped,
  };
}

async function enhanceOutlineWithKnowledgeAdditions(aiService, payload, outline, knowledgeItems, log) {
  if (!knowledgeItems.length) return outline;

  const outlineNodeMap = createOutlineNodeMap(outline.outline || []);
  const hasPatchTarget = Array.from(outlineNodeMap.values()).some((item) => item.level >= 1 && item.level <= 4);
  if (!hasPatchTarget) {
    log('当前目录没有可增强的目录节点，跳过参考知识库。', 98);
    return outline;
  }

  const sharedMessages = buildKnowledgePatchSharedMessages({ ...payload, outline });
  const knowledgeSegments = buildKnowledgeSegments(knowledgeItems, aiService, sharedMessages);
  if (!knowledgeSegments.length) return outline;

  const rawAttempts = [];
  const normalizationStats = [];
  const isDeveloperMode = Boolean(aiService.isDeveloperMode?.());
  const devLog = (message) => {
    if (isDeveloperMode) log(`[开发者] ${message}`, 98);
  };
  log(`开始根据 ${knowledgeItems.length} 条知识库条目增强目录。`, 98);
  if (knowledgeSegments.length > 1) {
    log(`知识库内容较多，已拆分为 ${knowledgeSegments.length} 段；将先处理第 1 段以优化提示词缓存，再并发处理剩余分段。`, 98);
  }
  devLog(`知识库补目录：参考知识条目 ${knowledgeItems.length} 条，按完整条目拆分为 ${knowledgeSegments.length} 段，每段知识库预算约 ${knowledgeSegments[0]?.segmentLimit || 0} 字符。`);

  try {
    let completedSegments = 0;
    const runKnowledgeSegment = async (segment) => {
      const patch = await collectJson(aiService, {
        messages: generateKnowledgePatchMessages(sharedMessages, segment),
        temperature: 0.3,
        normalizer: (value) => normalizeKnowledgeAdditionsResponse(value, {
          outline: outline.outline || [],
          outlineNodeMap,
          rawAttempts,
          normalizationStats,
          debugLog: devLog,
        }),
        validator: validateKnowledgeAdditionsResponse,
        repairMessagesBuilder: (context) => generateKnowledgeAdditionRepairMessages(context, outline),
        progressCallback: (message) => log(message, 98),
        progressLabel: `知识库补目录 ${segment.index}/${segment.total}`,
        failureMessage: '模型返回的知识库目录增强数据格式无效',
      });
      completedSegments += 1;
      if (knowledgeSegments.length > 1) {
        log(`已完成知识库补目录分段 ${completedSegments}/${knowledgeSegments.length}。`, 98);
      }
      return { index: segment.index, patch };
    };
    const firstResult = await runKnowledgeSegment(knowledgeSegments[0]);
    if (knowledgeSegments.length > 1) {
      log('知识库补目录预热完成，等待 5 秒后并发处理剩余分段。', 98);
      await waitForPromptCacheWarmup();
    }
    const remainingResults = knowledgeSegments.length > 1
      ? await runParallelAndThrowAfterSettled(knowledgeSegments.slice(1).map((segment) => runKnowledgeSegment(segment)))
      : [];
    const segmentResults = [firstResult, ...remainingResults];

    const mergedPatch = mergeKnowledgePatches(segmentResults
      .sort((left, right) => left.index - right.index)
      .map((result) => result.patch));

    if (rawAttempts.length) {
      devLog(`模型原始返回尝试 ${rawAttempts.length} 次：${rawAttempts.map((item, index) => `#${index + 1} ${formatAdditionSummary(item)}`).join('；')}`);
    }
    const totalStats = summarizeKnowledgePatchStats(normalizationStats, mergedPatch);
    devLog(`程序归一：保留更新 ${totalStats.retainedUpdates} 条，保留新增 ${totalStats.retainedAdditions} 条，删除 ${totalStats.dropped} 条。`);
    const applied = applyKnowledgeAdditions(outline, mergedPatch);
    devLog(`最终应用：修改目录 ${applied.updateCount} 处，新增目录 ${applied.additionCount} 个。`);
    if (!applied.updateCount && !applied.additionCount) {
      log('知识库未返回可应用的目录增强项，保留原目录。', 99);
    } else {
      log(`知识库补目录已应用：修改目录 ${applied.updateCount} 处，新增目录 ${applied.additionCount} 个。`, 99);
    }
    return applied.outline;
  } catch (error) {
    log(`知识库补目录失败，已保留主目录结果：${error.message || String(error)}`, 99);
    return outline;
  }
}

async function runOutlineGenerationTask({ aiService, agentService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  let logs = ['开始生成目录。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    const technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: updateTask({ status: 'running', progress: currentProgress, logs }) });
    updateTask({ status: 'running', progress: currentProgress, logs }, technicalPlan);
  }

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(payload);
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const overview = storedPlan.projectOverview || '';
  const requirements = storedPlan.techRequirements || '';
  const missingRequiredBidAnalysisLabels = getMissingRequiredBidAnalysisLabels(storedPlan);
  if (missingRequiredBidAnalysisLabels.length) {
    throw new Error(`请先完成关键招标文件解析项：${missingRequiredBidAnalysisLabels.join('、')}`);
  }
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  const outlineExpansionMode = isExpansionWorkflow ? normalizeOutlineExpansionMode(payload, storedPlan) : 'ai-complement';
  const baseTaskPayload = {
    ...payload,
    overview,
    requirements,
    outlineExpansionMode,
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
  };
  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineMode: 'aligned',
    outlineExpansionMode,
    referenceKnowledgeDocumentIds,
    outlineGenerationTask: updateTask({ status: 'running', progress: 5, logs }),
  });
  updateTask({ status: 'running', progress: 5, logs }, technicalPlan);

  let oldOutline = null;
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成目录');
    }
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    const originalPlanMarkdown = workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成目录');
    }
    oldOutline = await extractOriginalOutline(aiService, agentService, baseTaskPayload, originalPlanMarkdown, log);
  }

  technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData: null,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    outlineGenerationTask: updateTask({ status: 'running', progress: currentProgress, logs }),
  });
  updateTask({ status: 'running', progress: currentProgress, logs }, technicalPlan);

  const taskPayload = {
    ...baseTaskPayload,
    oldOutline: formatOldOutlineForPrompt(oldOutline),
  };

  let outline;
  let groups = [];
  if (isExpansionWorkflow) {
    if (outlineExpansionMode === 'original-only') {
      log('已选择仅使用原方案目录，跳过AI补充和知识库补目录。', 96);
      technicalPlan = workspaceStore.updateTechnicalPlan({
        outlineData: { ...oldOutline, project_overview: overview },
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
        outlineGenerationTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }),
      });
      updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }, technicalPlan);
      return;
    } else {
      outline = await expansionComplementWorkflow(aiService, taskPayload, oldOutline, log);
    }
  } else {
    const alignedResult = await alignedWorkflow(aiService, agentService, taskPayload, log);
    outline = alignedResult.outline;
    groups = alignedResult.groups || [];
  }

  const knowledgeItems = loadOutlineKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);
  outline = await enhanceOutlineWithKnowledgeAdditions(aiService, taskPayload, outline, knowledgeItems, log);
  const finalResult = await runFinalOutlineGate({
    aiService,
    agentService,
    payload: taskPayload,
    outline,
    groups,
    originalOutline: oldOutline,
    workflowKind: isExpansionWorkflow ? 'existing-plan-expansion' : 'technical-plan',
    outlineExpansionMode,
    log,
  });
  outline = finalResult.outline;
  technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData: { ...outline, project_overview: overview },
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    outlineGenerationTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }),
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }, technicalPlan);
}

module.exports = { runOutlineGenerationTask };
