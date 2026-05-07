function formatSuggestions(suggestions) {
  if (!suggestions?.length) return '';
  return `\n\n本轮修正建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
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

function generateOutlineMessages({ overview, requirements, suggestions }) {
  return [
    { role: 'system', content: outlineSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `请生成完整的技术标目录结构，确保覆盖所有技术评分要点。${formatSuggestions(suggestions)}` },
  ];
}

function generateTopLevelOutlineMessages({ overview, requirements, suggestions }) {
  return [
    { role: 'system', content: topLevelOutlineSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `请仅生成一级目录列表，不要生成二级和三级目录。返回的 JSON 仍然使用 outline 字段，每个一级目录都必须包含 id、title、description。${formatSuggestions(suggestions)}` },
  ];
}

function extractRequirementGroupsMessages(requirements, suggestions) {
  const systemPrompt = `你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质、售后服务等非技术类条目
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
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求原文：\n${requirements}` },
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${group.requirement_id}\n标题：${group.title}\n描述：${group.description}\n细项：\n${detailContent}` },
    { role: 'user', content: `请仅生成该一级目录下的二级、三级目录，一级目录标题必须保持为当前给定标题，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` },
  ];
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
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `当前一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description || ''}` },
    { role: 'user', content: `请仅生成该一级目录下的二级、三级目录，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` },
  ];
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

function normalizeOutlineItem(item, path = 'outline[]') {
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
  if (raw.children !== undefined && raw.children !== null) {
    const children = requireArray(raw.children, `${path}.children`);
    if (children.length) {
      normalized.children = children.map((child, index) => normalizeOutlineItem(child, `${path}.children[${index}]`));
    }
  }

  return normalized;
}

function normalizeOutlineResponse(payload) {
  const raw = requireObject(payload, 'OutlineResponse');
  const outline = requireArray(raw.outline, 'outline');
  return { outline: outline.map((item, index) => normalizeOutlineItem(item, `outline[${index}]`)) };
}

function normalizeChildrenResponse(payload) {
  const raw = requireObject(payload, 'OutlineChildrenResponse');
  const children = requireArray(raw.children, 'children');
  return { children: children.map((item, index) => normalizeOutlineItem(item, `children[${index}]`)) };
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

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

async function generateFull(aiService, payload, suggestions, log, progress = 20) {
  log('正在一次性生成完整目录。', progress);
  return collectJson(aiService, {
    messages: generateOutlineMessages({ ...payload, suggestions }),
    temperature: 0.7,
    normalizer: normalizeOutlineResponse,
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
    normalizer: normalizeOutlineResponse,
    validator: validateTopLevelOutline,
    progressCallback: (message) => log(message, 25),
    progressLabel: '一级目录',
    failureMessage: '模型返回的目录数据格式无效',
  });
}

async function generateChildren(aiService, payload, parentItem, suggestions, log, progress) {
  return collectJson(aiService, {
    messages: generateChildrenMessages({ ...payload, parentItem, suggestions }),
    temperature: 0.7,
    normalizer: normalizeChildrenResponse,
    validator: validateChildrenOutline,
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
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
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) });
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
  return collectJson(aiService, {
    messages: generateAlignedChildrenMessages({ ...payload, parentItem, group, suggestions }),
    temperature: 0.7,
    normalizer: normalizeChildrenResponse,
    validator: validateChildrenOutline,
    progressCallback: (message) => log(message, progress),
    progressLabel: `章节 ${parentItem.title || '未命名章节'} 子目录`,
    failureMessage: '模型返回的目录数据格式无效',
  });
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
  const outline = normalizeOutlineResponse({ outline: renumber(assembled) });
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

async function runOutlineGenerationTask({ aiService, workspaceStore, updateTask, payload }) {
  let logs = ['开始生成目录。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    const technicalPlan = workspaceStore.updateTechnicalPlan({ outlineGenerationTask: updateTask({ status: 'running', progress: currentProgress, logs }) });
    updateTask({ status: 'running', progress: currentProgress, logs }, technicalPlan);
  }

  let technicalPlan = workspaceStore.updateTechnicalPlan({ outlineMode: payload.mode, outlineGenerationTask: updateTask({ status: 'running', progress: 5, logs }) });
  updateTask({ status: 'running', progress: 5, logs }, technicalPlan);
  const outline = payload.mode === 'aligned' ? await alignedWorkflow(aiService, payload, log) : await freeWorkflow(aiService, payload, log);
  technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData: { ...outline, project_overview: payload.overview },
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    outlineGenerationTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }),
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }, technicalPlan);
}

module.exports = { runOutlineGenerationTask };
