const { getBidAnalysisTasks } = require('./bidAnalysisTask.cjs');

function formatSuggestions(suggestions) {
  if (!suggestions?.length) return '';
  return `\n\n本轮修正建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

const KNOWLEDGE_RESUME_MAX_CHARS = 220;
const MAX_KNOWLEDGE_ADDITIONS = 30;

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderKnowledgeItemsForPrompt(items) {
  if (!items?.length) return '';
  return items.map((item, index) => [
    `${index + 1}. title: ${item.title}`,
    `   resume: ${truncateText(item.resume, KNOWLEDGE_RESUME_MAX_CHARS)}`,
  ].join('\n')).join('\n');
}

function collectKnowledgeAdditionParents(items) {
  const parents = [];
  function visit(nodes, level = 1, ancestors = []) {
    (nodes || []).forEach((item) => {
      const id = String(item?.id || '').trim();
      const title = String(item?.title || '').trim();
      if (id && level === 2) {
        parents.push({
          id,
          title,
          parentTitle: ancestors[0]?.title || '',
          childTitles: (item.children || []).map((child) => String(child?.title || '').trim()).filter(Boolean),
        });
      }
      if (item?.children?.length) visit(item.children, level + 1, [...ancestors, { id, title }]);
    });
  }
  visit(items || []);
  return parents;
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

function formatProcurementItemsForPrompt(items) {
  if (!items?.length) return '';
  const lines = ['当前标段采购清单（共' + items.length + '项）：'];
  items.forEach((item) => {
    const label = item.item_name || '';
    const qty = item.quantity ? ` ${item.quantity}${item.unit || '项'}` : '';
    const core = item.is_core ? ' ★核心产品' : '';
    lines.push(`${item.item_number || ''}. ${label}${qty}${core}`);
    if (item.model_spec) {
      lines.push(`   型号规格: ${item.model_spec}`);
    }
  });
  lines.push('\n请基于以上采购清单生成标书目录。核心产品应安排独立章节重点描述。每个清单项的关键技术参数应在对应章节的description中体现。');
  return lines.join('\n');
}

function formatKnowledgeAdditionParents(parents) {
  return (parents || []).map((item) => [
    `- ${item.id} ${item.title || '未命名二级目录'}（所属一级：${item.parentTitle || '未命名一级目录'}）`,
    `  已有三级目录：${item.childTitles.length ? item.childTitles.join('；') : '无'}`,
  ].join('\n')).join('\n');
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

function generateOutlineMessages({ overview, requirements, suggestions, procurementItems }) {
  const messages = [
    { role: 'system', content: outlineSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
  ];
  const procText = formatProcurementItemsForPrompt(procurementItems);
  if (procText) messages.push({ role: 'user', content: procText });
  messages.push({ role: 'user', content: `请生成完整的技术标目录结构，确保覆盖所有技术评分要点。${formatSuggestions(suggestions)}` });
  return messages;
}

function generateTopLevelOutlineMessages({ overview, requirements, suggestions, procurementItems }) {
  const messages = [
    { role: 'system', content: topLevelOutlineSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
  ];
  const procText = formatProcurementItemsForPrompt(procurementItems);
  if (procText) messages.push({ role: 'user', content: procText });
  messages.push({ role: 'user', content: `请仅生成一级目录列表，不要生成二级和三级目录。返回的 JSON 仍然使用 outline 字段，每个一级目录都必须包含 id、title、description。${formatSuggestions(suggestions)}` });
  return messages;
}

function extractRequirementGroupsMessages(requirements, suggestions) {
  const systemPrompt = `你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

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
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `请提取所有适合作为技术标一级目录的技术评分大类，保持顺序稳定，并把每个大类下的评分细项归入 detail_points。${formatSuggestions(suggestions)}` },
  ];
}

function generateAlignedChildrenMessages({ overview, requirements, parentItem, group, suggestions }) {
  const detailLines = (group.detail_points || [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item}`)
    .join('\n');
  const detailContent = detailLines || '- 未提供明确细项，请根据评分大类描述合理展开';
  const systemPrompt = `你是一个专业的标书编写专家。请围绕指定的技术评分大类，为已经固定好的一级目录生成二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他评分大类内容
4. 返回标准 JSON，格式为 {"children": [...]}，children 中只能包含当前一级目录的直接子目录
5. 每个节点必须包含 id、title、description，三级目录继续使用 children 字段
6. 章节编号必须以给定的一级目录编号为前缀，例如父级是 2，则二级目录编号从 2.1 开始，三级目录编号从 2.1.1 开始
7. 除了 JSON 结果外，不要输出任何其他内容`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求原文：\n${requirements}` },
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${group.requirement_id}\n标题：${group.title}\n描述：${group.description}\n细项：\n${detailContent}` },
  ];
  messages.push({ role: 'user', content: `请仅生成该一级目录下的二级、三级目录，一级目录标题必须保持为当前给定标题，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` });
  return messages;
}

function generateChildrenMessages({ overview, requirements, parentItem, suggestions }) {
  const systemPrompt = `你是一个专业的标书编写专家。请围绕指定的一级目录，生成其下属的二级目录和三级目录。

要求：
1. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
2. 返回标准 JSON，格式为 {"children": [...]} 
3. children 中只能包含当前一级目录的直接子目录，每个节点必须包含 id、title、description
4. 二级目录下如有三级目录，同样使用 children 字段
5. 章节编号必须以给定的一级目录编号为前缀，例如父级是 2，则二级目录编号从 2.1 开始，三级目录编号从 2.1.1 开始
6. 除了 JSON 结果外，不要输出任何其他内容`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `当前一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
  ];
  messages.push({ role: 'user', content: `请仅生成该一级目录下的二级、三级目录，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` });
  return messages;
}

function reviewOutlineMessages({ overview, requirements, outline }) {
  const systemPrompt = `你是一个严格的招标文件目录审核专家。请审核目录是否符合项目概述和技术评分要求。

要求：
1. 重点检查目录是否完整覆盖技术评分要点
2. 检查一级目录名称是否专业、准确，是否尽量与评分项原文保持一致
3. 检查目录层级是否清晰，是否达到三级目录要求，是否存在明显遗漏、错位、重复或不合理章节
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
5. 若不通过，suggestions 中必须给出具体、可执行的修改建议
6. 除了 JSON 外，不要输出任何其他内容`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `待审核目录 JSON：\n${JSON.stringify(outline)}` },
    { role: 'user', content: '请判断该目录是否满足要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。' },
  ];
}

function reviewAlignedOutlineMessages({ overview, requirements, groups, outline }) {
  const systemPrompt = `你是一个严格的招标文件目录审核专家。请审核目录是否与技术评分大类一一对应，并判断二三级目录是否覆盖各评分大类的细项。

要求：
1. 一级目录必须与提供的技术评分大类一一对应，数量一致、顺序一致、标题必须完全一致
2. 不允许缺失技术评分大类，也不允许新增、合并、改写一级目录
3. 二级和三级目录要围绕各自对应的技术评分大类与细项展开，避免错位、遗漏和明显重复
4. 检查完整目录是否层级清晰，整体是否达到三级目录要求
5. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
6. 若不通过，suggestions 中必须给出具体、可执行的修改建议，重点说明哪个评分大类覆盖不足或结构不合理
7. 除了 JSON 外，不要输出任何其他内容`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `技术评分大类 JSON：\n${JSON.stringify({ groups })}` },
    { role: 'user', content: `待审核目录 JSON：\n${JSON.stringify(outline)}` },
    { role: 'user', content: '请判断该目录是否满足一一对应要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。' },
  ];
}

function generateKnowledgeAdditionMessages({ overview, requirements, outline, knowledgeItems }) {
  const additionParents = collectKnowledgeAdditionParents(outline.outline || []);
  const sampleParent = additionParents[0]?.id || '';
  const instructionPrompt = `你是一个严格的标书目录补充专家。你只能根据参考知识库判断现有二级目录下是否缺少三级目录，并只输出新增三级目录。

要求：
1. 已有一级目录和二级目录都已经固定，不允许新增、删除、重命名、合并或调整顺序
2. 只能新增三级目录，parent_id 必须逐字复制“可补充二级目录 parent_id”中的某一个 ID
3. 不允许输出 bindings、knowledge_item_ids、id、children、outline 或完整目录
4. 不要把知识库条目绑定到目录；知识库只作为判断是否缺少三级目录的参考材料
5. 只补充与招标项目、评分项、现有二级目录主题强相关且当前三级目录确实缺失的内容
6. 不要重复已有三级目录，也不要输出同义重复目录
7. 如果没有确实需要补充的三级目录，返回空 additions 数组
8. 只返回 JSON，不要输出解释文字

返回格式：
{
  "additions": [
    { "parent_id": "${sampleParent}", "title": "新增三级目录标题", "description": "新增三级目录说明" }
  ]
}`;
  return [
    { role: 'user', content: instructionPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `当前完整目录 JSON：\n${JSON.stringify(outline, null, 2)}` },
    { role: 'user', content: `可补充二级目录 parent_id（只能逐字复制以下 ID，并在其下新增三级目录）：\n${formatKnowledgeAdditionParents(additionParents)}` },
    { role: 'user', content: `参考知识库轻量条目如下。注意：这些只是参考资料，不要输出知识库 ID，也不要绑定知识库条目。\n${renderKnowledgeItemsForPrompt(knowledgeItems)}` },
    { role: 'user', content: '请只返回知识库补充三级目录 JSON：additions。每条 additions 只能包含 parent_id、title、description。' },
  ];
}

function generateKnowledgeAdditionRepairMessages({ invalidContent, issues }, additionParents) {
  return [
    {
      role: 'user',
      content: `你是一个严格的 JSON 修复器。请把模型输出修复为“知识库补充三级目录”JSON。

必须满足：
1. 顶层只能有 additions 数组
2. 每条 additions 只能有 parent_id、title、description
3. parent_id 必须逐字复制允许的二级目录 ID
4. 禁止输出 bindings、knowledge_item_ids、id、children、outline 或完整目录
5. 如果没有可补充三级目录，返回 {"additions":[]}
6. 只返回 JSON，不要输出解释文字

允许的二级目录 parent_id：
${formatKnowledgeAdditionParents(additionParents)}`,
    },
    { role: 'user', content: `错误列表：\n${issues}` },
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
    additions: Array.isArray(payload) ? payload.length : (Array.isArray(raw.additions) ? raw.additions.length : 0),
    bindings: Array.isArray(raw.bindings) ? raw.bindings.length : 0,
    knowledge_refs: countNestedArrayEntries(payload, 'knowledge_item_ids'),
    children: countNestedArrayEntries(payload, 'children'),
  };
}

function formatAdditionSummary(summary) {
  return `additions=${summary.additions}，bindings=${summary.bindings}，knowledge_refs=${summary.knowledge_refs}，children=${summary.children}`;
}

function getKnowledgeAdditionCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  const raw = requireObject(payload, 'KnowledgeAdditionsResponse');
  if (raw.additions !== undefined && raw.additions !== null) return requireArray(raw.additions, 'additions');
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.directories)) return raw.directories;
  return [];
}

function createExistingThirdTitleKeys(outlineItems) {
  const keys = new Set();
  function visit(nodes, level = 1) {
    (nodes || []).forEach((item) => {
      const id = String(item?.id || '').trim();
      if (level === 2 && id) {
        (item.children || []).forEach((child) => {
          const key = normalizeTitleKey(child?.title);
          if (key) keys.add(`${id}::${key}`);
        });
      }
      if (item?.children?.length) visit(item.children, level + 1);
    });
  }
  visit(outlineItems || []);
  return keys;
}

function resolveKnowledgeAdditionParent(parentId, context, stats) {
  const parentInfo = context.outlineNodeMap.get(parentId);
  if (!parentInfo) return null;
  if (parentInfo.level === 2) return { parentId, parentInfo };
  if (parentInfo.level === 3 && parentInfo.parent?.id) {
    const nextParentId = String(parentInfo.parent.id || '').trim();
    const nextParentInfo = context.outlineNodeMap.get(nextParentId);
    if (nextParentInfo?.level === 2) {
      stats.adjustedParent += 1;
      return { parentId: nextParentId, parentInfo: nextParentInfo };
    }
  }
  return null;
}

function normalizeKnowledgeAddition(addition, path, context, stats, seenKeys, issues) {
  if (!addition || typeof addition !== 'object' || Array.isArray(addition)) {
    stats.dropped += 1;
    issues.push(`${path} 必须是对象`);
    return null;
  }

  const rawParentId = String(addition.parent_id || '').trim();
  if (!rawParentId) {
    stats.dropped += 1;
    issues.push(`${path}.parent_id 缺失`);
    return null;
  }
  const resolvedParent = resolveKnowledgeAdditionParent(rawParentId, context, stats);
  if (!resolvedParent) {
    stats.dropped += 1;
    issues.push(`${path}.parent_id=${rawParentId} 不是现有二级目录 ID`);
    return null;
  }

  const title = String(addition.title || addition.name || '').trim();
  if (!title) {
    stats.dropped += 1;
    issues.push(`${path}.title 缺失或为空`);
    return null;
  }

  const dedupeKey = `${resolvedParent.parentId}::${normalizeTitleKey(title)}`;
  if (seenKeys.has(dedupeKey)) {
    stats.dropped += 1;
    return null;
  }
  seenKeys.add(dedupeKey);
  stats.retained += 1;

  const description = String(addition.description || addition.summary || addition.resume || title).trim() || title;
  return { parent_id: resolvedParent.parentId, title, description };
}

function normalizeKnowledgeAdditionsResponse(payload, context) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawSummary = summarizeRawKnowledgeAdditions(payload);
  if (context.rawAttempts) context.rawAttempts.push(rawSummary);

  const candidates = getKnowledgeAdditionCandidates(payload);
  const stats = { retained: 0, dropped: 0, adjustedParent: 0 };
  const issues = [];
  const seenKeys = createExistingThirdTitleKeys(context.outline || []);
  const additions = [];

  candidates.forEach((addition, index) => {
    if (additions.length >= MAX_KNOWLEDGE_ADDITIONS) {
      stats.dropped += 1;
      return;
    }
    const normalized = normalizeKnowledgeAddition(addition, `additions[${index}]`, context, stats, seenKeys, issues);
    if (normalized) additions.push(normalized);
  });
  if (context.normalizationStats) context.normalizationStats.push(stats);

  const shouldRepair = !additions.length && (
    raw.outline !== undefined
    || raw.bindings !== undefined
    || raw.knowledge_item_ids !== undefined
    || (candidates.length > 0 && issues.length > 0)
  );
  if (shouldRepair) {
    const reason = issues.length ? issues.join('；') : '模型返回了 bindings/outline/knowledge_item_ids，但没有可应用的三级目录 additions';
    if (context.debugLog) context.debugLog(`进入修复：${reason}`);
    throw new Error(`知识库补充三级目录格式无效：${reason}`);
  }

  return { additions };
}

function validateKnowledgeAdditionsResponse(payload) {
  requireArray(payload.additions, 'additions');
}

function outlineDepth(items) {
  return items?.length ? 1 + Math.max(...items.map((item) => outlineDepth(item.children || []))) : 0;
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
  if (!(payload.children || []).length) throw new Error('二级目录不能为空');
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
  return {
    id: '',
    title: addition.title,
    description: addition.description,
  };
}

function validateTopLevelPreserved(beforeItems, afterItems) {
  if ((beforeItems || []).length !== (afterItems || []).length) {
    throw new Error('知识库补目录不允许改变一级目录数量');
  }
  (beforeItems || []).forEach((beforeItem, index) => {
    const afterItem = afterItems[index];
    if (String(beforeItem.title || '').trim() !== String(afterItem?.title || '').trim()) {
      throw new Error('知识库补目录不允许修改一级目录标题');
    }
  });
}

function applyKnowledgeAdditions(outlinePayload, patch) {
  const beforeOutline = outlinePayload.outline || [];
  const outline = cloneOutlineItems(beforeOutline);
  const nodeMap = createOutlineNodeMap(outline);

  (patch.additions || []).forEach((addition) => {
    const parent = nodeMap.get(addition.parent_id);
    if (!parent || parent.level !== 2) {
      return;
    }
    const nextItem = createOutlineItemFromKnowledgeAddition(addition);
    parent.item.children = [...(parent.item.children || []), nextItem];
  });

  const normalized = normalizeOutlineResponse({ outline: renumber(outline) }, new Set());
  validateCompleteOutline(normalized);
  validateTopLevelPreserved(beforeOutline, normalized.outline);
  return normalized;
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
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
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
  return response;
}

async function generateFallback(aiService, payload, suggestions, log, progressRange = { start: 30, end: 75 }, topProgress = 25) {
  log('正在分步生成目录，先生成一级目录。', topProgress);
  const top = await generateTopLevel(aiService, payload, suggestions, log);
  const assembled = [];
  for (const [index, item] of top.outline.entries()) {
    const progress = progressRange.start + Math.round((index / Math.max(top.outline.length, 1)) * (progressRange.end - progressRange.start));
    log(`正在生成第 ${index + 1}/${top.outline.length} 个一级目录的二三级目录：${item.title || '未命名章节'}。`, progress);
    const childrenResponse = await generateChildren(aiService, payload, item, suggestions, log, progress);
    const children = childrenResponse.children || [];
    assembled.push({ id: item.id, title: item.title, description: item.description, ...(children.length ? { children } : {}) });
  }
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

async function extractRequirementGroups(aiService, requirements, suggestions, log) {
  const response = await collectJson(aiService, {
    messages: extractRequirementGroupsMessages(requirements, suggestions),
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
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
  return response;
}

async function buildAligned(aiService, payload, groups, suggestions, log, progressRange = { start: 30, end: 75 }) {
  const top = buildTopLevelOutlineFromGroups(groups);
  validateAlignedTopLevelMapping(top, groups);
  const assembled = [];
  for (const [index, item] of top.entries()) {
    const progress = progressRange.start + Math.round((index / Math.max(top.length, 1)) * (progressRange.end - progressRange.start));
    log(`正在生成第 ${index + 1}/${top.length} 个评分大类的二三级目录：${item.title || '未命名章节'}。`, progress);
    const childrenResponse = await generateAlignedChildrenForGroup(aiService, payload, item, groups[index], suggestions, log, progress);
    const children = childrenResponse.children || [];
    assembled.push({ ...item, ...(children.length ? { children } : {}) });
  }
  log('评分项对齐目录生成完成，正在整理目录编号。', progressRange.end);
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) }, new Set());
  validateCompleteOutline(outline);
  validateAlignedTopLevelMapping(outline.outline || [], groups);
  return outline;
}

async function alignedWorkflow(aiService, payload, log) {
  log('开始提取技术评分大类。', 10);
  const groups = await extractRequirementGroups(aiService, payload.requirements, undefined, log);
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
    revisedGroups = await extractRequirementGroups(aiService, payload.requirements, suggestions, log);
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

async function enhanceOutlineWithKnowledgeAdditions(aiService, payload, outline, knowledgeItems, log) {
  if (!knowledgeItems.length) return outline;

  const outlineNodeMap = createOutlineNodeMap(outline.outline || []);
  const additionParents = collectKnowledgeAdditionParents(outline.outline || []);
  if (!additionParents.length) {
    log('当前目录没有可补充的二级目录，跳过参考知识库。', 98);
    return outline;
  }

  const rawAttempts = [];
  const normalizationStats = [];
  const isDeveloperMode = Boolean(aiService.isDeveloperMode?.());
  const devLog = (message) => {
    if (isDeveloperMode) log(`[开发者] ${message}`, 98);
  };
  log(`开始根据 ${knowledgeItems.length} 条知识库条目补充缺失三级目录。`, 98);
  devLog(`知识库补目录：可用二级父级 ${additionParents.length} 个，参考知识条目 ${knowledgeItems.length} 条。`);
  const patch = await collectJson(aiService, {
    messages: generateKnowledgeAdditionMessages({ ...payload, outline, knowledgeItems }),
    temperature: 0.3,
    normalizer: (value) => normalizeKnowledgeAdditionsResponse(value, {
      outline: outline.outline || [],
      outlineNodeMap,
      rawAttempts,
      normalizationStats,
      debugLog: devLog,
    }),
    validator: validateKnowledgeAdditionsResponse,
    repairMessagesBuilder: (context) => generateKnowledgeAdditionRepairMessages(context, additionParents),
    progressCallback: (message) => log(message, 98),
    progressLabel: '知识库补目录',
    failureMessage: '模型返回的知识库补目录格式无效',
  });

  if (rawAttempts.length) {
    devLog(`模型原始返回尝试 ${rawAttempts.length} 次：${rawAttempts.map((item, index) => `#${index + 1} ${formatAdditionSummary(item)}`).join('；')}`);
  }
  const lastStats = normalizationStats[normalizationStats.length - 1] || { retained: patch.additions.length, dropped: 0, adjustedParent: 0 };
  devLog(`程序归一：保留 ${lastStats.retained} 条，删除 ${lastStats.dropped} 条，自动改 parent ${lastStats.adjustedParent} 条。`);
  if (rawAttempts.length > 1) {
    devLog(`修复后：保留 ${lastStats.retained} 条。`);
  }
  const enhanced = applyKnowledgeAdditions(outline, patch);
  const additionCount = patch.additions.length;
  devLog(`最终应用：新增三级目录 ${additionCount} 个。`);
  if (!additionCount) {
    log('知识库未返回可补充三级目录，保留原目录。', 99);
  } else {
    log(`知识库补目录已应用：新增三级目录 ${additionCount} 个。`, 99);
  }
  return enhanced;
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
  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineMode: payload.mode,
    referenceKnowledgeDocumentIds,
    outlineGenerationTask: updateTask({ status: 'running', progress: 5, logs }),
  });
  updateTask({ status: 'running', progress: 5, logs }, technicalPlan);

  // 加载当前标段的采购清单
  let procurementItems = [];
  try {
    const currentSectionId = typeof workspaceStore.getCurrentBidSectionId === 'function'
      ? workspaceStore.getCurrentBidSectionId()
      : null;
    if (currentSectionId && typeof workspaceStore.getProcurementItemsForSection === 'function') {
      procurementItems = workspaceStore.getProcurementItemsForSection(currentSectionId);
    }
    if (!procurementItems.length && typeof workspaceStore.listProcurementItems === 'function') {
      procurementItems = workspaceStore.listProcurementItems();
    }
    if (procurementItems.length) {
      log(`检测到 ${procurementItems.length} 个采购清单项，将基于清单生成目录。`, 6);
    }
  } catch (_error) {
    // 静默降级
  }

  const taskPayload = {
    ...payload,
    overview,
    requirements,
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
    procurementItems,
  };
  let outline = taskPayload.mode === 'aligned' ? await alignedWorkflow(aiService, taskPayload, log) : await freeWorkflow(aiService, taskPayload, log);
  const knowledgeItems = loadOutlineKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);
  outline = await enhanceOutlineWithKnowledgeAdditions(aiService, taskPayload, outline, knowledgeItems, log);
  technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData: { ...outline, project_overview: overview },
    globalFactsTask: undefined,
    globalFacts: [],
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    outlineGenerationTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }),
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }, technicalPlan);
}

module.exports = { runOutlineGenerationTask };
