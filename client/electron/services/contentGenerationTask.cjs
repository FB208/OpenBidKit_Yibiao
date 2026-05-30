const zlib = require('node:zlib');
const { countReadableWords } = require('../utils/wordCount.cjs');

const IMAGE_STYLES = new Set(['engineering_diagram', 'realistic_photo']);
const DEFAULT_CONTENT_CONCURRENCY = 5;
const MERMAID_REPAIR_ATTEMPTS = 3;
const MERMAID_RENDER_TIMEOUT_MS = 15000;
const AI_IMAGE_CONCURRENCY = 2;
const MERMAID_IMAGE_CONCURRENCY = 5;
const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';
const MAX_OUTLINE_EXPANSION_ROUNDS = 3;
const OUTLINE_EXPANSION_TARGET_RATIO = 0.8;
const MIN_SECTION_EXPANSION_INCREMENT = 800;
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

function normalizeMinimumWords(value) {
  const words = Number(value);
  return Math.max(0, Number.isFinite(words) ? Math.round(words) : 0);
}

function normalizeContentConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_CONTENT_CONCURRENCY);
}

function isDeveloperModeEnabled(aiService) {
  try {
    return Boolean(aiService?.isDeveloperMode?.());
  } catch {
    return false;
  }
}

function countContentWords(content) {
  return countReadableWords(String(content || ''));
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

function formatOutlineForPrompt(items, level = 1, lines = []) {
  for (const item of items || []) {
    const indent = '  '.repeat(Math.max(0, level - 1));
    lines.push(`${indent}- ${item.id || 'unknown'} ${item.title || '未命名章节'}：${item.description || ''}`);
    if (item.children?.length) {
      formatOutlineForPrompt(item.children, level + 1, lines);
    }
  }
  return lines.join('\n');
}

function createOutlineNodeMap(items) {
  const map = new Map();
  function visit(nodes, level = 1, parent = null) {
    for (const item of nodes || []) {
      const id = String(item?.id || '').trim();
      if (id) {
        map.set(id, { item, level, parent });
      }
      if (item?.children?.length) {
        visit(item.children, level + 1, item);
      }
    }
  }
  visit(items || []);
  return map;
}

function formatOutlineExpansionParents(nodeMap) {
  return Array.from(nodeMap.entries())
    .filter(([, info]) => info.level >= 1 && info.level <= 3)
    .map(([id, info]) => {
      const childLevel = info.level + 1;
      return `- ${id} ${info.item.title || '未命名章节'}（当前 ${info.level} 级，可新增 ${childLevel} 级目录）`;
    })
    .join('\n');
}

function buildOutlineExpansionMessages({ projectOverview, techRequirements, outlineData, currentWords, minimumWords, medianLeafWords, round, nodeMap }) {
  const sampleParentId = Array.from(nodeMap.entries()).find(([, info]) => info.level === 1)?.[0] || '1';
  return [
    {
      role: 'user',
      content: `你是投标技术方案目录补充专家。当前技术方案正文字数不足，需要通过补充二级、三级或四级目录扩展可生成正文的空间。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只能新增二级、三级、四级目录，严禁新增、删除、重命名或调整一级目录。
3. 只能把新增目录挂到下面给出的允许 parent_id 下，parent_id 必须逐字复制。
4. 只输出新增目录，不要输出完整目录，不要输出正文内容。
5. 允许补充通用但不违背项目的技术方案内容，例如组织管理、质量控制、安全管理、进度保障、验收交付、运维服务、培训计划、资料管理、风险控制、应急响应等。
6. 不要重复已有目录，不要输出明显凑字数的空泛标题。
7. 四级目录不能再包含 children。

返回格式：
{
  "additions": [
    {
      "parent_id": "${sampleParentId}",
      "title": "新增目录标题",
      "description": "新增目录说明",
      "children": [
        { "title": "可选下级目录标题", "description": "可选下级目录说明" }
      ]
    }
  ]
}`,
    },
    { role: 'user', content: `项目概述：\n${projectOverview || '未提供'}` },
    { role: 'user', content: `技术评分要求：\n${techRequirements || '未提供'}` },
    { role: 'user', content: `当前完整目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `允许新增目录的 parent_id：\n${formatOutlineExpansionParents(nodeMap)}` },
    { role: 'user', content: `当前总字数：${currentWords}\n预期最低字数：${minimumWords}\n当前叶子节点字数中位数：${medianLeafWords}\n本次补目录轮次：${round}/${MAX_OUTLINE_EXPANSION_ROUNDS}\n请只返回新增目录 JSON。` },
  ];
}

const OUTLINE_EXPANSION_TOP_LEVEL_KEYS = new Set(['additions']);
const OUTLINE_EXPANSION_ADDITION_KEYS = new Set(['parent_id', 'parentId', 'title', 'name', 'description', 'summary', 'resume', 'children']);
const OUTLINE_EXPANSION_CHILD_KEYS = new Set(['title', 'name', 'description', 'summary', 'resume', 'children']);
const OUTLINE_EXPANSION_FORBIDDEN_KEY_NAMES = new Set([
  'id',
  'outline',
  'content',
  'markdown',
  'body',
  'image',
  'images',
  'picture',
  'pictures',
  'table',
  'tables',
  'plan',
  'plans',
  'contentplan',
  'contentplans',
  'contentgenerationplans',
  'contentgenerationsections',
  'illustration',
  'illustrationtype',
  'mermaid',
]);

function normalizeFieldName(value) {
  return String(value || '').replace(/[_\-\s]/g, '').toLowerCase();
}

function collectUnexpectedOutlineExpansionKeys(value, path, allowedKeys, issues) {
  for (const key of Object.keys(value || {})) {
    if (allowedKeys.has(key)) {
      continue;
    }
    const normalizedKey = normalizeFieldName(key);
    if (OUTLINE_EXPANSION_FORBIDDEN_KEY_NAMES.has(normalizedKey)) {
      issues.push(`${path}.${key} 不允许返回完整目录、正文、图片、表格或编排计划字段`);
    } else {
      issues.push(`${path}.${key} 不是允许的新增目录字段`);
    }
  }
}

function normalizeOutlineExpansionChild(value, level, path, issues, allowedKeys = OUTLINE_EXPANSION_CHILD_KEYS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  collectUnexpectedOutlineExpansionKeys(value, path, allowedKeys, issues);
  const title = singleLine(value.title || value.name);
  if (!title) {
    issues.push(`${path}.title 缺失`);
    return null;
  }
  const description = String(value.description || value.summary || value.resume || title).trim() || title;
  const node = { title, description };
  if (level < 4 && Array.isArray(value.children) && value.children.length) {
    const children = [];
    value.children.forEach((child, index) => {
      const normalized = normalizeOutlineExpansionChild(child, level + 1, `${path}.children[${index}]`, issues);
      if (normalized) children.push(normalized);
    });
    if (children.length) node.children = children;
  }
  if (level >= 4 && Array.isArray(value.children) && value.children.length) {
    issues.push(`${path}.children 四级目录不能包含下级目录`);
  }
  return node;
}

function normalizeOutlineExpansionResponse(payload, context) {
  const raw = payload?.result && typeof payload.result === 'object' ? payload.result : payload || {};
  const issues = [];
  const additions = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('补目录返回格式无效：顶层必须是只包含 additions 数组的对象');
  }

  collectUnexpectedOutlineExpansionKeys(raw, 'root', OUTLINE_EXPANSION_TOP_LEVEL_KEYS, issues);

  if (raw.additions === undefined) {
    issues.push('root.additions 缺失');
  } else if (!Array.isArray(raw.additions)) {
    issues.push('root.additions 必须是数组');
  }

  const candidates = Array.isArray(raw.additions) ? raw.additions : [];

  candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(`additions[${index}] 必须是对象`);
      return;
    }
    const parentId = String(candidate.parent_id || candidate.parentId || '').trim();
    const parentInfo = context.nodeMap.get(parentId);
    if (!parentId || !parentInfo || parentInfo.level < 1 || parentInfo.level > 3) {
      issues.push(`additions[${index}].parent_id 无效：${parentId || '空'}`);
      return;
    }
    const child = normalizeOutlineExpansionChild(candidate, parentInfo.level + 1, `additions[${index}]`, issues, OUTLINE_EXPANSION_ADDITION_KEYS);
    if (child) {
      additions.push({ parent_id: parentId, ...child });
    }
  });

  if (issues.length) {
    throw new Error(`补目录返回格式无效：${issues.join('；')}`);
  }

  return { additions };
}

function validateOutlineExpansionResponse(payload) {
  if (!payload || !Array.isArray(payload.additions)) {
    throw new Error('补目录结果缺少 additions 数组');
  }
}

function buildOutlineExpansionRepairMessages({ invalidContent, issues }, nodeMap) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“最低字数补目录”JSON。

必须满足：
1. 顶层只能有 additions 数组。
2. 每条 additions 必须包含 parent_id、title、description，可以包含 children。
3. parent_id 必须逐字复制允许列表中的 ID。
4. 只能新增二级、三级、四级目录；四级目录不能包含 children。
5. 禁止输出完整 outline、正文、图片、表格或解释文字。
6. 如果没有可补充目录，返回 {"additions":[]}。

允许的 parent_id：
${formatOutlineExpansionParents(nodeMap)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildContentExpansionMessages({ outlineData, context, projectOverview, currentContent, currentWords, targetWords }) {
  const { item, parentChapters, siblingChapters } = context;
  const chapterPath = [...(parentChapters || []), item]
    .map((chapter) => `${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}`)
    .join(' > ');
  const siblingLines = (siblingChapters || [])
    .filter((chapter) => chapter.id !== item.id)
    .map((chapter) => `- ${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}：${chapter.description || ''}`)
    .join('\n');

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文扩写助手。请只针对指定章节进行扩写，避免与其他章节重复。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回一次局部扩写操作。
3. operation 只能是 "insert" 或 "replace"。
4. insert 表示新增一个或多个段落，anchor 填写建议插入在哪个原段落之后；如果适合放末尾，anchor 写 "end"。
5. replace 表示重写并扩写某个原段落，anchor 必须填写要替换的原段落关键摘录。
6. content 只写新增或替换后的正文片段，不要包含章节标题。
7. 禁止输出图片 Markdown、Mermaid、代码块或其他图表代码。
8. 扩写内容必须服务当前章节，不要写其他目录应承载的内容。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "content": "扩写后的新增段落或替换段落"
}`,
    },
    { role: 'user', content: `项目概述：\n${projectOverview || '未提供'}` },
    { role: 'user', content: `完整目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `当前章节路径：${chapterPath}\n当前章节描述：${item.description || ''}` },
    { role: 'user', content: `同级章节（扩写时避免重复）：\n${siblingLines || '无'}` },
    { role: 'user', content: `当前章节原正文：\n${currentContent}` },
    { role: 'user', content: `当前章节统计字数：${currentWords}\n期望本章节扩写后至少达到：${targetWords}\n请返回一次局部扩写 JSON。` },
  ];
}

function normalizeContentExpansionPatch(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatch = Array.isArray(source.operations) ? source.operations[0] : Array.isArray(source.patches) ? source.patches[0] : source;
  const operation = String(rawPatch.operation || rawPatch.type || '').trim().toLowerCase();
  const anchor = singleLine(rawPatch.anchor || rawPatch.position || rawPatch.after || rawPatch.target || rawPatch.replace_target || 'end') || 'end';
  const content = normalizeGeneratedMarkdown(String(rawPatch.content || rawPatch.paragraph || rawPatch.text || rawPatch.new_content || ''))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  return { operation, anchor, content };
}

function validateContentExpansionPatch(patch) {
  if (!patch || !['insert', 'replace'].includes(patch.operation)) {
    throw new Error(`扩写结果 operation 无效：${patch?.operation || '空'}，只能是 insert 或 replace`);
  }
  if (!String(patch.content || '').trim()) {
    throw new Error('扩写结果缺少 content');
  }
}

function buildContentExpansionRepairMessages({ invalidContent, issues }) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“正文局部扩写”JSON。

必须满足：
1. 顶层只能包含 operation、anchor、content。
2. operation 只能是 "insert" 或 "replace"。
3. 严禁使用 delete、rewrite_full、rewrite、append、update 或其他 operation。
4. insert 表示新增段落；anchor 写建议插入在哪个原段落之后，无法确定时写 "end"。
5. replace 表示重写并扩写一个原段落；anchor 必须是要替换的原段落关键摘录。
6. content 只能是新增或替换后的正文片段，不要返回完整章节正文。
7. content 不得包含章节标题、图片 Markdown、Mermaid、代码块或解释文字。
8. 只返回 JSON，不要输出 Markdown 代码围栏或解释。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
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

function cloneOutlineItems(items) {
  return (items || []).map((item) => ({
    ...item,
    ...(item.knowledge_item_ids?.length ? { knowledge_item_ids: [...item.knowledge_item_ids] } : {}),
    ...(item.children?.length ? { children: cloneOutlineItems(item.children) } : {}),
  }));
}

function outlineDepth(items) {
  return items?.length ? 1 + Math.max(...items.map((item) => outlineDepth(item.children || []))) : 0;
}

function flattenOutlineRows(items, level = 1, parent = null, rows = []) {
  (items || []).forEach((item, index) => {
    const id = String(item?.id || '').trim();
    const row = {
      item,
      id,
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      level,
      parent,
      path: parent ? `${parent.path}.children[${index}]` : `outline[${index}]`,
    };
    rows.push(row);
    flattenOutlineRows(normalizeChildren(item), level + 1, row, rows);
  });
  return rows;
}

function validateOutlineTree(rows) {
  const issues = [];
  const seenIds = new Set();

  for (const row of rows) {
    const children = normalizeChildren(row.item);
    if (!row.id) {
      issues.push(`${row.path}.id 缺失`);
    } else if (seenIds.has(row.id)) {
      issues.push(`${row.path}.id 重复：${row.id}`);
    } else {
      seenIds.add(row.id);
    }
    if (!row.title) {
      issues.push(`${row.path}.title 缺失`);
    }
    if (!row.description) {
      issues.push(`${row.path}.description 缺失`);
    }
    if (row.level > 4) {
      issues.push(`${row.path} 目录层级不能超过四级`);
    }
    if (row.parent?.id && row.id && !row.id.startsWith(`${row.parent.id}.`)) {
      issues.push(`${row.path}.id 必须挂在父级 ${row.parent.id} 下`);
    }
    if (children.length && Object.prototype.hasOwnProperty.call(row.item || {}, 'content') && String(row.item.content || '').trim()) {
      issues.push(`${row.path} 是非叶子节点，不能保留正文 content`);
    }
  }

  return issues;
}

function validateOutlineExpansionApplied(beforeItems, afterItems) {
  if (!(afterItems || []).length) {
    throw new Error('补目录后完整目录不能为空');
  }
  if (outlineDepth(afterItems) > 4) {
    throw new Error('补目录后目录层级不能超过四级');
  }
  if ((beforeItems || []).length !== (afterItems || []).length) {
    throw new Error('补目录不允许改变一级目录数量');
  }

  const beforeRows = flattenOutlineRows(beforeItems || []);
  const afterRows = flattenOutlineRows(afterItems || []);
  const beforeById = new Map(beforeRows.filter((row) => row.id).map((row) => [row.id, row]));
  const afterById = new Map(afterRows.filter((row) => row.id).map((row) => [row.id, row]));
  const treeIssues = validateOutlineTree(afterRows);
  if (treeIssues.length) {
    throw new Error(`补目录后完整目录结构无效：${treeIssues.join('；')}`);
  }

  (beforeItems || []).forEach((beforeItem, index) => {
    const afterItem = afterItems[index];
    if (String(beforeItem.id || '').trim() !== String(afterItem?.id || '').trim()) {
      throw new Error('补目录不允许修改一级目录 ID 或顺序');
    }
    if (String(beforeItem.title || '').trim() !== String(afterItem?.title || '').trim()) {
      throw new Error('补目录不允许修改一级目录标题');
    }
  });

  for (const beforeRow of beforeRows) {
    const afterRow = beforeRow.id ? afterById.get(beforeRow.id) : null;
    if (!afterRow) {
      throw new Error(`补目录不允许删除既有目录节点：${beforeRow.id || beforeRow.path}`);
    }
    if (beforeRow.level !== afterRow.level) {
      throw new Error(`补目录不允许改变既有目录层级：${beforeRow.id}`);
    }
    if (beforeRow.title !== afterRow.title) {
      throw new Error(`补目录不允许修改既有目录标题：${beforeRow.id}`);
    }
    if (beforeRow.description !== afterRow.description) {
      throw new Error(`补目录不允许修改既有目录说明：${beforeRow.id}`);
    }
  }

  for (const afterRow of afterRows) {
    if (!beforeById.has(afterRow.id) && (afterRow.level < 2 || afterRow.level > 4)) {
      throw new Error(`新增目录只能出现在二级、三级、四级：${afterRow.id}`);
    }
  }
}

function nextChildId(parent, existingIds) {
  const prefix = `${parent.id}.`;
  const childIndexes = normalizeChildren(parent)
    .map((child) => String(child.id || ''))
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length).split('.')[0]))
    .filter((value) => Number.isFinite(value));
  let nextIndex = childIndexes.length ? Math.max(...childIndexes) + 1 : 1;
  let id = `${prefix}${nextIndex}`;
  while (existingIds.has(id)) {
    nextIndex += 1;
    id = `${prefix}${nextIndex}`;
  }
  existingIds.add(id);
  return id;
}

function createOutlineItemFromExpansion(addition, parent, existingIds, invalidatedItemIds) {
  const item = {
    id: nextChildId(parent, existingIds),
    title: addition.title,
    description: addition.description || addition.title,
  };
  const children = Array.isArray(addition.children) ? addition.children : [];
  if (children.length) {
    item.children = [];
    for (const child of children) {
      item.children.push(createOutlineItemFromExpansion(child, item, existingIds, invalidatedItemIds));
    }
  }
  return item;
}

function applyOutlineExpansionAdditions(outlineItems, patch) {
  const beforeOutline = outlineItems || [];
  const outline = cloneOutlineItems(beforeOutline);
  const nodeMap = createOutlineNodeMap(outline);
  const existingIds = new Set(Array.from(nodeMap.keys()));
  const invalidatedItemIds = new Set();
  let addedCount = 0;

  for (const addition of patch.additions || []) {
    const parent = nodeMap.get(addition.parent_id);
    if (!parent || parent.level < 1 || parent.level > 3) {
      continue;
    }
    if (!parent.item.children?.length) {
      invalidatedItemIds.add(parent.item.id);
    }
    const nextItem = createOutlineItemFromExpansion(addition, parent.item, existingIds, invalidatedItemIds);
    parent.item.children = [...(parent.item.children || []), nextItem];
    delete parent.item.content;
    function register(node, level) {
      nodeMap.set(node.id, { item: node, level, parent: parent.item });
      addedCount += 1;
      if (node.children?.length) node.children.forEach((child) => register(child, level + 1));
    }
    register(nextItem, parent.level + 1);
  }

  validateOutlineExpansionApplied(beforeOutline, outline);
  return { outline, invalidatedItemIds, addedCount };
}

function normalizeParagraphs(content) {
  return String(content || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function applyContentExpansionPatch(content, patch) {
  const normalizedContent = String(content || '').trim();
  const patchContent = normalizeGeneratedMarkdown(patch.content).trim();
  if (!normalizedContent) {
    return patchContent;
  }

  const paragraphs = normalizeParagraphs(normalizedContent);
  const anchor = String(patch.anchor || '').trim();
  const anchorKey = anchor.replace(/\s+/g, ' ').trim();
  const anchorIndex = anchorKey && !/^end$/i.test(anchorKey)
    ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/g, ' ').includes(anchorKey) || anchorKey.includes(paragraph.replace(/\s+/g, ' ')))
    : -1;

  if (patch.operation === 'replace' && anchorIndex >= 0) {
    const next = [...paragraphs];
    next[anchorIndex] = patchContent;
    return next.join('\n\n');
  }

  if (/^start$/i.test(anchorKey)) {
    return [patchContent, ...paragraphs].join('\n\n');
  }

  if (anchorIndex >= 0) {
    const next = [...paragraphs];
    next.splice(anchorIndex + 1, 0, patchContent);
    return next.join('\n\n');
  }

  return `${normalizedContent}\n\n${patchContent}`;
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

function hasExistingIllustration(content, illustrationType) {
  const text = String(content || '');
  if (!text.trim()) {
    return false;
  }

  const hasMarkdownImage = /!\[[^\]]*\]\([^)]*\)/.test(text) || /<img\b[^>]*>/i.test(text);
  const hasMermaidBlock = /```\s*mermaid[\s\S]*?```/i.test(text);

  if (illustrationType === 'ai' || illustrationType === 'mermaid') {
    return hasMarkdownImage || hasMermaidBlock;
  }
  return false;
}

function stripIllustrationsForExpansion(content) {
  return String(content || '')
    .replace(/```\s*mermaid[\s\S]*?```/gi, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^\s*\*?图[:：][^\n]*\*?\s*$/gm, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function countRetainedIllustrationPlans(plans, excludedItemIds, illustrationType) {
  let count = 0;
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (excludedItemIds?.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan?.illustration_type === illustrationType) {
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

function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

function normalizeContentGenerationRuntime(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    phase: String(source.phase || ''),
    touched_item_ids: normalizeStringArray(source.touched_item_ids || source.touchedItemIds),
    outline_expansion_completed: Math.max(0, Math.round(Number(source.outline_expansion_completed ?? source.outlineExpansionCompleted) || 0)),
    expansion_cycle_item_ids: normalizeStringArray(source.expansion_cycle_item_ids || source.expansionCycleItemIds),
    expansion_attempted_item_ids: normalizeStringArray(source.expansion_attempted_item_ids || source.expansionAttemptedItemIds),
    expansion_cycle_start_words: Math.max(0, Math.round(Number(source.expansion_cycle_start_words ?? source.expansionCycleStartWords) || 0)),
    target_item_id: String(source.target_item_id || source.targetItemId || '').trim(),
    regenerate_requirement: String(source.regenerate_requirement || source.regenerateRequirement || '').trim(),
    updated_at: source.updated_at || source.updatedAt || now(),
  };
}

function orderExpansionCandidates(candidates) {
  if (!candidates.length) return [];

  const middle = Math.floor(candidates.length / 2);
  const ordered = [candidates[middle]];
  const maxOffset = Math.max(middle, candidates.length - 1 - middle);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    if (middle - offset >= 0) {
      ordered.push(candidates[middle - offset]);
    }
    if (middle + offset < candidates.length) {
      ordered.push(candidates[middle + offset]);
    }
  }
  return ordered;
}

async function runWorkerPool({ limit, getNextItem, worker, shouldStop, onItemStart, onItemComplete }) {
  const workerCount = Math.max(1, Math.floor(Number(limit) || 1));
  let activeCount = 0;

  async function runWorker() {
    while (true) {
      if (shouldStop?.()) {
        return;
      }
      const item = getNextItem();
      if (!item) {
        return;
      }

      activeCount += 1;
      onItemStart?.(item, activeCount);
      try {
        const result = await worker(item);
        activeCount -= 1;
        await onItemComplete?.(item, result, activeCount);
      } catch (error) {
        activeCount -= 1;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

async function runItemsWithWorkerPool(items, limit, worker, shouldStop) {
  const workerCount = Math.min(Math.max(1, Math.floor(Number(limit) || 1)), Math.max(1, items.length));
  let nextIndex = 0;

  await runWorkerPool({
    limit: workerCount,
    shouldStop,
    getNextItem() {
      if (nextIndex >= items.length) {
        return null;
      }
      const item = items[nextIndex];
      nextIndex += 1;
      return item;
    },
    worker,
  });
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
    const interrupted = existing?.status === 'running';
    const content = interrupted ? '' : existing?.content || item.content || '';
    const existingStatus = interrupted ? 'error' : existing?.status;
    next[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: existingStatus || (content.trim() ? 'success' : 'idle'),
      content,
      error: interrupted ? INTERRUPTED_SECTION_ERROR : existing?.error,
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

async function runContentGenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload, taskControl, previousState }) {
  const resume = Boolean(payload.resume);
  const storedPlan = resume ? (previousState || {}) : (workspaceStore.loadTechnicalPlan() || {});
  let outlineData = payload.outlineData || storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const projectOverview = payload.projectOverview || outlineData.project_overview || storedPlan.projectOverview || '';
  const techRequirements = payload.techRequirements || payload.tech_requirements || storedPlan.techRequirements || '';
  if (resume && storedPlan.contentGenerationTask?.status !== 'paused') {
    throw new Error('没有可继续的已暂停正文生成任务');
  }
  let contentRuntime = normalizeContentGenerationRuntime(resume ? storedPlan.contentGenerationRuntime : {});
  const regenerate = !resume && Boolean(payload.regenerate);
  const targetItemId = resume ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  const fullRegenerate = regenerate && !targetItemId;
  if (fullRegenerate) {
    outlineData = { ...outlineData, outline: clearOutlineContent(outlineData.outline) };
  }

  let leaves = collectLeafContexts(outlineData.outline);
  if (!leaves.length) {
    throw new Error('当前目录没有可生成正文的小节');
  }
  const regenerateRequirement = resume ? contentRuntime.regenerate_requirement : String(payload.requirement || '').trim();
  const generationOptions = payload.generationOptions || payload.generation_options || storedPlan.contentGenerationOptions || {};
  const contentConcurrency = normalizeContentConcurrency(
    generationOptions.contentConcurrency ?? generationOptions.content_concurrency ?? payload.concurrency,
  );
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const realTimeRender = payload.real_time_render !== false && payload.realTimeRender !== false;
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const minimumWords = targetItemId ? 0 : normalizeMinimumWords(generationOptions.minimumWords ?? generationOptions.minimum_words);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(payload, storedPlan);
  const imageAvailability = aiService.getImageModelAvailability
    ? aiService.getImageModelAvailability()
    : { available: false, message: '生图模型不可用' };
  const aiImagesEnabled = Boolean(generationOptions.useAiImages ?? generationOptions.use_ai_images ?? imageAvailability.available) && imageAvailability.available;
  const mermaidImagesEnabled = Boolean(generationOptions.useMermaidImages ?? generationOptions.use_mermaid_images ?? Boolean(targetItemId));
  const requestedMaxImages = Number(generationOptions.maxAiImages ?? generationOptions.max_ai_images);
  const configuredMaxAiImages = aiImagesEnabled
    ? Math.max(0, Math.min(Number.isFinite(requestedMaxImages) ? Math.round(requestedMaxImages) : 6, targetItemId ? 1 : leaves.length))
    : 0;
  const imageStats = { ai: createImageStat(), mermaid: createImageStat() };
  const contentStats = {
    phase: 'planning',
    planning_total: 0,
    planning_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    outline_expansion_total: MAX_OUTLINE_EXPANSION_ROUNDS,
    outline_expansion_completed: 0,
    minimum_words: minimumWords,
    current_words: 0,
    illustration_total: 0,
    illustration_completed: 0,
  };
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
  });
  const contentPlans = new Map();
  let storedContentPlans = pruneContentGenerationPlans(fullRegenerate ? {} : storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems = [];
  let allowedKnowledgeItemIds = new Set();
  let knowledgeContentMap = new Map();
  let selectedAiImageIds = new Set();
  let aiImageTargets = [];
  let mermaidImageTargets = [];
  let sections = createInitialSections(leaves, fullRegenerate ? {} : storedPlan.contentGenerationSections);
  const touchedItemIds = new Set(contentRuntime.touched_item_ids);
  let tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    return regenerate || section?.status === 'error' || !String(content).trim();
  });
  if (targetItemId) {
    const targetSection = sections[targetItemId];
    tasksToRun = resume && targetSection?.status === 'success' && touchedItemIds.has(targetItemId)
      ? []
      : leaves.filter(({ item }) => item.id === targetItemId);
    if (!tasksToRun.length && (!resume || targetSection?.status !== 'success')) {
      throw new Error('未找到要重新生成的正文小节');
    }
  }

  const retryItemIds = new Set(tasksToRun
    .filter(({ item }) => sections[item.id]?.status === 'error')
    .map(({ item }) => item.id));

  for (const { item } of tasksToRun) {
    const existing = sections[item.id] || {};
    const content = existing.content || item.content || '';
    sections[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: 'idle',
      content,
      error: undefined,
      updated_at: now(),
    };
  }

  let runLimits = { maxTablesForRun: maxTables, maxAiImagesForRun: configuredMaxAiImages, retainedTableCount: 0, retainedAiImageCount: 0 };

  function refreshRunLimits(targets = tasksToRun) {
    const taskItemIds = new Set(targets.map(({ item }) => item.id));
    maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
    const retainedTableCount = maxTables === null ? 0 : countRetainedTablePlans(storedContentPlans, taskItemIds);
    const retainedAiImageCount = countRetainedIllustrationPlans(storedContentPlans, taskItemIds, 'ai');
    runLimits = {
      maxTablesForRun: maxTables === null ? null : Math.max(0, maxTables - retainedTableCount),
      maxAiImagesForRun: Math.max(0, configuredMaxAiImages - retainedAiImageCount),
      retainedTableCount,
      retainedAiImageCount,
    };
    return runLimits;
  }

  refreshRunLimits(tasksToRun);
  let logs = [resume ? `继续已暂停的正文生成任务，共 ${leaves.length} 个小节。` : `准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  }
  logs = [...logs, `正文生成并发速度：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  logs = [...logs, aiImagesEnabled
    ? `AI 生图已启用，将在整体编排后择优生成，全文最多 ${configuredMaxAiImages} 张，本轮最多新增 ${runLimits.maxAiImagesForRun} 张。`
    : 'AI 生图未启用或不可用，本次不会调用生图接口。'];
  if (minimumWords > 0) {
    logs = [...logs, `最低字数已启用：${minimumWords} 字，正文生成后将自动补足。`];
  }
  logs = [...logs, mermaidImagesEnabled
    ? 'Mermaid 图片已启用，适合简单图示的小节会优先使用 Mermaid 图。'
    : 'Mermaid 图片未启用。'];
  if (!realTimeRender) {
    logs = [...logs, '实时渲染已关闭，每个小节生成完成后再刷新正文。'];
  }

  function appendDeveloperLog(message) {
    if (!developerModeEnabled) {
      return;
    }
    logs = [...logs, message];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  knowledgeItems = loadContentKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });
  allowedKnowledgeItemIds = new Set(knowledgeItems.map((item) => item.id));
  knowledgeContentMap = loadContentKnowledgeContentMap(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });

  function getLeafContentForWords(item) {
    return sections[item.id]?.content || item.content || '';
  }

  function countTotalContentWords() {
    return leaves.reduce((sum, { item }) => sum + countContentWords(getLeafContentForWords(item)), 0);
  }

  function leafWordStats() {
    return leaves.map((context) => ({
      ...context,
      content: getLeafContentForWords(context.item),
      words: countContentWords(getLeafContentForWords(context.item)),
    }));
  }

  function statsSnapshot() {
    contentStats.generation_completed = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id]?.status)).length;
    contentStats.current_words = countTotalContentWords();
    contentStats.minimum_words = minimumWords;
    return { images: { total: sumImageStats(imageStats.ai, imageStats.mermaid), ai: { ...imageStats.ai }, mermaid: { ...imageStats.mermaid } }, content: { ...contentStats } };
  }

  function syncRuntime(partial = {}) {
    contentRuntime = normalizeContentGenerationRuntime({
      ...contentRuntime,
      ...partial,
      phase: partial.phase || contentStats.phase,
      touched_item_ids: Array.from(touchedItemIds),
      updated_at: now(),
    });
    return contentRuntime;
  }

  function isPauseRequested() {
    return Boolean(taskControl?.isPauseRequested?.());
  }

  function pauseIfRequested(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    if (!isPauseRequested()) {
      return;
    }

    logs = [...logs, message];
    const saved = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: syncRuntime(),
      contentGenerationTask: updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }),
    });
    updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, saved);
    const pauseError = new Error('CONTENT_GENERATION_PAUSED');
    pauseError.code = 'CONTENT_GENERATION_PAUSED';
    throw pauseError;
  }

  function rememberTouchedItem(itemId) {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    contentGenerationRuntime: syncRuntime(),
    referenceKnowledgeDocumentIds,
    contentGenerationTask: updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }),
  });
  updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan);

  if (!tasksToRun.length) {
    logs = [...logs, '正文已全部生成，将检查最低字数要求。'];
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
    outlineData = nextOutlineData;
    const saved = workspaceStore.updateTechnicalPlan({
      contentGenerationSections: sections,
      outlineData: nextOutlineData,
      contentGenerationRuntime: syncRuntime(),
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
    const saved = workspaceStore.updateTechnicalPlan({ contentGenerationPlans: storedContentPlans, contentGenerationRuntime: syncRuntime() });
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
          imageGenerationAvailable: aiImagesEnabled && runLimits.maxAiImagesForRun > 0,
          mermaidGenerationAvailable: mermaidImagesEnabled,
          maxAiImages: runLimits.maxAiImagesForRun,
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
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(contentPlan, 'none'),
    }, leaves);
    workspaceStore.updateTechnicalPlan({ contentGenerationPlans: storedContentPlans, contentGenerationRuntime: syncRuntime() });
    contentStats.planning_completed += 1;
    logs = [...logs, `编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，表格：${contentPlan.table.needed ? '需要' : '不需要'}，Mermaid：${contentPlan.mermaid.needed ? '需要' : '不需要'}，AI 图：${contentPlan.image.needed ? '需要' : '不需要'}）`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function planAll() {
    refreshRunLimits(tasksToRun);
    contentStats.phase = 'planning';
    contentStats.planning_total = tasksToRun.length;
    const planningTargets = [];
    for (const context of tasksToRun) {
      const storedContentPlan = normalizeStoredContentPlan(storedContentPlans[context.item.id]);
      if (storedContentPlan?.plan) {
        contentPlans.set(context.item.id, storedContentPlan.plan);
      } else {
        planningTargets.push(context);
      }
    }
    contentStats.planning_completed = tasksToRun.length - planningTargets.length;
    contentStats.generation_total = tasksToRun.length;
    logs = [...logs, planningTargets.length === tasksToRun.length
      ? `开始整体编排决策，共 ${tasksToRun.length} 个小节。`
      : `继续整体编排决策，共 ${tasksToRun.length} 个小节，复用 ${tasksToRun.length - planningTargets.length} 个历史编排。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    await runItemsWithWorkerPool(planningTargets, contentConcurrency, planOne, isPauseRequested);
    pauseIfRequested('正文生成已在编排阶段暂停，可导出当前已完成内容，稍后继续。');

    const tableCandidates = tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.table.needed);
    const selectedTableIds = runLimits.maxTablesForRun === null
      ? new Set(tableCandidates.map(({ item }) => item.id))
      : pickDistributedTableTargets(tableCandidates, runLimits.maxTablesForRun);
    if (runLimits.maxTablesForRun !== null) {
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
      runLimits.maxAiImagesForRun,
    );
    aiImageTargets = tasksToRun.filter(({ item }) => selectedAiImageIds.has(item.id));
    mermaidImageTargets = mermaidCandidates.filter(({ item }) => !selectedAiImageIds.has(item.id));
    imageStats.mermaid.planned = mermaidImageTargets.length;
    imageStats.mermaid.skipped += Math.max(0, mermaidCandidates.length - mermaidImageTargets.length);
    imageStats.ai.planned = selectedAiImageIds.size;
    imageStats.ai.skipped += Math.max(0, aiImageCandidates.length - selectedAiImageIds.size);

    logs = [...logs, `整体编排完成：表格候选 ${tableCandidates.length} 个，${runLimits.maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}；AI 生图候选 ${aiImageCandidates.length} 张，入选 ${selectedAiImageIds.size} 张；Mermaid 候选 ${mermaidCandidates.length} 张，执行 ${mermaidImageTargets.length} 张。`];
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
      pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({});
      const illustrationType = illustrationTypeForSinglePlan(contentPlan);
      applyIllustrationTargets([context], () => illustrationType);
      persistContentPlans([context], () => illustrationType);
      logs = [...logs, `当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}（配图：${illustrationType}）。`];
    }

    pauseIfRequested('正文生成已在小节编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function runOne(context) {
    const { item, parentChapters, siblingChapters } = context;
    const previousSection = sections[item.id] || {};
    const previousContent = previousSection.content || item.content || '';
    const isSingleSectionRegeneration = Boolean(targetItemId);
    let rawContent = regenerate || retryItemIds.has(item.id) ? '' : previousContent;
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
      rememberTouchedItem(item.id);
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

  function pruneRuntimeContentPlans() {
    const leafIds = new Set(leaves.map(({ item }) => item.id));
    for (const itemId of Array.from(contentPlans.keys())) {
      if (!leafIds.has(itemId)) {
        contentPlans.delete(itemId);
      }
    }
  }

  function refreshOutlineState(nextOutline, invalidatedItemIds = new Set()) {
    outlineData = { ...outlineData, outline: nextOutline };
    for (const itemId of invalidatedItemIds) {
      delete sections[itemId];
      delete storedContentPlans[itemId];
      contentPlans.delete(itemId);
    }
    leaves = collectLeafContexts(outlineData.outline);
    sections = createInitialSections(leaves, sections);
    storedContentPlans = pruneContentGenerationPlans(storedContentPlans, leaves);
    pruneRuntimeContentPlans();
    refreshRunLimits(tasksToRun);
    const saved = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: syncRuntime(),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved);
    return saved;
  }

  function medianLeafWords() {
    const words = leafWordStats()
      .map((item) => item.words)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    if (!words.length) return 600;
    return words[Math.floor(words.length / 2)] || 600;
  }

  function pendingContentContexts() {
    return leaves.filter(({ item }) => {
      const section = sections[item.id];
      const content = section?.content || item.content || '';
      return section?.status === 'error' || !String(content).trim();
    });
  }

  async function runOutlineExpansionRound(round) {
    const nodeMap = createOutlineNodeMap(outlineData.outline || []);
    const currentWords = countTotalContentWords();
    contentStats.phase = 'outline-expanding';
    contentStats.outline_expansion_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_completed = round - 1;
    syncRuntime({ phase: 'outline-expanding' });
    logs = [...logs, `最低字数未达标，开始第 ${round}/${MAX_OUTLINE_EXPANSION_ROUNDS} 轮补目录。`];
    const started = workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: contentRuntime });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, started);

    const patch = await aiService.collectJsonResponse({
      messages: buildOutlineExpansionMessages({
        projectOverview,
        techRequirements,
        outlineData,
        currentWords,
        minimumWords,
        medianLeafWords: medianLeafWords(),
        round,
        nodeMap,
      }),
      temperature: 0.4,
      progressLabel: '最低字数补目录',
      failureMessage: '模型返回的补目录数据格式无效',
      normalizer: (value) => normalizeOutlineExpansionResponse(value, { nodeMap }),
      validator: validateOutlineExpansionResponse,
      repairMessagesBuilder: (context) => buildOutlineExpansionRepairMessages(context, nodeMap),
    });

    if (!patch.additions.length) {
      contentStats.outline_expansion_completed = round;
      syncRuntime({ outline_expansion_completed: round });
      logs = [...logs, `第 ${round} 轮补目录未返回可用新增目录。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return 0;
    }

    const { outline, invalidatedItemIds, addedCount } = applyOutlineExpansionAdditions(outlineData.outline || [], patch);
    contentStats.outline_expansion_completed = round;
    syncRuntime({ outline_expansion_completed: round });
    logs = [...logs, `第 ${round} 轮补目录已应用：新增 ${addedCount} 个目录节点，清空 ${invalidatedItemIds.size} 个旧叶子正文并返还其编排额度。`];
    refreshOutlineState(outline, invalidatedItemIds);
    return addedCount;
  }

  async function runOutlineExpansionIfNeeded() {
    if (minimumWords <= 0 || countTotalContentWords() >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
      return;
    }

    let addedTotal = 0;
    const completedRounds = Math.min(contentRuntime.outline_expansion_completed || 0, MAX_OUTLINE_EXPANSION_ROUNDS);
    for (let round = completedRounds + 1; round <= MAX_OUTLINE_EXPANSION_ROUNDS; round += 1) {
      try {
        addedTotal += await runOutlineExpansionRound(round);
        pauseIfRequested('正文生成已在补目录阶段暂停，可导出当前已完成内容，稍后继续。');
      } catch (error) {
        if (error?.code === 'CONTENT_GENERATION_PAUSED') {
          throw error;
        }
        logs = [...logs, `第 ${round} 轮补目录失败：${error.message || '模型返回无效'}。`];
        contentStats.outline_expansion_completed = round;
        syncRuntime({ outline_expansion_completed: round });
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      }

      const estimatedWords = countTotalContentWords() + pendingContentContexts().length * medianLeafWords();
      if (estimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
        logs = [...logs, `补目录预估可达到最低字数的 ${Math.round(OUTLINE_EXPANSION_TARGET_RATIO * 100)}%，准备生成新增正文。`];
        break;
      }
    }

    tasksToRun = pendingContentContexts();
    if (!tasksToRun.length) {
      logs = [...logs, addedTotal ? '补目录后没有待生成叶子，直接进入正文扩写。' : '未补充到可生成目录，直接进入正文扩写。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return;
    }

    refreshRunLimits(tasksToRun);
    logs = [...logs, `开始为补充后的 ${tasksToRun.length} 个叶子小节生成正文。`];
    await planAll();
    pauseIfRequested('正文生成已在补目录新增正文编排后暂停，可导出当前已完成内容，稍后继续。');
    for (const { item } of tasksToRun) {
      if (sections[item.id]?.status === 'error') {
        retryItemIds.add(item.id);
      }
    }
    await runItemsWithWorkerPool(tasksToRun, contentConcurrency, runOne, isPauseRequested);
    pauseIfRequested('正文生成已在补目录新增正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
  }

  function refreshIllustrationTargetsFromStoredPlans(candidateItemIds) {
    imageStats.ai = createImageStat();
    imageStats.mermaid = createImageStat();
    const currentPlan = workspaceStore.loadTechnicalPlan() || {};
    const currentSections = currentPlan.contentGenerationSections || sections;
    const candidateIds = candidateItemIds instanceof Set ? candidateItemIds : new Set();
    const targets = leaves.filter(({ item }) => {
      if (!candidateIds.has(item.id)) {
        return false;
      }
      const section = currentSections[item.id] || {};
      const content = section.content || item.content || '';
      return section.status === 'success' && String(content || '').trim();
    });
    applyIllustrationTargets(targets, ({ item }) => {
      const storedContentPlan = normalizeStoredContentPlan(storedContentPlans[item.id]);
      if (storedContentPlan?.plan) {
        contentPlans.set(item.id, storedContentPlan.plan);
      }
      const illustrationType = storedContentPlan?.illustration_type || 'none';
      const content = currentSections[item.id]?.content || item.content || '';
      if (illustrationType !== 'none' && hasExistingIllustration(content, illustrationType)) {
        imageStats[illustrationType].skipped += 1;
        return 'none';
      }
      return illustrationType;
    });
  }

  function createExpansionCycle(currentWords) {
    const candidates = leafWordStats()
      .filter(({ item, content }) => sections[item.id]?.status === 'success' && String(content || '').trim())
      .sort((a, b) => a.words - b.words);
    const orderedIds = orderExpansionCandidates(candidates).map(({ item }) => item.id);
    syncRuntime({
      expansion_cycle_item_ids: orderedIds,
      expansion_attempted_item_ids: [],
      expansion_cycle_start_words: currentWords,
    });
    return orderedIds;
  }

  function getExpansionCycle(currentWords) {
    let cycleIds = contentRuntime.expansion_cycle_item_ids.filter((itemId) => sections[itemId]?.status === 'success');
    let attemptedIds = new Set(contentRuntime.expansion_attempted_item_ids);
    if (!cycleIds.length || cycleIds.every((itemId) => attemptedIds.has(itemId))) {
      cycleIds = createExpansionCycle(currentWords);
      attemptedIds = new Set(contentRuntime.expansion_attempted_item_ids);
    }

    return { cycleIds, attemptedIds };
  }

  function persistExpansionAttempted(attemptedIds) {
    workspaceStore.updateTechnicalPlan({
      contentGenerationRuntime: syncRuntime({ expansion_attempted_item_ids: Array.from(attemptedIds) }),
    });
  }

  function selectNextExpansionContext(cycleIds, attemptedIds) {
    const statsById = new Map(leafWordStats().map((context) => [context.item.id, context]));
    let changed = false;
    for (const itemId of cycleIds) {
      if (attemptedIds.has(itemId)) {
        continue;
      }
      const context = statsById.get(itemId);
      if (context && sections[itemId]?.status === 'success' && String(context.content || '').trim()) {
        return context;
      }
      attemptedIds.add(itemId);
      changed = true;
    }

    if (changed) {
      persistExpansionAttempted(attemptedIds);
    }
    return null;
  }

  async function runExpansionWorkerPool(startWords) {
    let currentWords = startWords;
    const { cycleIds, attemptedIds } = getExpansionCycle(currentWords);
    let launchedCount = 0;
    let minimumReachedLogged = false;
    let pauseLogged = false;

    appendDeveloperLog(`扩写工作池启动：并发 ${contentConcurrency}，候选 ${cycleIds.filter((itemId) => !attemptedIds.has(itemId)).length} 个，当前 ${currentWords}/${minimumWords} 字。`);

    await runWorkerPool({
      limit: contentConcurrency,
      shouldStop: () => currentWords >= minimumWords || isPauseRequested(),
      getNextItem() {
        if (currentWords >= minimumWords) {
          if (!minimumReachedLogged) {
            appendDeveloperLog('扩写已达最低字数，停止调度新请求，等待已发出的请求完成。');
            minimumReachedLogged = true;
          }
          return null;
        }
        if (isPauseRequested()) {
          if (!pauseLogged) {
            appendDeveloperLog('扩写暂停请求已收到，停止调度新请求，等待已发出的请求完成。');
            pauseLogged = true;
          }
          return null;
        }

        const context = selectNextExpansionContext(cycleIds, attemptedIds);
        if (!context) {
          return null;
        }

        attemptedIds.add(context.item.id);
        persistExpansionAttempted(attemptedIds);
        launchedCount += 1;
        return context;
      },
      onItemStart(context, activeCount) {
        appendDeveloperLog(`扩写请求发出：${context.item.id} ${context.item.title || '未命名章节'}，在飞 ${activeCount}/${contentConcurrency}。`);
      },
      async worker(context) {
        await expandOneSection(context);
        return context.item;
      },
      onItemComplete(_context, item, activeCount) {
        currentWords = countTotalContentWords();
        appendDeveloperLog(`扩写请求完成：${item.id} ${item.title || '未命名章节'}，当前 ${currentWords}/${minimumWords} 字，在飞 ${activeCount}/${contentConcurrency}。`);
        if (currentWords >= minimumWords) {
          if (!minimumReachedLogged) {
            appendDeveloperLog('扩写已达最低字数，停止调度新请求，等待已发出的请求完成。');
            minimumReachedLogged = true;
          }
        } else if (isPauseRequested()) {
          if (!pauseLogged) {
            appendDeveloperLog('扩写暂停请求已收到，停止调度新请求，等待已发出的请求完成。');
            pauseLogged = true;
          }
        }
      },
    });

    return {
      currentWords,
      completesCycle: cycleIds.length > 0 && cycleIds.every((itemId) => attemptedIds.has(itemId)),
      launchedCount,
    };
  }

  async function expandOneSection(context) {
    const { item, content, words } = context;
    const contentForPrompt = stripIllustrationsForExpansion(content) || content;
    const targetWords = Math.max(words * 2, words + MIN_SECTION_EXPANSION_INCREMENT);
    logs = [...logs, `开始扩写：${item.id} ${item.title || '未命名章节'}（当前 ${words} 字，目标 ${targetWords} 字）。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    try {
      const patch = await aiService.collectJsonResponse({
        messages: buildContentExpansionMessages({
          outlineData,
          context,
          projectOverview,
          currentContent: contentForPrompt,
          currentWords: words,
          targetWords,
        }),
        temperature: 0.7,
        progressLabel: '正文扩写',
        failureMessage: '模型返回的正文扩写结果格式无效',
        normalizer: normalizeContentExpansionPatch,
        validator: validateContentExpansionPatch,
        repairMessagesBuilder: buildContentExpansionRepairMessages,
      });
      const nextContent = applyContentExpansionPatch(content, patch);
      const nextWords = countContentWords(nextContent);
      logs = [...logs, `扩写完成：${item.id} ${item.title || '未命名章节'}（${words} -> ${nextWords} 字）。`];
      rememberTouchedItem(item.id);
      saveSection(item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
    } catch (error) {
      logs = [...logs, `扩写失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }
  }

  async function ensureMinimumWords() {
    let currentWords = countTotalContentWords();
    logs = [...logs, `正文生成后当前总字数 ${currentWords} 字，最低字数 ${minimumWords} 字。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    if (currentWords >= minimumWords) {
      logs = [...logs, '当前总字数已达到最低字数要求。'];
      return;
    }

    await runOutlineExpansionIfNeeded();

    currentWords = countTotalContentWords();
    while (currentWords < minimumWords) {
      contentStats.phase = 'expanding';
      logs = [...logs, `开始正文扩写，当前 ${currentWords}/${minimumWords} 字。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      const expansionResult = await runExpansionWorkerPool(currentWords);
      currentWords = expansionResult.currentWords;
      if (!expansionResult.launchedCount) {
        pauseIfRequested('正文生成已在扩写阶段暂停，可导出当前已完成内容，稍后继续。');
        throw new Error('没有可扩写的成功正文小节，无法补足最低字数');
      }
      if (expansionResult.completesCycle) {
        const expansionCycleStartWords = Number.isFinite(contentRuntime.expansion_cycle_start_words)
          ? contentRuntime.expansion_cycle_start_words
          : currentWords;
        if (currentWords <= expansionCycleStartWords) {
          const message = `正文扩写已覆盖一轮可选小节，但总字数没有增长，无法继续补足最低字数（当前 ${currentWords}/${minimumWords} 字）。`;
          logs = [...logs, message];
          updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
          throw new Error(message);
        }
        syncRuntime({
          expansion_cycle_item_ids: [],
          expansion_attempted_item_ids: [],
          expansion_cycle_start_words: currentWords,
        });
      }
      workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime() });
      pauseIfRequested('正文生成已在扩写阶段暂停，可导出当前已完成内容，稍后继续。');
    }

    logs = [...logs, `最低字数已达成：${currentWords}/${minimumWords} 字，准备进入配图阶段。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
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
      runItemsWithWorkerPool(aiImageTargets, AI_IMAGE_CONCURRENCY, runAiIllustration, isPauseRequested),
      runItemsWithWorkerPool(mermaidImageTargets, MERMAID_IMAGE_CONCURRENCY, runMermaidIllustration, isPauseRequested),
    ]);

    pauseIfRequested('正文生成已在配图阶段暂停，可导出当前已完成内容，稍后继续。');

    logs = [...logs, '配图阶段完成。'];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  try {
    if (tasksToRun.length) {
      if (targetItemId) {
        await prepareSingleSectionPlan();
      } else {
        await planAll();
      }

      pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
      await runItemsWithWorkerPool(tasksToRun, contentConcurrency, runOne, isPauseRequested);
      pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
    }

    if (!targetItemId) {
      await ensureMinimumWords();
      pauseIfRequested('正文生成已在最低字数检查后暂停，可导出当前已完成内容，稍后继续。');
      refreshIllustrationTargetsFromStoredPlans(touchedItemIds);
    } else if (!tasksToRun.length) {
      refreshIllustrationTargetsFromStoredPlans(new Set([targetItemId]));
    }

    pauseIfRequested('正文生成已在配图前暂停，可导出当前已完成内容，稍后继续。');
    await runIllustrations();
    pauseIfRequested('正文生成已在完成前暂停，可导出当前已完成内容，稍后继续。');

    const failedCount = leaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
    const finalProgress = progressFor(leaves, sections);
    const finalStatus = taskStatusFor(leaves, sections);
    contentStats.phase = 'done';
    logs = [...logs, targetItemId
      ? (failedCount ? `小节重新生成结束，当前整体进度 ${finalProgress}%，${failedCount} 个小节失败。` : `小节重新生成完成，当前整体进度 ${finalProgress}%。`)
      : (failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。')];
    technicalPlan = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: undefined,
      contentGenerationTask: updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }),
    });
    updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, technicalPlan);
  } catch (error) {
    if (error?.code === 'CONTENT_GENERATION_PAUSED') {
      return;
    }
    throw error;
  }
}

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle };
