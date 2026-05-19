const zlib = require('node:zlib');

const IMAGE_STYLES = new Set(['engineering_diagram', 'realistic_photo']);
const MERMAID_REPAIR_ATTEMPTS = 3;
const MERMAID_RENDER_TIMEOUT_MS = 15000;
const AI_IMAGE_CONCURRENCY = 2;
const MERMAID_IMAGE_CONCURRENCY = 5;
const TABLE_REQUIREMENT_LABELS = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGeneratedMarkdown(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => {
      const normalizedLine = line.replace(/<br\s*\/?\s*>/gi, '<br />');
      if (normalizedLine.trim().startsWith('|')) {
        return normalizedLine;
      }
      return normalizedLine.replace(/\s*<br \/>\s*/g, '  \n');
    })
    .join('\n');
}

function normalizeMermaidCode(value) {
  return String(value || '')
    .replace(/^```mermaid\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function encodeMermaidForInk(code) {
  const state = JSON.stringify({
    code: String(code || ''),
    mermaid: { theme: 'default' },
  });
  return `pako:${zlib.deflateSync(Buffer.from(state, 'utf-8')).toString('base64url')}`;
}

function mermaidInkUrl(code) {
  return `https://mermaid.ink/img/${encodeMermaidForInk(code)}?type=png&bgColor=!white`;
}

function compactError(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function assertMermaidPreviewCompatible(code) {
  const normalized = normalizeMermaidCode(code);
  if (!normalized) {
    throw new Error('Mermaid 代码为空');
  }
  if (/[;；]/.test(normalized)) {
    throw new Error('Mermaid 代码包含分号，前端渲染兼容性较差，请改为每行一个语句且不使用分号');
  }
  if (/\s&\s/.test(normalized) && /-->|---|==>/.test(normalized)) {
    throw new Error('Mermaid 代码包含多节点 & 连接简写，请展开为多条独立连线');
  }
  if (/\[[^\]\n"']*[\u3400-\u9fff][^\]\n"']*\]/u.test(normalized)) {
    throw new Error('Mermaid 中文节点标签需要使用双引号，例如 A["项目启动"]');
  }
  if (/^\s*[\u3400-\u9fff][\w\u3400-\u9fff-]*\s*(?:-->|---|==>)/mu.test(normalized)) {
    throw new Error('Mermaid 节点 ID 需要使用 ASCII 字母数字，不要直接使用中文作为节点 ID');
  }
}

async function readResponseSnippet(response) {
  try {
    const text = await response.text();
    return compactError(text, 240);
  } catch (_error) {
    return '';
  }
}

async function validateMermaidRender(code) {
  const normalized = normalizeMermaidCode(code);
  assertMermaidPreviewCompatible(normalized);
  if (typeof fetch !== 'function') {
    throw new Error('当前运行环境不支持 Mermaid 渲染校验');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MERMAID_RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(mermaidInkUrl(normalized), { signal: controller.signal });
    const contentType = response.headers?.get?.('content-type') || '';
    if (!response.ok || !/image\//i.test(contentType)) {
      const detail = await readResponseSnippet(response);
      throw new Error(`Mermaid 渲染失败：HTTP ${response.status || 'unknown'}${detail ? `，${detail}` : ''}`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Mermaid 渲染校验超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePriority(value) {
  const priority = Math.round(Number(value) || 0);
  return Math.max(1, Math.min(priority || 3, 5));
}

function normalizeTableRequirement(value) {
  const text = String(value || '').trim();
  if (['none', 'light', 'moderate', 'heavy'].includes(text)) {
    return text;
  }
  if (text === '不要') return 'none';
  if (text === '少量') return 'light';
  if (text === '适中') return 'moderate';
  if (text === '大量') return 'heavy';
  return 'heavy';
}

function maxTablesForRequirement(requirement, leafCount) {
  if (requirement === 'none') return 0;
  if (requirement === 'light') return Math.floor(Math.max(0, leafCount) * 0.2);
  if (requirement === 'moderate') return Math.floor(Math.max(0, leafCount) * 0.4);
  return null;
}

function clearContentPlanTable(contentPlan) {
  return {
    ...contentPlan,
    table: {
      needed: false,
      purpose: '',
    },
  };
}

function normalizeKnowledgeItemIds(value, allowedKnowledgeItemIds) {
  const source = Array.isArray(value) ? value : [];
  const ids = source.map((id) => String(id || '').trim()).filter(Boolean);
  const filtered = allowedKnowledgeItemIds instanceof Set
    ? ids.filter((id) => allowedKnowledgeItemIds.has(id))
    : ids;
  return [...new Set(filtered)];
}

function normalizeContentPlan(value, allowedKnowledgeItemIds) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  const knowledgeSource = source.knowledge;
  const knowledge = knowledgeSource && typeof knowledgeSource === 'object' && !Array.isArray(knowledgeSource) ? knowledgeSource : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds;
  const table = source.table && typeof source.table === 'object' ? source.table : {};
  const image = source.image && typeof source.image === 'object' ? source.image : {};
  const mermaid = source.mermaid && typeof source.mermaid === 'object' ? source.mermaid : {};
  const tableNeeded = Boolean(table.needed);
  const mermaidTitle = singleLine(mermaid.title);
  const mermaidCode = normalizeMermaidCode(mermaid.code);
  const mermaidNeeded = Boolean(mermaid.needed) && Boolean(mermaidTitle && mermaidCode);
  const imageStyle = IMAGE_STYLES.has(image.style) ? image.style : '';
  const imageTitle = singleLine(image.title);
  const imagePrompt = String(image.prompt || '').trim();
  const imageNeeded = Boolean(image.needed) && Boolean(imageStyle && imageTitle && imagePrompt);

  return {
    knowledge: {
      item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowedKnowledgeItemIds),
    },
    table: {
      needed: tableNeeded,
      purpose: tableNeeded ? singleLine(table.purpose) : '',
    },
    mermaid: {
      needed: mermaidNeeded,
      title: mermaidNeeded ? mermaidTitle : '',
      code: mermaidNeeded ? mermaidCode : '',
      priority: mermaidNeeded ? normalizePriority(mermaid.priority) : 0,
      reason: mermaidNeeded ? singleLine(mermaid.reason) : '',
    },
    image: {
      needed: imageNeeded,
      style: imageNeeded ? imageStyle : '',
      title: imageNeeded ? imageTitle : '',
      prompt: imageNeeded ? imagePrompt : '',
      priority: imageNeeded ? normalizePriority(image.priority) : 0,
      reason: imageNeeded ? singleLine(image.reason) : '',
    },
  };
}

function normalizeIllustrationType(value) {
  return ['ai', 'mermaid', 'none'].includes(value) ? value : 'none';
}

function createStoredContentPlan(plan, illustrationType) {
  return {
    plan: normalizeContentPlan(plan),
    illustration_type: normalizeIllustrationType(illustrationType),
    updated_at: now(),
  };
}

function normalizeStoredContentPlan(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const plan = normalizeContentPlan(value.plan || value.contentPlan || value);
  return {
    plan,
    illustration_type: normalizeIllustrationType(value.illustration_type || value.illustrationType),
    updated_at: value.updated_at || value.updatedAt || now(),
  };
}

function pruneContentGenerationPlans(plans, leaves) {
  const leafIds = new Set(leaves.map(({ item }) => item.id));
  const next = {};
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (!leafIds.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan) {
      next[itemId] = storedPlan;
    }
  }
  return next;
}

function validateContentPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('正文编排决策必须是对象');
  }
  if (!plan.knowledge || !Array.isArray(plan.knowledge.item_ids)) {
    throw new Error('正文编排决策缺少 knowledge.item_ids');
  }
  if (!plan.table || typeof plan.table.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 table.needed');
  }
  if (!plan.image || typeof plan.image.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 image.needed');
  }
  if (!plan.mermaid || typeof plan.mermaid.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 mermaid.needed');
  }
  if (plan.image.needed && !IMAGE_STYLES.has(plan.image.style)) {
    throw new Error('正文配图风格无效');
  }
}

function normalizeMermaidRepairResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  return {
    code: normalizeMermaidCode(source.code || source.fixed_code || source.mermaid_code || source.mermaid?.code || ''),
  };
}

function validateMermaidRepairResult(result) {
  if (!result?.code) {
    throw new Error('Mermaid 修复结果缺少 code');
  }
  if (/```/.test(result.code)) {
    throw new Error('Mermaid 修复结果不能包含 Markdown 代码围栏');
  }
}

function formatContentPlanForPrompt(plan) {
  const lines = [
    `表格：${plan.table.needed ? `需要，目的：${plan.table.purpose || '提升正文表达清晰度'}` : '不需要，本小节不要输出 Markdown 表格'}`,
    `AI 生图：${plan.image.needed ? `需要，风格：${plan.image.style}，标题：${plan.image.title}` : '不需要'}`,
  ];
  return lines.join('\n');
}

function buildMermaidRepairMessages({ chapter, parentChapters, siblingChapters, projectOverview, regenerateRequirement, mermaidPlan, invalidCode, errorMessage, attempt }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const messages = [
    {
      role: 'system',
      content: `你是 Mermaid 图代码修复助手。请根据渲染错误修复现有 Mermaid 代码。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 目标是让 Mermaid 在浏览器前端稳定渲染，优先做最小必要修改。
3. 优先使用 flowchart TD；节点 ID 只使用 ASCII 字母、数字和下划线。
4. 中文节点标签必须写成 A["中文标签"]，不要写成 A[中文标签]。
5. 不使用 & 多节点连接简写，必须展开成多条独立连线。
6. 不使用分号；每行只写一个 Mermaid 语句。
7. 不要输出 Markdown 代码围栏。
8. 如果原图结构过于复杂，请简化为可渲染的核心流程图。`,
    },
  ];

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }
  if (parentChapters?.length) {
    messages.push({
      role: 'user',
      content: ['上级章节信息：', ...parentChapters.map((parent) => `- ${parent.id || 'unknown'} ${parent.title || '未命名章节'}\n  ${parent.description || ''}`)].join('\n'),
    });
  }
  if (siblingChapters?.length) {
    const siblingLines = ['同级章节信息：'];
    for (const sibling of siblingChapters) {
      if (sibling.id !== chapterId) {
        siblingLines.push(`- ${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}\n  ${sibling.description || ''}`);
      }
    }
    if (siblingLines.length > 1) {
      messages.push({ role: 'user', content: siblingLines.join('\n') });
    }
  }
  if (String(regenerateRequirement || '').trim()) {
    messages.push({ role: 'user', content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}` });
  }

  messages.push({
    role: 'user',
    content: `当前章节：${chapterId} ${chapterTitle}
章节描述：${chapter.description || ''}
Mermaid 图标题：${mermaidPlan.title || '流程图'}
修复轮次：${attempt}/${MERMAID_REPAIR_ATTEMPTS}
渲染错误：${errorMessage || '未知错误'}

待修复 Mermaid 代码：
\`\`\`mermaid
${normalizeMermaidCode(invalidCode)}
\`\`\`

请返回 JSON：
{
  "code": "修复后的 Mermaid 代码，不包含 Markdown 代码围栏"
}`,
  });

  return messages;
}

function renderKnowledgeItemsForPrompt(items) {
  return JSON.stringify((items || []).map((item) => ({
    id: String(item.id || '').trim(),
    title: String(item.title || '').trim(),
    resume: String(item.resume || '').trim(),
  })).filter((item) => item.id && item.title && item.resume), null, 2);
}

function buildChapterContentPlanMessages({ chapter, parentChapters, siblingChapters, projectOverview, regenerateRequirement, tableRequirement, maxTables, tableTotalSections, imageGenerationAvailable, mermaidGenerationAvailable, maxAiImages, totalSections, knowledgeItems }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const chapterDescription = chapter.description || '';
  const tableRequirementLabel = TABLE_REQUIREMENT_LABELS[tableRequirement] || TABLE_REQUIREMENT_LABELS.heavy;
  const tablePlanningAllowed = tableRequirement !== 'none';
  const tableLimitInstruction = tableRequirement === 'heavy'
    ? '表格需求为“大量”，保持现有编排逻辑；仍然只有明显适合表格的小节才将 table.needed 设为 true。'
    : tableRequirement === 'none'
      ? '表格需求为“不要”，table.needed 必须为 false，table.purpose 留空。'
      : `表格需求为“${tableRequirementLabel}”，table.needed 表示进入表格候选池，不代表最终一定生成；全文表格上限为 ${maxTables || 0} 个，共 ${tableTotalSections || totalSections || 0} 个叶子小节，系统后续会全局择优。`;
  const messages = [
    {
      role: 'system',
      content: `你是投标技术方案正文编排助手。请根据章节上下文判断本小节最适合的表达方式。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. ${tablePlanningAllowed ? '由你自行判断是否适合使用表格或配图，判断要克制、合情合理，不要为了形式而硬插。' : '本次不编排表格，table.needed 必须为 false；仍可判断是否适合配图。'}
3. ${tableLimitInstruction}
4. ${tablePlanningAllowed ? '表格仅在能明显提升表达清晰度时使用，例如归纳职责、步骤、参数、风险、措施、成果等。' : '不要为了满足 JSON 格式而编造表格目的。'}
5. ${mermaidGenerationAvailable ? '可以自行判断是否需要 Mermaid 图；Mermaid 只适合简单、抽象、文本节点型关系图，例如少量节点的流程、层级、时间线或职责关系，不用于复杂工程场景或实物示意。' : '当前未启用 Mermaid 图，mermaid.needed 必须为 false。'}
6. ${imageGenerationAvailable ? '可以自行判断是否需要 AI 生图；AI 生图适合设备、现场、机柜、电池、系统架构、部署拓扑、施工/运维场景、工程空间关系、实物示意等更具象的图。' : '当前未启用或不可用 AI 生图，image.needed 必须为 false。'}
7. Mermaid 图和 AI 生图都只是候选判断，可以同时为 true；系统会在配图阶段保证同一个章节最终只执行一种配图。
8. ${imageGenerationAvailable ? `image.needed 表示进入 AI 生图候选池，不代表最终一定生成；本次 AI 生图上限为 ${maxAiImages || 0} 张，共 ${totalSections || 0} 个小节，系统后续会全局择优。` : '由于 AI 生图不可用，image 字段只需返回不需要。'}
9. ${imageGenerationAvailable ? '不要求用满 AI 生图上限；但遇到具象工程对象或现场场景时，不要过度保守，可以适度提名候选。没有具象对象、空间关系或实物场景时仍不要硬插。' : '不要为了满足格式而编造 AI 生图需求。'}
10. priority 含义：3 表示有价值候选，4 表示推荐，5 表示强推荐；只有达到 3 才将 image.needed 设为 true。
11. engineering_diagram 表示工程图示风，适合系统架构、部署拓扑、设备连接、机柜布置、电池更换方案、施工组织或运维场景示意等具象工程图。
12. realistic_photo 表示专业实景示意风，适合设备、场地、机房、施工现场、检测工具、运维操作等真实场景表现。
13. knowledge.item_ids 只能从参考知识库轻量条目的 id 中选择；可以多选，可以为空数组；不要编造 id，不要输出 reason。`,
    },
  ];

  messages.push({
    role: 'user',
    content: `参考知识库轻量条目（只包含 id、标题和简介，不包含正文；如无合适条目，knowledge.item_ids 返回空数组）：
${renderKnowledgeItemsForPrompt(knowledgeItems)}`,
  });

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }

  if (parentChapters?.length) {
    messages.push({
      role: 'user',
      content: ['上级章节信息：', ...parentChapters.map((parent) => `- ${parent.id || 'unknown'} ${parent.title || '未命名章节'}\n  ${parent.description || ''}`)].join('\n'),
    });
  }

  if (siblingChapters?.length) {
    const siblingLines = ['同级章节信息：'];
    for (const sibling of siblingChapters) {
      if (sibling.id !== chapterId) {
        siblingLines.push(`- ${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}\n  ${sibling.description || ''}`);
      }
    }
    if (siblingLines.length > 1) {
      messages.push({ role: 'user', content: siblingLines.join('\n') });
    }
  }

  if (String(regenerateRequirement || '').trim()) {
    messages.push({ role: 'user', content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}` });
  }

  messages.push({
    role: 'user',
    content: `请为以下章节返回正文编排 JSON：

章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

JSON 格式：
{
  "knowledge": {
    "item_ids": ["从参考知识库轻量条目中选择的 id；没有合适条目时返回空数组"]
  },
  "table": {
    "needed": true,
    "purpose": "说明表格在本小节中要表达什么；不需要表格时留空"
  },
  "mermaid": {
    "needed": false,
    "title": "Mermaid 图标题；不需要时留空",
    "code": "合法 Mermaid 代码，不包含 Markdown 代码围栏；不需要时留空",
    "priority": 3,
    "reason": "为什么适合或不适合 Mermaid 图"
  },
  "image": {
    "needed": false,
    "style": "engineering_diagram 或 realistic_photo；不需要配图时留空",
    "title": "图片标题；不需要配图时留空",
    "prompt": "用于生图模型的中文提示词；不需要配图时留空",
    "priority": 3,
    "reason": "为什么适合或不适合 AI 生图"
  }
}`,
  });

  return messages;
}

function formatKnowledgeContentsForPrompt(contents) {
  return (contents || [])
    .map((content) => `<knowledge_content>\n${String(content || '').trim()}\n</knowledge_content>`)
    .join('\n\n');
}

function buildChapterContentMessages({ chapter, parentChapters, siblingChapters, projectOverview, regenerateRequirement, contentPlan, knowledgeContents }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const chapterDescription = chapter.description || '';
  const messages = [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 注意避免与同级章节内容重复，保持内容的独特性和互补性。
6. 可以使用 Markdown 段落、列表和表格；表格必须服务于内容表达，不要为了形式硬插。
7. 正文只生成文字、列表、表格等内容，配图由系统另行处理。
8. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown；配图由系统另行处理。
9. 表格单元格内如有多项内容，优先使用编号、顿号、分号或短句，不要使用 HTML <br> 标签。
10. 直接返回章节内容，不生成标题，不要任何额外说明。`,
    },
  ];

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }

  if (knowledgeContents?.length) {
    messages.push({
      role: 'user',
      content: '参考正文素材使用规则：以下内容只作为可吸收的技术素材。请改写为当前项目语境下的投标技术方案正文，不要照抄，不要提到“知识库”“历史文档”“参考资料”或素材来源。',
    });
    messages.push({
      role: 'user',
      content: `参考正文素材：\n${formatKnowledgeContentsForPrompt(knowledgeContents)}`,
    });
  }

  if (parentChapters?.length) {
    const parentLines = ['上级章节信息：'];
    for (const parent of parentChapters) {
      parentLines.push(`- ${parent.id || 'unknown'} ${parent.title || '未命名章节'}\n  ${parent.description || ''}`);
    }
    messages.push({ role: 'user', content: parentLines.join('\n') });
  }

  if (siblingChapters?.length) {
    const siblingLines = ['同级章节信息（请避免内容重复）：'];
    for (const sibling of siblingChapters) {
      if (sibling.id === chapterId) {
        continue;
      }
      siblingLines.push(`- ${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}\n  ${sibling.description || ''}`);
    }
    if (siblingLines.length > 1) {
      messages.push({ role: 'user', content: siblingLines.join('\n') });
    }
  }

  if (String(regenerateRequirement || '').trim()) {
    messages.push({
      role: 'user',
      content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}`,
    });
  }

  if (contentPlan) {
    messages.push({
      role: 'user',
      content: `正文编排决策：\n${formatContentPlanForPrompt(contentPlan)}`,
    });
  }

  messages.push({
    role: 'user',
    content: `请为以下标书章节生成具体内容：

当前章节信息：
章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

请根据项目概述信息和上述章节层级关系，生成详细的专业内容，确保与上级章节的内容逻辑相承，同时避免与同级章节内容重复，突出本章节的独特性和技术方案优势。
直接返回编写的正文内容，不要输出标题、解释、总结等任何其他内容`,
  });

  return messages;
}

function normalizeChildren(item) {
  return Array.isArray(item.children) ? item.children : [];
}

function collectLeafContexts(items, parents = []) {
  const results = [];
  for (const item of items || []) {
    const children = normalizeChildren(item);
    if (!children.length) {
      results.push({ item, parentChapters: parents, siblingChapters: items || [] });
      continue;
    }
    results.push(...collectLeafContexts(children, [...parents, item]));
  }
  return results;
}

function normalizeReferenceDocumentIds(payload, storedPlan) {
  const raw = payload?.reference_knowledge_document_ids
    ?? payload?.referenceKnowledgeDocumentIds
    ?? storedPlan?.referenceKnowledgeDocumentIds
    ?? [];
  return Array.isArray(raw)
    ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

function loadContentKnowledgeItems(knowledgeBaseService, documentIds, log) {
  if (!documentIds.length) {
    log('本次正文编排未选择参考知识库。');
    return [];
  }
  if (!knowledgeBaseService?.getOutlineReferences) {
    log('未找到知识库读取服务，正文编排不使用知识库。');
    return [];
  }

  try {
    const result = knowledgeBaseService.getOutlineReferences(documentIds);
    const items = Array.isArray(result?.items) ? result.items.map((item) => ({
      id: String(item?.id || '').trim(),
      title: String(item?.title || '').trim(),
      resume: String(item?.resume || '').trim(),
    })).filter((item) => item.id && item.title && item.resume) : [];
    log(items.length ? `正文编排已读取 ${items.length} 条知识库轻量条目。` : '未读取到可用知识库轻量条目，正文编排不使用知识库。');
    return items;
  } catch (error) {
    log(`读取正文编排参考知识库失败，已跳过：${error.message || String(error)}`);
    return [];
  }
}

function loadContentKnowledgeContentMap(knowledgeBaseService, documentIds, log) {
  const map = new Map();
  if (!documentIds.length || !knowledgeBaseService?.readItems) {
    return map;
  }

  for (const documentId of documentIds) {
    try {
      const items = knowledgeBaseService.readItems(documentId);
      for (const item of Array.isArray(items) ? items : []) {
        const itemId = String(item?.id || '').trim();
        const content = String(item?.content || '').trim();
        if (!itemId || !content) {
          continue;
        }
        map.set(`${documentId}::${itemId}`, { content });
      }
    } catch (error) {
      log(`读取知识库正文素材失败，已跳过文档 ${documentId}：${error.message || String(error)}`);
    }
  }

  if (map.size) {
    log(`正文生成可用知识库正文素材 ${map.size} 条。`);
  }
  return map;
}

function resolveKnowledgeContents(itemIds, knowledgeContentMap) {
  const selected = new Set(normalizeKnowledgeItemIds(itemIds));
  if (!selected.size || !(knowledgeContentMap instanceof Map) || !knowledgeContentMap.size) {
    return [];
  }

  const contents = [];
  for (const [id, item] of knowledgeContentMap.entries()) {
    if (selected.has(id) && item?.content) {
      contents.push(item.content);
    }
  }
  return contents;
}

function updateOutlineItemContent(items, targetId, content) {
  return (items || []).map((item) => {
    if (item.id === targetId) {
      return { ...item, content };
    }

    const children = normalizeChildren(item);
    if (!children.length) {
      return item;
    }

    return { ...item, children: updateOutlineItemContent(children, targetId, content) };
  });
}

function clearOutlineContent(items) {
  return (items || []).map((item) => {
    const { content, children, ...rest } = item;
    const normalizedChildren = normalizeChildren(item);
    return normalizedChildren.length
      ? { ...rest, children: clearOutlineContent(normalizedChildren) }
      : rest;
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unwrapMarkdownTitle(line) {
  let normalized = String(line || '').trim();
  normalized = normalized.replace(/^#{1,6}\s+/, '').trim();
  normalized = normalized.replace(/^\*\*(.+)\*\*$/, '$1').trim();
  normalized = normalized.replace(/^__(.+)__$/, '$1').trim();
  return normalized.replace(/[：:：。\s]+$/, '').trim();
}

function stripRepeatedChapterTitle(content, chapter) {
  const title = String(chapter?.title || '').trim();
  if (!title) {
    return content;
  }

  const rawLines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let firstContentLine = rawLines.findIndex((line) => line.trim());
  if (firstContentLine < 0) {
    return content;
  }

  const chapterId = String(chapter?.id || '').trim();
  const firstLine = unwrapMarkdownTitle(rawLines[firstContentLine]);
  let comparable = firstLine;

  if (chapterId) {
    comparable = comparable.replace(new RegExp(`^${escapeRegExp(chapterId)}\\s+`), '').trim();
  }
  comparable = comparable.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '').trim();

  if (comparable !== title && firstLine !== `${chapterId} ${title}`.trim()) {
    return content;
  }

  const nextLines = rawLines.slice(firstContentLine + 1);
  while (nextLines.length && !nextLines[0].trim()) {
    nextLines.shift();
  }
  return [...rawLines.slice(0, firstContentLine), ...nextLines].join('\n').trimStart();
}

function appendGeneratedImageMarkdown(content, imagePlan, generatedImage) {
  if (!generatedImage?.asset_url) {
    return content;
  }

  const title = singleLine(imagePlan.title || generatedImage.title || '技术方案配图');
  const caption = title.endsWith('示意图') ? title : `${title}示意图`;
  const normalizedContent = String(content || '').trimEnd();
  return `${normalizedContent}\n\n![${caption}](${generatedImage.asset_url})\n\n*图：${caption}*`;
}

function appendMermaidImageMarkdown(content, mermaidPlan) {
  if (!mermaidPlan?.code) {
    return content;
  }

  const title = singleLine(mermaidPlan.title || '流程图');
  const caption = title.endsWith('图') ? title : `${title}图`;
  const code = normalizeMermaidCode(mermaidPlan.code);
  const normalizedContent = String(content || '').trimEnd();
  return `${normalizedContent}\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\n*图：${caption}*`;
}

async function prepareRenderableMermaidPlan({ aiService, context, projectOverview, regenerateRequirement, mermaidPlan }) {
  const { item, parentChapters, siblingChapters } = context;
  let currentPlan = { ...mermaidPlan, code: normalizeMermaidCode(mermaidPlan.code) };
  let lastError = null;

  try {
    await validateMermaidRender(currentPlan.code);
    return { ok: true, plan: currentPlan, attempts: 0 };
  } catch (error) {
    lastError = error;
  }

  for (let attempt = 1; attempt <= MERMAID_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      const repaired = await aiService.collectJsonResponse({
        messages: buildMermaidRepairMessages({
          chapter: item,
          parentChapters,
          siblingChapters,
          projectOverview,
          regenerateRequirement,
          mermaidPlan: currentPlan,
          invalidCode: currentPlan.code,
          errorMessage: compactError(lastError?.message || lastError),
          attempt,
        }),
        temperature: 0.1,
        progressLabel: 'Mermaid 配图修复',
        failureMessage: '模型返回的 Mermaid 修复结果格式无效',
        normalizer: normalizeMermaidRepairResult,
        validator: validateMermaidRepairResult,
        max_retries: 1,
      });
      currentPlan = { ...currentPlan, code: repaired.code };
      await validateMermaidRender(currentPlan.code);
      return { ok: true, plan: currentPlan, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }

  return { ok: false, plan: currentPlan, attempts: MERMAID_REPAIR_ATTEMPTS, error: compactError(lastError?.message || lastError || '渲染失败') };
}

function pickDistributedImageTargets(plannedItems, limit) {
  if (limit <= 0 || !plannedItems.length) {
    return new Set();
  }

  if (plannedItems.length <= limit) {
    return new Set(plannedItems.map(({ item }) => item.id));
  }

  const selected = new Map();
  for (let slot = 0; slot < limit; slot += 1) {
    const start = Math.floor((slot * plannedItems.length) / limit);
    const end = Math.floor(((slot + 1) * plannedItems.length) / limit);
    const group = plannedItems.slice(start, Math.max(start + 1, end));
    const best = group.reduce((current, candidate) => (
      candidate.plan.image.priority > current.plan.image.priority ? candidate : current
    ), group[0]);
    selected.set(best.item.id, best);
  }

  if (selected.size < limit) {
    const remaining = plannedItems
      .filter(({ item }) => !selected.has(item.id))
      .sort((a, b) => b.plan.image.priority - a.plan.image.priority);
    for (const candidate of remaining) {
      if (selected.size >= limit) break;
      selected.set(candidate.item.id, candidate);
    }
  }

  return new Set(selected.keys());
}

function pickDistributedTableTargets(plannedItems, limit) {
  if (limit <= 0 || !plannedItems.length) {
    return new Set();
  }

  if (plannedItems.length <= limit) {
    return new Set(plannedItems.map(({ item }) => item.id));
  }

  const selected = new Map();
  for (let slot = 0; slot < limit; slot += 1) {
    const start = Math.floor((slot * plannedItems.length) / limit);
    const end = Math.floor(((slot + 1) * plannedItems.length) / limit);
    const group = plannedItems.slice(start, Math.max(start + 1, end));
    const candidate = group[Math.floor(group.length / 2)] || group[0];
    selected.set(candidate.item.id, candidate);
  }

  return new Set(selected.keys());
}

function countRetainedTablePlans(plans, excludedItemIds) {
  let count = 0;
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (excludedItemIds?.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan?.plan?.table?.needed) {
      count += 1;
    }
  }
  return count;
}

function createImageStat() {
  return { planned: 0, attempted: 0, success: 0, failed: 0, skipped: 0 };
}

function sumImageStats(ai, mermaid) {
  return {
    planned: ai.planned + mermaid.planned,
    attempted: ai.attempted + mermaid.attempted,
    success: ai.success + mermaid.success,
    failed: ai.failed + mermaid.failed,
    skipped: ai.skipped + mermaid.skipped,
  };
}

async function runWithConcurrency(items, limit, worker) {
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

function createInitialSections(leaves, existingSections) {
  const next = { ...(existingSections || {}) };
  const leafIds = new Set(leaves.map(({ item }) => item.id));

  for (const key of Object.keys(next)) {
    if (!leafIds.has(key)) {
      delete next[key];
    }
  }

  for (const { item } of leaves) {
    const existing = next[item.id];
    const content = existing?.content || item.content || '';
    const existingStatus = existing?.status === 'running' ? undefined : existing?.status;
    next[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: existingStatus || (content.trim() ? 'success' : 'idle'),
      content,
      error: existing?.error,
      updated_at: existing?.updated_at,
    };
  }

  return next;
}

function progressFor(leaves, sections) {
  if (!leaves.length) {
    return 0;
  }

  const done = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id]?.status)).length;
  return Math.round((done / leaves.length) * 100);
}

function taskStatusFor(leaves, sections) {
  if (leaves.some(({ item }) => sections[item.id]?.status === 'error')) {
    return 'error';
  }

  return 'success';
}

function now() {
  return new Date().toISOString();
}

function withSection(sections, item, partial) {
  return {
    ...(sections || {}),
    [item.id]: {
      id: item.id,
      title: item.title || '未命名章节',
      status: 'idle',
      content: '',
      ...(sections || {})[item.id],
      ...partial,
      updated_at: now(),
    },
  };
}

async function runContentGenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  let outlineData = payload.outlineData || storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const projectOverview = payload.projectOverview || outlineData.project_overview || storedPlan.projectOverview || '';
  const regenerate = Boolean(payload.regenerate);
  const targetItemId = String(payload.targetItemId || '').trim();
  const fullRegenerate = regenerate && !targetItemId;
  if (fullRegenerate) {
    outlineData = { ...outlineData, outline: clearOutlineContent(outlineData.outline) };
  }

  const leaves = collectLeafContexts(outlineData.outline);
  if (!leaves.length) {
    throw new Error('当前目录没有可生成正文的小节');
  }
  const regenerateRequirement = String(payload.requirement || '').trim();
  const concurrency = Math.max(1, Math.min(Number(payload.concurrency) || 5, 8));
  const generationOptions = payload.generationOptions || payload.generation_options || {};
  const realTimeRender = payload.real_time_render !== false && payload.realTimeRender !== false;
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  const maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(payload, storedPlan);
  const imageAvailability = aiService.getImageModelAvailability
    ? aiService.getImageModelAvailability()
    : { available: false, message: '生图模型不可用' };
  const aiImagesEnabled = Boolean(generationOptions.useAiImages ?? generationOptions.use_ai_images ?? imageAvailability.available) && imageAvailability.available;
  const mermaidImagesEnabled = Boolean(generationOptions.useMermaidImages ?? generationOptions.use_mermaid_images ?? Boolean(targetItemId));
  const requestedMaxImages = Number(generationOptions.maxAiImages ?? generationOptions.max_ai_images);
  const maxAiImages = aiImagesEnabled
    ? Math.max(0, Math.min(Number.isFinite(requestedMaxImages) ? Math.round(requestedMaxImages) : 6, targetItemId ? 1 : leaves.length))
    : 0;
  const imageStats = { ai: createImageStat(), mermaid: createImageStat() };
  const contentStats = {
    phase: 'planning',
    planning_total: 0,
    planning_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    illustration_total: 0,
    illustration_completed: 0,
  };
  const contentPlans = new Map();
  let storedContentPlans = pruneContentGenerationPlans(fullRegenerate ? {} : storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems = [];
  let allowedKnowledgeItemIds = new Set();
  let knowledgeContentMap = new Map();
  let selectedAiImageIds = new Set();
  let aiImageTargets = [];
  let mermaidImageTargets = [];
  let sections = createInitialSections(leaves, fullRegenerate ? {} : storedPlan.contentGenerationSections);
  let tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    return regenerate || section?.status === 'error' || !String(content).trim();
  });
  if (targetItemId) {
    tasksToRun = leaves.filter(({ item }) => item.id === targetItemId);
    if (!tasksToRun.length) {
      throw new Error('未找到要重新生成的正文小节');
    }
  }
  const taskItemIds = new Set(tasksToRun.map(({ item }) => item.id));
  const retainedTableCount = maxTables === null ? 0 : countRetainedTablePlans(storedContentPlans, taskItemIds);
  const maxTablesForRun = maxTables === null ? null : Math.max(0, maxTables - retainedTableCount);
  let logs = [`准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  }
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${maxTablesForRun} 个。`];
  logs = [...logs, aiImagesEnabled
    ? `AI 生图已启用，将在整体编排后择优生成，最多 ${maxAiImages} 张。`
    : 'AI 生图未启用或不可用，本次不会调用生图接口。'];
  logs = [...logs, mermaidImagesEnabled
    ? 'Mermaid 图片已启用，适合简单图示的小节会优先使用 Mermaid 图。'
    : 'Mermaid 图片未启用。'];
  if (!realTimeRender) {
    logs = [...logs, '实时渲染已关闭，每个小节生成完成后再刷新正文。'];
  }
  knowledgeItems = loadContentKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });
  allowedKnowledgeItemIds = new Set(knowledgeItems.map((item) => item.id));
  knowledgeContentMap = loadContentKnowledgeContentMap(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });

  function statsSnapshot() {
    contentStats.generation_completed = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id]?.status)).length;
    return { images: { total: sumImageStats(imageStats.ai, imageStats.mermaid), ai: { ...imageStats.ai }, mermaid: { ...imageStats.mermaid } }, content: { ...contentStats } };
  }

  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    referenceKnowledgeDocumentIds,
    contentGenerationTask: updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }),
  });
  updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan);

  if (!tasksToRun.length) {
    logs = [...logs, '正文已全部生成，无需重复生成。'];
    technicalPlan = workspaceStore.updateTechnicalPlan({
      contentGenerationTask: updateTask({ status: 'success', progress: 100, logs, stats: statsSnapshot() }),
    });
    updateTask({ status: 'success', progress: 100, logs, stats: statsSnapshot() }, technicalPlan);
    return;
  }

  function saveSection(item, partial, contentForOutline, taskPartial = {}) {
    const prev = workspaceStore.loadTechnicalPlan() || {};
    sections = withSection(prev.contentGenerationSections || sections, item, partial);
    const currentOutlineData = prev.outlineData || outlineData;
    const outlineContent = contentForOutline ?? (sections[item.id].content || '');
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    const saved = workspaceStore.updateTechnicalPlan({
      contentGenerationSections: sections,
      outlineData: nextOutlineData,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, saved);
    return saved;
  }

  function illustrationTypeForSinglePlan(contentPlan) {
    if (contentPlan.image.needed) {
      return 'ai';
    }
    if (contentPlan.mermaid.needed) {
      return 'mermaid';
    }
    return 'none';
  }

  function applyIllustrationTargets(targets, getIllustrationType) {
    selectedAiImageIds = new Set();
    aiImageTargets = [];
    mermaidImageTargets = [];

    for (const context of targets) {
      const illustrationType = normalizeIllustrationType(getIllustrationType(context));
      if (illustrationType === 'ai') {
        selectedAiImageIds.add(context.item.id);
        aiImageTargets.push(context);
      } else if (illustrationType === 'mermaid') {
        mermaidImageTargets.push(context);
      }
    }

    imageStats.ai.planned = aiImageTargets.length;
    imageStats.mermaid.planned = mermaidImageTargets.length;
  }

  function persistContentPlans(targets, getIllustrationType) {
    const nextPlans = { ...storedContentPlans };
    for (const context of targets) {
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({});
      nextPlans[context.item.id] = createStoredContentPlan(contentPlan, getIllustrationType(context));
    }
    storedContentPlans = pruneContentGenerationPlans(nextPlans, leaves);
    const saved = workspaceStore.updateTechnicalPlan({ contentGenerationPlans: storedContentPlans });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved);
    return saved;
  }

  async function planOne(context) {
    const { item, parentChapters, siblingChapters } = context;
    let contentPlan;

    try {
      contentPlan = await aiService.collectJsonResponse({
        messages: buildChapterContentPlanMessages({
          chapter: item,
          parentChapters,
          siblingChapters,
          projectOverview,
          regenerateRequirement,
          tableRequirement,
          maxTables,
          tableTotalSections: leaves.length,
          imageGenerationAvailable: aiImagesEnabled && maxAiImages > 0,
          mermaidGenerationAvailable: mermaidImagesEnabled,
          maxAiImages,
          totalSections: tasksToRun.length,
          knowledgeItems,
        }),
        temperature: 0.2,
        progressLabel: '正文编排决策',
        failureMessage: '模型返回的正文编排决策格式无效',
        normalizer: (value) => normalizeContentPlan(value, allowedKnowledgeItemIds),
        validator: validateContentPlan,
      });
    } catch (error) {
      contentPlan = normalizeContentPlan({}, allowedKnowledgeItemIds);
      logs = [...logs, `编排失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}，将按纯正文生成。`];
    }

    if (tableRequirement === 'none') {
      contentPlan = clearContentPlanTable(contentPlan);
    }

    contentPlans.set(item.id, contentPlan);
    contentStats.planning_completed += 1;
    logs = [...logs, `编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，表格：${contentPlan.table.needed ? '需要' : '不需要'}，Mermaid：${contentPlan.mermaid.needed ? '需要' : '不需要'}，AI 图：${contentPlan.image.needed ? '需要' : '不需要'}）`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function planAll() {
    contentStats.phase = 'planning';
    contentStats.planning_total = tasksToRun.length;
    contentStats.planning_completed = 0;
    contentStats.generation_total = tasksToRun.length;
    logs = [...logs, `开始整体编排决策，共 ${tasksToRun.length} 个小节。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    await runWithConcurrency(tasksToRun, concurrency, planOne);

    const tableCandidates = tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.table.needed);
    const selectedTableIds = maxTablesForRun === null
      ? new Set(tableCandidates.map(({ item }) => item.id))
      : pickDistributedTableTargets(tableCandidates, maxTablesForRun);
    if (maxTablesForRun !== null) {
      for (const { item } of tableCandidates) {
        if (!selectedTableIds.has(item.id)) {
          contentPlans.set(item.id, clearContentPlanTable(contentPlans.get(item.id)));
        }
      }
    }

    const mermaidCandidates = tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.mermaid.needed);
    const aiImageCandidates = tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.image.needed);
    selectedAiImageIds = pickDistributedImageTargets(
      aiImageCandidates.map((context) => ({ ...context, plan: contentPlans.get(context.item.id) })),
      maxAiImages,
    );
    aiImageTargets = tasksToRun.filter(({ item }) => selectedAiImageIds.has(item.id));
    mermaidImageTargets = mermaidCandidates.filter(({ item }) => !selectedAiImageIds.has(item.id));
    imageStats.mermaid.planned = mermaidImageTargets.length;
    imageStats.mermaid.skipped += Math.max(0, mermaidCandidates.length - mermaidImageTargets.length);
    imageStats.ai.planned = selectedAiImageIds.size;
    imageStats.ai.skipped += Math.max(0, aiImageCandidates.length - selectedAiImageIds.size);

    logs = [...logs, `整体编排完成：表格候选 ${tableCandidates.length} 个，${maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}；AI 生图候选 ${aiImageCandidates.length} 张，入选 ${selectedAiImageIds.size} 张；Mermaid 候选 ${mermaidCandidates.length} 张，执行 ${mermaidImageTargets.length} 张。`];
    const mermaidImageIds = new Set(mermaidImageTargets.map(({ item }) => item.id));
    persistContentPlans(tasksToRun, ({ item }) => {
      if (selectedAiImageIds.has(item.id)) {
        return 'ai';
      }
      if (mermaidImageIds.has(item.id)) {
        return 'mermaid';
      }
      return 'none';
    });
    contentStats.phase = 'generating';
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function prepareSingleSectionPlan() {
    const context = tasksToRun[0];
    const storedContentPlan = normalizeStoredContentPlan(storedContentPlans[context.item.id]);
    contentStats.phase = 'planning';
    contentStats.planning_total = 1;
    contentStats.planning_completed = 0;
    contentStats.generation_total = 1;

    if (storedContentPlan) {
      contentPlans.set(context.item.id, storedContentPlan.plan);
      contentStats.planning_completed = 1;
      logs = [...logs, `复用历史编排：${context.item.id} ${context.item.title || '未命名章节'}（配图：${storedContentPlan.illustration_type}）。`];
      applyIllustrationTargets([context], () => storedContentPlan.illustration_type);
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    } else {
      logs = [...logs, `未找到历史编排结果，将仅重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      await planOne(context);
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({});
      const illustrationType = illustrationTypeForSinglePlan(contentPlan);
      applyIllustrationTargets([context], () => illustrationType);
      persistContentPlans([context], () => illustrationType);
      logs = [...logs, `当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}（配图：${illustrationType}）。`];
    }

    contentStats.phase = 'generating';
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function runOne(context) {
    const { item, parentChapters, siblingChapters } = context;
    const previousSection = sections[item.id] || {};
    const previousContent = previousSection.content || item.content || '';
    const isSingleSectionRegeneration = Boolean(targetItemId);
    let rawContent = regenerate ? '' : previousContent;
    let content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
    logs = [...logs, `开始生成：${item.id} ${item.title || '未命名章节'}`];
    saveSection(item, {
      status: 'running',
      content: isSingleSectionRegeneration ? previousContent : content,
      error: undefined,
    }, isSingleSectionRegeneration ? previousContent : content, { logs });

    try {
      const contentPlan = contentPlans.get(item.id) || normalizeContentPlan({});
      const knowledgeContents = resolveKnowledgeContents(contentPlan.knowledge?.item_ids, knowledgeContentMap);

      await aiService.streamChat({
        messages: buildChapterContentMessages({ chapter: item, parentChapters, siblingChapters, projectOverview, regenerateRequirement, contentPlan, knowledgeContents }),
        temperature: 0.7,
      }, (event) => {
        if (event.type !== 'chunk' || !event.chunk) {
          return;
        }
        rawContent += event.chunk;
        content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
        if (realTimeRender && !isSingleSectionRegeneration) {
          saveSection(item, { status: 'running', content, error: undefined }, content);
        }
      });

      content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
      logs = [...logs, `生成完成：${item.id} ${item.title || '未命名章节'}`];
      saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
    } catch (error) {
      const message = error.message || '正文生成失败';
      logs = [...logs, `生成失败：${item.id} ${item.title || '未命名章节'}，${message}${isSingleSectionRegeneration ? '。已保留原正文。' : ''}`];
      saveSection(item, {
        status: 'error',
        content: isSingleSectionRegeneration ? previousContent : content,
        error: message,
      }, isSingleSectionRegeneration ? previousContent : content, { logs });
    }
  }

  function getCurrentSuccessfulContent(item) {
    const currentPlan = workspaceStore.loadTechnicalPlan() || {};
    const currentSections = currentPlan.contentGenerationSections || sections;
    const section = currentSections[item.id] || {};
    return section.status === 'success' ? String(section.content || '') : '';
  }

  async function runAiIllustration(context) {
    const { item } = context;
    const contentPlan = contentPlans.get(item.id) || normalizeContentPlan({});
    const baseContent = getCurrentSuccessfulContent(item);

    if (!baseContent.trim()) {
      imageStats.ai.skipped += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, `跳过 AI 配图：${item.id} ${item.title || '未命名章节'}，正文未成功生成。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return;
    }

    imageStats.ai.attempted += 1;
    logs = [...logs, `开始 AI 配图：${item.id} ${contentPlan.image.title}`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    try {
      const generatedImage = await aiService.generateImage({
        title: contentPlan.image.title,
        prompt: contentPlan.image.prompt,
        style: contentPlan.image.style,
      });
      const content = appendGeneratedImageMarkdown(baseContent, contentPlan.image, generatedImage);
      imageStats.ai.success += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, `AI 配图完成：${item.id} ${contentPlan.image.title}`];
      saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
    } catch (imageError) {
      imageStats.ai.failed += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, `AI 配图失败：${item.id} ${contentPlan.image.title}，${imageError.message || '生图失败'}，已保留正文。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }
  }

  async function runMermaidIllustration(context) {
    const { item } = context;
    const contentPlan = contentPlans.get(item.id) || normalizeContentPlan({});
    const baseContent = getCurrentSuccessfulContent(item);

    if (!baseContent.trim()) {
      imageStats.mermaid.skipped += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, `跳过 Mermaid 配图：${item.id} ${item.title || '未命名章节'}，正文未成功生成。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return;
    }

    imageStats.mermaid.attempted += 1;
    logs = [...logs, `开始校验 Mermaid 配图：${item.id} ${contentPlan.mermaid.title}`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    const mermaidResult = await prepareRenderableMermaidPlan({
      aiService,
      context,
      projectOverview,
      regenerateRequirement,
      mermaidPlan: contentPlan.mermaid,
    });
    if (mermaidResult.ok) {
      const content = appendMermaidImageMarkdown(baseContent, mermaidResult.plan);
      imageStats.mermaid.success += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, mermaidResult.attempts > 0
        ? `Mermaid 配图已修复并完成：${item.id} ${mermaidResult.plan.title}（修复 ${mermaidResult.attempts} 轮）`
        : `Mermaid 配图完成：${item.id} ${mermaidResult.plan.title}`];
      saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
    } else {
      imageStats.mermaid.failed += 1;
      contentStats.illustration_completed += 1;
      logs = [...logs, `Mermaid 配图取消：${item.id} ${contentPlan.mermaid.title}，连续修复 ${MERMAID_REPAIR_ATTEMPTS} 轮失败，${mermaidResult.error || '渲染失败'}，已保留正文。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }
  }

  async function runIllustrations() {
    const illustrationTotal = aiImageTargets.length + mermaidImageTargets.length;
    contentStats.phase = 'illustrating';
    contentStats.illustration_total = illustrationTotal;
    contentStats.illustration_completed = 0;
    logs = [...logs, illustrationTotal
      ? `开始配图：AI 生图 ${aiImageTargets.length} 张（并发 ${AI_IMAGE_CONCURRENCY}），Mermaid 图 ${mermaidImageTargets.length} 张（并发 ${MERMAID_IMAGE_CONCURRENCY}）。`
      : '本次没有需要执行的配图。'];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    if (!illustrationTotal) {
      return;
    }

    await Promise.all([
      runWithConcurrency(aiImageTargets, AI_IMAGE_CONCURRENCY, runAiIllustration),
      runWithConcurrency(mermaidImageTargets, MERMAID_IMAGE_CONCURRENCY, runMermaidIllustration),
    ]);

    logs = [...logs, '配图阶段完成。'];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  if (targetItemId) {
    await prepareSingleSectionPlan();
  } else {
    await planAll();
  }

  await runWithConcurrency(tasksToRun, concurrency, runOne);

  await runIllustrations();

  const failedCount = leaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
  const finalProgress = progressFor(leaves, sections);
  const finalStatus = taskStatusFor(leaves, sections);
  contentStats.phase = 'done';
  logs = [...logs, targetItemId
    ? (failedCount ? `小节重新生成结束，当前整体进度 ${finalProgress}%，${failedCount} 个小节失败。` : `小节重新生成完成，当前整体进度 ${finalProgress}%。`)
    : (failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。')];
  technicalPlan = workspaceStore.updateTechnicalPlan({
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    contentGenerationTask: updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot() }),
  });
  updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot() }, technicalPlan);
}

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle };
