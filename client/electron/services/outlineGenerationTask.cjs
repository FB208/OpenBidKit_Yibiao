const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
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

function childrenOutlineStructureRules(parentId) {
  const id = String(parentId || '1').trim() || '1';
  return `结构要求：
1. 顶层 children 只能放当前一级目录的直接子目录，也就是二级目录。
2. 每个二级目录都必须包含非空 children 数组，children 内是三级目录。
3. 不要把评分细项直接作为没有子节点的二级目录；应先归纳二级主题，再在其下展开三级响应要点、实施措施、证明材料或验收标准。
4. 三级目录只包含 id、title、description，不要继续包含 children。
5. 编号必须以当前一级目录编号 ${id} 为前缀，例如二级 ${id}.1，三级 ${id}.1.1。

返回示例：
${childrenOutlineJsonExample(id)}`;
}

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const KNOWLEDGE_CONTEXT_LIMIT_RATIO = 0.8;
const MIN_KNOWLEDGE_SEGMENT_CHARS = 1000;
const MAX_KNOWLEDGE_ADDITIONS = 60;
const MAX_KNOWLEDGE_UPDATES = 120;

function renderKnowledgeItemsForPrompt(items) {
  if (!items?.length) return '';
  return items.map((item, index) => [
    `## 知识条目 ${index + 1}`,
    `title: ${String(item.title || '').trim()}`,
    `resume:\n${String(item.resume || '').trim()}`,
  ].join('\n')).join('\n\n');
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function getKnowledgeSegmentLimit(aiService, sharedMessages) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const contextLengthLimit = normalizePositiveInteger(config?.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
  const sharedLength = (sharedMessages || []).reduce((sum, message) => sum + String(message?.content || '').length + 64, 2000);
  return Math.max(MIN_KNOWLEDGE_SEGMENT_CHARS, Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO) - sharedLength);
}

function splitOversizedKnowledgeBlock(block, segmentLimit) {
  const parts = splitUserTextByContextLimit(block, {}, { contextLengthLimit: segmentLimit, limitRatio: 1 });
  return parts.map((part, index) => `${part}\n\n（该知识条目内容较长，当前为第 ${index + 1}/${parts.length} 部分。）`);
}

function buildKnowledgeSegments(knowledgeItems, aiService, sharedMessages) {
  const segmentLimit = getKnowledgeSegmentLimit(aiService, sharedMessages);
  const blocks = (knowledgeItems || [])
    .map((item, index) => renderKnowledgeItemsForPrompt([item]).replace('## 知识条目 1', `## 知识条目 ${index + 1}`))
    .filter((block) => block.trim());
  const segments = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    segments.push(current.join('\n\n'));
    current = [];
    currentLength = 0;
  };

  for (const block of blocks) {
    if (block.length > segmentLimit) {
      flush();
      splitOversizedKnowledgeBlock(block, segmentLimit).forEach((part) => segments.push(part));
      continue;
    }
    const nextLength = currentLength + block.length + (current.length ? 2 : 0);
    if (current.length && nextLength > segmentLimit) {
      flush();
    }
    current.push(block);
    currentLength += block.length + (current.length > 1 ? 2 : 0);
  }
  flush();

  return segments.map((content, index) => ({ content, index: index + 1, total: segments.length, segmentLimit }));
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

function outlineSystemPrompt() {
  return `你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的目录结构。
如果用户提供了自己编写的目录，你要保证目录满足技术评分要求，并充分结合用户自己编写的目录。

要求：
1. 目录结构要全面覆盖技术标的所有必要章节
2. 章节名称要专业、准确，符合投标文件规范
3. 一级目录名称要与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称
4. 一共包括三级目录
5. 返回标准 JSON 格式，包含章节编号、标题、描述和子章节
6. 除了 JSON 结果外，不要输出任何其他内容

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

function topLevelOutlineSystemPrompt() {
  return `你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的一级目录结构。
如果用户提供了自己编写的目录，你要保证一级目录满足技术评分要求，并充分结合用户自己编写的目录。

要求：
1. 只生成一级目录，不要生成二级和三级目录
2. 一级目录名称要专业、准确，符合投标文件规范
3. 一级目录名称要尽量与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称
4. 返回标准 JSON 格式，使用 outline 字段，每个一级目录必须包含 id、title、description
5. 除了 JSON 结果外，不要输出任何其他内容

JSON 格式要求：
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": ""
    }
  ]
}`;
}

function readExpandOutlinePrompt() {
  return `你是一个专业的标书编写专家。请严格基于用户提交的标书技术方案原文完成目录提取任务。

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

function buildOriginalOutlineExtractionInstructionMessage() {
  return {
    role: 'user',
    content: `${readExpandOutlinePrompt()}

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
    buildOriginalOutlineExtractionInstructionMessage(),
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
    messages.push({ role: 'user', content: `参考旧目录：\n${formattedOldOutline}` });
  }
  return messages;
}

function generateOutlineMessages({ overview, requirements, oldOutline, suggestions }) {
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `${outlineSystemPrompt()}\n\n请生成完整的技术标目录结构，确保覆盖所有技术评分要点；如提供了参考旧目录，请在满足技术评分要求的前提下充分结合参考旧目录。${formatSuggestions(suggestions)}` },
  ];
}

function generateTopLevelOutlineMessages({ overview, requirements, oldOutline, suggestions }) {
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `${topLevelOutlineSystemPrompt()}\n\n请仅生成一级目录列表，不要生成二级和三级目录；如提供了参考旧目录，请在满足技术评分要求的前提下充分结合参考旧目录。返回的 JSON 使用 outline 字段，每个一级目录都必须包含 id、title、description。${formatSuggestions(suggestions)}` },
  ];
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
7. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出任何其他内容

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
  const instructionPrompt = `你是一个专业的标书编写专家。请围绕指定的技术评分大类，为已经固定好的一级目录生成二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他评分大类内容
4. 返回标准 JSON，格式为 {"children": [...]}，每个节点必须包含 id、title、description
5. 除了 JSON 结果外，不要输出任何其他内容

${childrenOutlineStructureRules(parentItem.id)}`;
  const messages = [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${group.requirement_id}\n标题：${group.title}\n描述：${group.description}\n细项：\n${detailContent}` },
  ];
  messages.push({ role: 'user', content: `${instructionPrompt}\n\n请仅生成该一级目录下的二级、三级目录；每个二级目录必须包含三级目录，一级目录标题必须保持为当前给定标题。如提供了参考旧目录，请在覆盖当前技术评分大类细项的前提下参考旧目录优化当前子目录。返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` });
  return messages;
}

function generateChildrenMessages({ overview, requirements, parentItem, oldOutline, suggestions }) {
  const instructionPrompt = `你是一个专业的标书编写专家。请围绕指定的一级目录，生成其下属的二级目录和三级目录。

要求：
1. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
2. 返回标准 JSON，格式为 {"children": [...]}，每个节点必须包含 id、title、description
3. 除了 JSON 结果外，不要输出任何其他内容

${childrenOutlineStructureRules(parentItem.id)}`;
  const messages = [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `当前一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
  ];
  messages.push({ role: 'user', content: `${instructionPrompt}\n\n请仅生成该一级目录下的二级、三级目录；每个二级目录必须包含三级目录。如提供了参考旧目录，请在满足技术评分要求的前提下充分结合参考旧目录。返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` });
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

function reviewOutlineMessages({ overview, requirements, oldOutline, outline }) {
  const instructionPrompt = `你是一个严格的招标文件目录审核专家。请审核目录是否符合项目概述和技术评分要求。

要求：
1. 重点检查目录是否完整覆盖技术评分要点
2. 检查一级目录名称是否专业、准确，是否尽量与评分项原文保持一致
3. 检查目录层级是否清晰，是否达到三级目录要求，是否存在明显遗漏、错位、重复或不合理章节
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
5. 若不通过，suggestions 中必须给出具体、可执行的修改建议
6. 除了 JSON 外，不要输出任何其他内容`;
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `待审核目录 JSON：\n${JSON.stringify(outline)}` },
    { role: 'user', content: `${instructionPrompt}\n\n请判断该目录是否满足要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。` },
  ];
}

function reviewAlignedOutlineMessages({ overview, requirements, oldOutline, groups, outline }) {
  const instructionPrompt = `你是一个严格的招标文件目录审核专家。请审核目录是否与技术评分大类一一对应，并判断二三级目录是否覆盖各评分大类的细项。

要求：
1. 一级目录必须与提供的技术评分大类一一对应，数量一致、顺序一致、标题必须完全一致
2. 不允许缺失技术评分大类，也不允许新增、合并、改写一级目录
3. 二级和三级目录要围绕各自对应的技术评分大类与细项展开，避免错位、遗漏和明显重复
4. 检查完整目录是否层级清晰，整体是否达到三级目录要求
5. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
6. 若不通过，suggestions 中必须给出具体、可执行的修改建议，重点说明哪个评分大类覆盖不足或结构不合理
7. 除了 JSON 外，不要输出任何其他内容`;
  return [
    ...buildOutlineSharedContextMessages({ overview, requirements, oldOutline }),
    { role: 'user', content: `技术评分大类 JSON：\n${JSON.stringify({ groups })}` },
    { role: 'user', content: `待审核目录 JSON：\n${JSON.stringify(outline)}` },
    { role: 'user', content: `${instructionPrompt}\n\n请判断该目录是否满足一一对应要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。` },
  ];
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
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
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
  const shallowItems = outline.filter((item) => outlineDepth([item]) < 3);
  if (shallowItems.length) {
    throw new Error(`完整目录至少需要三级结构，以下一级目录缺少三级目录：${formatMissingOutlineLabels(shallowItems)}`);
  }
}

function validateTopLevelOutline(payload) {
  if (!(payload.outline || []).length) throw new Error('一级目录不能为空');
}

function validateChildrenOutline(payload) {
  const children = payload.children || [];
  if (!children.length) throw new Error('二级目录不能为空');
  const secondLevelWithoutThird = children.filter((item) => !(item.children || []).length);
  if (secondLevelWithoutThird.length) {
    throw new Error(`二级目录必须包含三级目录，缺失三级目录：${formatMissingOutlineLabels(secondLevelWithoutThird)}`);
  }
  if (outlineDepth(children) < 2) throw new Error('二级目录必须包含三级目录');
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
  validateCompleteOutline(normalized);
  validateKnowledgePatchApplied(beforeOutline, normalized.outline);
  return { outline: normalized, updateCount, additionCount };
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

async function extractOriginalOutline(aiService, originalPlanMarkdown, log) {
  log('正在从原方案中提取旧目录。', 8);
  const outline = await collectJson(aiService, {
    messages: buildExpandOutlineMessages(originalPlanMarkdown),
    temperature: 0.7,
    normalizer: (value) => normalizeOutlineResponse(value, new Set()),
    validator: validateTopLevelOutline,
    progressCallback: (message) => log(message, 12),
    progressLabel: '旧方案目录提取',
    failureMessage: '模型返回的旧方案目录数据格式无效',
  });
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

async function generateFull(aiService, payload, suggestions, log, progress = 20) {
  log('正在一次性生成完整目录。', progress);
  return collectJson(aiService, {
    messages: generateOutlineMessages({ ...payload, suggestions }),
    temperature: 0.7,
    normalizer: (value) => normalizeOutlineResponse(value, new Set()),
    validator: validateCompleteOutline,
    progressCallback: (message) => log(message, progress),
    progressLabel: '完整目录',
    failureMessage: '模型返回的目录数据格式无效',
  });
}

async function generateTopLevel(aiService, payload, suggestions, log) {
  return collectJson(aiService, {
    messages: generateTopLevelOutlineMessages({ ...payload, suggestions }),
    temperature: 0.7,
    normalizer: (value) => normalizeOutlineResponse(value, new Set()),
    validator: validateTopLevelOutline,
    progressCallback: (message) => log(message, 25),
    progressLabel: '一级目录',
    failureMessage: '模型返回的目录数据格式无效',
  });
}

async function generateChildren(aiService, payload, parentItem, suggestions, log, progress) {
  const response = await collectJson(aiService, {
    messages: generateChildrenMessages({ ...payload, parentItem, suggestions }),
    temperature: 0.7,
    normalizer: (value) => normalizeChildrenResponse(value, new Set()),
    validator: validateChildrenOutline,
    repairMessagesBuilder: (context) => generateChildrenStructureRepairMessages(context, parentItem),
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
  return response;
}

async function generateFallback(aiService, payload, suggestions, log, progressRange = { start: 30, end: 75 }, topProgress = 25) {
  log('正在分步生成目录，先生成一级目录。', topProgress);
  const top = await generateTopLevel(aiService, payload, suggestions, log);
  const childTotal = top.outline.length;
  let completedChildren = 0;
  log(`正在并发生成 ${childTotal} 个一级目录的二三级目录。`, progressRange.start);
  const childResults = await Promise.all(top.outline.map(async (item, index) => {
    const childrenResponse = await generateChildren(aiService, payload, item, suggestions, log, progressRange.start);
    const children = childrenResponse.children || [];
    completedChildren += 1;
    const progress = progressRange.start + Math.round((completedChildren / Math.max(childTotal, 1)) * (progressRange.end - progressRange.start));
    log(`已完成第 ${index + 1}/${childTotal} 个一级目录的二三级目录：${item.title || '未命名章节'}。`, progress);
    return { index, item, children };
  }));
  const assembled = childResults
    .sort((left, right) => left.index - right.index)
    .map(({ item, children }) => ({ id: item.id, title: item.title, description: item.description, ...(children.length ? { children } : {}) }));
  log('分步目录生成完成，正在整理目录编号。', progressRange.end);
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) }, new Set());
  validateCompleteOutline(outline);
  return outline;
}

async function generateByMode(aiService, payload, mode, suggestions, log, progressOptions = {}) {
  const fullProgress = progressOptions.fullProgress ?? 20;
  const fallbackRange = progressOptions.fallbackRange || { start: 30, end: 75 };
  const fallbackTopProgress = progressOptions.fallbackTopProgress ?? 25;
  const fallbackNoticeProgress = progressOptions.fallbackNoticeProgress ?? 24;
  if (mode === 'full') return [await generateFull(aiService, payload, suggestions, log, fullProgress), 'full'];
  if (mode === 'fallback') return [await generateFallback(aiService, payload, suggestions, log, fallbackRange, fallbackTopProgress), 'fallback'];
  try {
    return [await generateFull(aiService, payload, suggestions, log, fullProgress), 'full'];
  } catch (error) {
    if (error.message !== '模型返回的目录数据格式无效') throw error;
    log('一次性生成完整目录失败，切换为分步生成模式。', fallbackNoticeProgress);
    return [await generateFallback(aiService, payload, suggestions, log, fallbackRange, fallbackTopProgress), 'fallback'];
  }
}

async function reviewOutline(aiService, payload, outline, log, progressLabel, progress = 82) {
  return collectJson(aiService, {
    messages: reviewOutlineMessages({ ...payload, outline }),
    temperature: 0.3,
    normalizer: normalizeReviewResponse,
    progressCallback: (message) => log(message, progress),
    progressLabel,
    failureMessage: '模型返回的审核结果格式无效',
  });
}

async function reviewAlignedOutline(aiService, payload, groups, outline, log, progressLabel, progress = 82) {
  return collectJson(aiService, {
    messages: reviewAlignedOutlineMessages({ ...payload, groups, outline }),
    temperature: 0.3,
    normalizer: normalizeReviewResponse,
    progressCallback: (message) => log(message, progress),
    progressLabel,
    failureMessage: '模型返回的审核结果格式无效',
  });
}

async function freeWorkflow(aiService, payload, log) {
  log('开始生成目录结构。', 8);
  const [first, generationMode] = await generateByMode(aiService, payload, 'auto', undefined, log);
  log('首次目录生成完成，开始审核目录质量。', 82);
  const firstReview = await reviewOutline(aiService, payload, first, log, '首次审核', 82);
  if (firstReview.passed) {
    log('目录审核通过，准备返回结果。', 96);
    return first;
  }

  const suggestions = firstReview.suggestions?.length ? firstReview.suggestions : ['请根据项目概述和技术评分要求补全目录覆盖范围，并修正不合理章节。'];
  log('目录审核未通过，正在根据修改建议重新生成。', 88);
  let second;
  try {
    [second] = await generateByMode(aiService, payload, generationMode, suggestions, log, {
      fullProgress: 90,
      fallbackNoticeProgress: 89,
      fallbackTopProgress: 90,
      fallbackRange: { start: 90, end: 96 },
    });
  } catch {
    log('根据审核建议重新生成失败，已回退到首次生成结果。', 97);
    return first;
  }

  log('二次生成完成，开始最终审核。', 97);
  const secondReview = await reviewOutline(aiService, payload, second, log, '最终审核', 97);
  log(secondReview.passed ? '最终审核通过，准备返回修正后的结果。' : '最终审核未完全通过，已返回修正后的第二次结果。', 98);
  return second;
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

async function buildAligned(aiService, payload, groups, suggestions, log, progressRange = { start: 30, end: 75 }) {
  const top = buildTopLevelOutlineFromGroups(groups);
  validateAlignedTopLevelMapping(top, groups);
  const childTotal = top.length;
  let completedChildren = 0;
  log(`正在并发生成 ${childTotal} 个评分大类的二三级目录。`, progressRange.start);
  const childResults = await Promise.all(top.map(async (item, index) => {
    const childrenResponse = await generateAlignedChildrenForGroup(aiService, payload, item, groups[index], suggestions, log, progressRange.start);
    const children = childrenResponse.children || [];
    completedChildren += 1;
    const progress = progressRange.start + Math.round((completedChildren / Math.max(childTotal, 1)) * (progressRange.end - progressRange.start));
    log(`已完成第 ${index + 1}/${childTotal} 个评分大类的二三级目录：${item.title || '未命名章节'}。`, progress);
    return { index, item, children };
  }));
  const assembled = childResults
    .sort((left, right) => left.index - right.index)
    .map(({ item, children }) => ({ ...item, ...(children.length ? { children } : {}) }));
  log('评分项对齐目录生成完成，正在整理目录编号。', progressRange.end);
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) }, new Set());
  validateCompleteOutline(outline);
  validateAlignedTopLevelMapping(outline.outline || [], groups);
  return outline;
}

async function alignedWorkflow(aiService, payload, log) {
  log('开始提取技术评分大类。', 10);
  const groups = await extractRequirementGroups(aiService, payload, undefined, log);
  log('技术评分大类提取完成，正在构建一级目录。', 24);
  const first = await buildAligned(aiService, payload, groups, undefined, log, { start: 30, end: 75 });
  log('目录生成完成，正在审核与技术评分项的对应关系。', 82);
  const firstReview = await reviewAlignedOutline(aiService, payload, groups, first, log, '首次审核', 82);
  if (firstReview.passed) {
    log('目录审核通过，准备返回结果。', 96);
    return first;
  }

  const suggestions = firstReview.suggestions?.length ? firstReview.suggestions : ['请保持一级目录与技术评分大类标题完全一致，并补全各大类下遗漏的评分细项。'];
  log('目录审核未通过，正在根据修改建议重新提取技术评分大类并重新生成目录。', 88);
  let revisedGroups = groups;
  let second;
  try {
    log('正在根据审核建议重新提取技术评分大类。', 90);
    revisedGroups = await extractRequirementGroups(aiService, payload, suggestions, log);
    second = await buildAligned(aiService, payload, revisedGroups, suggestions, log, { start: 91, end: 96 });
  } catch {
    log('根据审核建议重新生成失败，已回退到首次生成结果。', 97);
    return first;
  }

  log('二次生成完成，开始最终审核。', 97);
  const secondReview = await reviewAlignedOutline(aiService, payload, revisedGroups, second, log, '最终审核', 97);
  log(secondReview.passed ? '最终审核通过，准备返回修正后的结果。' : '最终审核未完全通过，已返回修正后的第二次结果。', 98);
  return second;
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
    log(`知识库内容较多，已拆分为 ${knowledgeSegments.length} 段并发处理。`, 98);
  }
  devLog(`知识库补目录：参考知识条目 ${knowledgeItems.length} 条，分段 ${knowledgeSegments.length} 段，每段知识库预算约 ${knowledgeSegments[0]?.segmentLimit || 0} 字符。`);

  try {
    let completedSegments = 0;
    const segmentResults = await Promise.all(knowledgeSegments.map(async (segment) => {
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
    }));

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

async function runOutlineGenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
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
  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineMode: payload.mode,
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
    oldOutline = await extractOriginalOutline(aiService, originalPlanMarkdown, log);
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
    ...payload,
    overview,
    requirements,
    oldOutline: formatOldOutlineForPrompt(oldOutline),
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
  };
  let outline = taskPayload.mode === 'aligned' ? await alignedWorkflow(aiService, taskPayload, log) : await freeWorkflow(aiService, taskPayload, log);
  const knowledgeItems = loadOutlineKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);
  outline = await enhanceOutlineWithKnowledgeAdditions(aiService, taskPayload, outline, knowledgeItems, log);
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
