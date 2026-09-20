const crypto = require('node:crypto');
const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');
const { createNoopDeveloperLogger } = require('../utils/developerLog.cjs');
const {
  ILLUSTRATION_PLAN_VERSION,
  buildIllustrationPlanningContext,
  buildIllustrationPlanningPrompt,
  resolveIllustrationPlan,
} = require('./contentIllustrationPlanning.cjs');
const {
  HTML_AGENT_THRESHOLD_CHARS,
  applyGeneratedIllustrationsToDocument,
  buildIllustrationExecutionContexts,
  generateAiIllustration,
  generateHtmlIllustration,
  generateMermaidIllustration,
  stripGeneratedIllustrationsFromDocument,
} = require('./contentIllustrationGeneration.cjs');
const { applyRangeEdits, findTextMatches } = require('../utils/textEdit.cjs');
const {
  createOriginalSource, readOriginalRange, buildOriginalRestorationFiles,
  buildOriginalRestorationPrompt, validateOriginalRestoration, calculateOriginalRestoration,
  originalImageReferences, validateOriginalImages, ORIGINAL_RESTORATION_JSON_SCHEMA,
} = require('./originalPlanRestoration.cjs');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { CONTENT_PLANNING_AGENT_TASK_KEY } = require('./contentPlanningAgentConfig.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, runContentGenerationAgent } = require('./contentGenerationAgent.cjs');

const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;
const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';
const MAX_WORD_ADJUSTMENT_ROUNDS = 3;
// 全文扩写不限制有效轮数，仅在连续多轮没有增加字数时退出。
const MAX_EXPANSION_NO_PROGRESS_ROUNDS = 3;
const TOTAL_WORD_ADJUSTMENT_BATCH_SIZE = 10;
const DEFAULT_SECTION_WORD_GUIDANCE = 3000;
const TOTAL_WORD_SHRINK_SECTION_RATIO = 0.25;
// 全文缩写阶段筛选候选小节时，可缩空间至少要达到本轮单节平均预算的比例，低于此值的小节直接跳过以免空占批次名额。
const TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO = 0.3;
const CONTENT_WORD_CONTROL_WARNING = '经多轮修复，字数仍未达预期，请您人工核对';
const SECTION_WORD_CONTROL_WARNING = '字数未达预期，请您人工核对';
const TABLE_CLEANUP_CONTEXT_CHARS = 600;
const TABLE_CLEANUP_BATCH_CHAR_LIMIT = 30000;
const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';
const CONTENT_PLAN_VERSION = 5;
const CONTENT_PLANNING_OUTPUT_FILE = '正文编排目录.json';
const CONTENT_PLANNING_KNOWLEDGE_FILE = '参考知识库轻量条目.json';
const CONTENT_PLANNING_BID_INFO_FILE = '招标文件关键信息.md';
const CONTENT_MODES = ['ai-generate', 'template-fill', 'directory-generate', 'manual-fill', 'other'];
const TABLE_REQUIREMENT_LABELS = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

const CONTENT_PLAN_SCHEMA = {
  type: 'object',
  required: ['writing_focus', 'knowledge', 'table', 'image_suitability_score'],
  additionalProperties: false,
  properties: {
    writing_focus: { type: 'string', minLength: 1 },
    image_suitability_score: { type: 'integer', minimum: 0, maximum: 10 },
    knowledge: {
      type: 'object',
      required: ['item_ids'],
      additionalProperties: false,
      properties: {
        item_ids: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    table: {
      type: 'object',
      required: ['needed', 'purpose'],
      additionalProperties: false,
      properties: {
        needed: { type: 'boolean' },
        purpose: { type: 'string' },
      },
    },
  },
};

function createContentPlanningNodeSchema(level, root = false) {
  const baseProperties = {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    ...(root ? { attr: { type: 'string', enum: ['通用', '商务/资信', '技术', '其他', '目录', '报价', '业绩'] } } : {}),
  };
  const baseRequired = ['id', 'title', 'description', ...(root ? ['attr'] : [])];
  const aiLeafSchema = {
    type: 'object',
    required: [...baseRequired, 'content_mode'],
    additionalProperties: false,
    properties: {
      ...baseProperties,
      content_mode: { type: 'string', enum: ['ai-generate'] },
      content_mode_note: { type: 'string' },
      content_plan: CONTENT_PLAN_SCHEMA,
    },
  };
  const otherLeafSchema = {
    type: 'object',
    required: [...baseRequired, 'content_mode'],
    additionalProperties: false,
    properties: {
      ...baseProperties,
      content_mode: { type: 'string', enum: CONTENT_MODES.filter((mode) => mode !== 'ai-generate') },
      content_mode_note: { type: 'string' },
    },
  };
  if (level >= 6) return { oneOf: [aiLeafSchema, otherLeafSchema] };
  return {
    oneOf: [
      aiLeafSchema,
      otherLeafSchema,
      {
        type: 'object',
        required: [...baseRequired, 'children'],
        additionalProperties: false,
        properties: {
          ...baseProperties,
          children: {
            type: 'array',
            minItems: 1,
            items: createContentPlanningNodeSchema(level + 1),
          },
        },
      },
    ],
  };
}

const CONTENT_PLANNING_JSON_SCHEMA = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: createContentPlanningNodeSchema(1, true),
    },
  },
};

function isAiQueueScopePausedError(error) {
  return error?.code === AI_QUEUE_SCOPE_PAUSED;
}

function isContentGenerationPausedError(error) {
  return error?.code === CONTENT_GENERATION_PAUSED;
}

function isPauseLikeError(error) {
  return isContentGenerationPausedError(error) || isAiQueueScopePausedError(error);
}

function createContentGenerationPausedError() {
  const error = new Error(CONTENT_GENERATION_PAUSED);
  error.code = CONTENT_GENERATION_PAUSED;
  return error;
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGlobalFactsMode(value) {
  return value === 'omit' || value === 'placeholder' ? value : 'fabricate';
}

function buildContentFactCompletenessInstruction(mode) {
  if (mode === 'omit') {
    return `事实补全规则（别招欠模式）：
1. 严禁虚拟、杜撰任何未在本章节全局事实变量和参考材料中明确给出的具体信息。
2. 全局事实变量中已经给出的笼统口径必须沿用，不得自行补成具体工艺、人名、日期、地点、业绩、证书、规格型号或实施细节。
3. 如果有不确定的，尽量使用笼统的方式表达，不涉及不确定的时间、地点、人员、业绩、证书、规格型号等任何事实项内容。
4. 不要为了写得具体而编造人名、日期、地点、业绩、证书编号、规格型号。`;
  }
  if (mode === 'placeholder') {
    return `事实补全规则（放着我来模式）：
1. 严禁虚拟、杜撰任何未在本章节全局事实变量和参考材料中明确给出的具体信息。
2. 任何不确定项必须使用【待填写】作为占位符，不要改写成“待定”或其他说法。
3. 如果全局事实变量中已有【待填写】，正文必须原样沿用，不得改成具体值。
4. 不要杜撰不确定的时间、地点、人员、业绩、证书、规格型号等任何事实项内容。`;
  }
  return '';
}

function formatGlobalFactsForPrompt(globalFacts) {
  const groups = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group, index) => {
      const title = singleLine(group?.title || `全局事实${index + 1}`);
      const content = String(group?.content || '').trim();
      if (!title || !content) return '';
      return `## ${title}\n${content}`;
    })
    .filter(Boolean);
  return groups.join('\n\n');
}

function appendGlobalFactsMessage(messages, globalFactsText) {
  const content = String(globalFactsText || '').trim();
  if (!content) return;
  messages.push({
    role: 'user',
    content: `全局事实变量（正文涉及时优先使用这些变量值，避免各章节随机变化）：\n${content}`,
  });
}

function formatGlobalFactTitlesForPrompt(globalFacts) {
  const titles = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => singleLine(group?.title))
    .filter(Boolean);
  return JSON.stringify([...new Set(titles)], null, 2);
}

function formatBidAnalysisFactForPrompt(storedPlan, itemId, label) {
  const item = storedPlan?.bidAnalysisTasks?.[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}

function formatBidAnalysisFactsForPrompt(storedPlan) {
  return [
    formatBidAnalysisFactForPrompt(storedPlan, 'projectInfo', '项目信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'partAInfo', '甲方信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'deliveryAndServiceRequirements', '交货和服务要求'),
  ].filter(Boolean).join('\n\n');
}

function formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText) {
  return [
    String(projectOverview || '').trim() ? `## 项目概述\n${String(projectOverview || '').trim()}` : '',
    String(bidAnalysisFactsText || '').trim(),
  ].filter(Boolean).join('\n\n') || '未提供';
}

function normalizeFactTitles(value, allowedFactTitles) {
  const source = Array.isArray(value) ? value : [];
  const titles = source.map((title) => singleLine(title)).filter(Boolean);
  const filtered = allowedFactTitles instanceof Set
    ? titles.filter((title) => allowedFactTitles.has(title))
    : titles;
  return [...new Set(filtered)];
}

function resolveGlobalFactsByTitles(titles, globalFacts) {
  const selected = new Set(normalizeFactTitles(titles));
  if (!selected.size) return [];
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .filter((group) => selected.has(singleLine(group?.title)) && String(group?.content || '').trim())
    .map((group) => ({ title: singleLine(group.title), content: String(group.content || '').trim() }));
}

function formatSelectedGlobalFactsForPrompt(globalFacts) {
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => {
      const title = singleLine(group?.title);
      const content = String(group?.content || '').trim();
      return title && content ? `## ${title}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
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

function splitLinesWithRanges(content) {
  const text = String(content || '');
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') {
      continue;
    }
    const lineEnd = index;
    const newlineEnd = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ text: text.slice(start, lineEnd), start, end: lineEnd, newlineEnd });
    start = newlineEnd;
    if (newlineEnd > index + 1) {
      index += 1;
    }
  }
  if (start < text.length || !lines.length) {
    lines.push({ text: text.slice(start), start, end: text.length, newlineEnd: text.length });
  }
  return lines;
}

function collectFencedCodeRanges(content) {
  const ranges = [];
  const lines = splitLinesWithRanges(content);
  let fence = null;
  let start = 0;
  for (const line of lines) {
    const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!match) {
      continue;
    }
    const marker = match[1][0];
    const length = match[1].length;
    const rest = match[2] || '';
    if (!fence) {
      if (marker === '`' && rest.includes('`')) {
        continue;
      }
      fence = { marker, length };
      start = line.start;
      continue;
    }
    if (marker === fence.marker && length >= fence.length && /^[ \t]*$/.test(rest)) {
      ranges.push({ start, end: line.newlineEnd });
      fence = null;
    }
  }
  if (fence) {
    ranges.push({ start, end: String(content || '').length });
  }
  return ranges;
}

function rangeOverlaps(start, end, ranges) {
  return (ranges || []).some((range) => start < range.end && end > range.start);
}

function isMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  return trimmed.includes('|') && trimmed.replace(/\\\|/g, '').includes('|');
}

function isMarkdownTableSeparator(line) {
  const trimmed = String(line || '').trim();
  if (!isMarkdownTableRow(trimmed)) return false;
  const rawCells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  const cells = rawCells.map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractMarkdownTableBlocks(content, fencedRanges) {
  const lines = splitLinesWithRanges(content);
  const tables = [];
  let index = 0;
  while (index < lines.length - 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (rangeOverlaps(header.start, separator.end, fencedRanges) || !isMarkdownTableRow(header.text) || !isMarkdownTableSeparator(separator.text)) {
      index += 1;
      continue;
    }

    let endLine = index + 1;
    while (endLine + 1 < lines.length && !rangeOverlaps(lines[endLine + 1].start, lines[endLine + 1].end, fencedRanges) && isMarkdownTableRow(lines[endLine + 1].text)) {
      endLine += 1;
    }
    const start = header.start;
    const end = lines[endLine].end;
    tables.push({ type: 'markdown', start, end, text: String(content || '').slice(start, end) });
    index = endLine + 1;
  }
  return tables;
}

function extractHtmlTableBlocks(content, fencedRanges) {
  const text = String(content || '');
  const tables = [];
  const pattern = /<table\b[\s\S]*?<\/table>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (rangeOverlaps(start, end, fencedRanges)) {
      continue;
    }
    tables.push({ type: 'html', start, end, text: match[0] });
  }
  return tables;
}

function addTableContext(content, tables) {
  const text = String(content || '');
  return (tables || []).map((table, index) => ({
    id: `T${String(index + 1).padStart(3, '0')}`,
    ...table,
    before: text.slice(Math.max(0, table.start - TABLE_CLEANUP_CONTEXT_CHARS), table.start).trim(),
    after: text.slice(table.end, Math.min(text.length, table.end + TABLE_CLEANUP_CONTEXT_CHARS)).trim(),
  }));
}

function extractContentTableBlocks(content) {
  const fencedRanges = collectFencedCodeRanges(content);
  const tables = [
    ...extractMarkdownTableBlocks(content, fencedRanges),
    ...extractHtmlTableBlocks(content, fencedRanges),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const nonOverlapping = [];
  for (const table of tables) {
    if (nonOverlapping.some((existing) => table.start < existing.end && table.end > existing.start)) {
      continue;
    }
    nonOverlapping.push(table);
  }
  return addTableContext(content, nonOverlapping);
}

function containsContentTable(content) {
  return extractContentTableBlocks(content).length > 0;
}

function createTableCleanupBatches(tables) {
  const batches = [];
  let current = [];
  let currentSize = 0;
  for (const table of tables || []) {
    const size = String(table.text || '').length + String(table.before || '').length + String(table.after || '').length;
    if (current.length && currentSize + size > TABLE_CLEANUP_BATCH_CHAR_LIMIT) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(table);
    currentSize += size;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function compactError(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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

function normalizeOutlineWordControlSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizeInteger = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  const sectionWords = normalizeInteger(source.sectionWords);
  return Object.freeze({
    enabled: Boolean(source.enabled),
    minimumWords: normalizeInteger(source.minimumWords),
    maximumWords: normalizeInteger(source.maximumWords),
    sectionWords,
    strictSectionWords: sectionWords > 0 && Boolean(source.strictSectionWords),
    sectionMinimumWords: sectionWords > 0 ? Math.ceil(sectionWords * 0.8) : 0,
    sectionMaximumWords: sectionWords > 0 ? Math.floor(sectionWords * 1.2) : 0,
  });
}

function normalizeContentConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_TEXT_CONCURRENCY_LIMIT);
}

function normalizeImageConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_IMAGE_CONCURRENCY_LIMIT);
}

function isDeveloperModeEnabled(aiService) {
  try {
    return Boolean(aiService?.isDeveloperMode?.());
  } catch {
    return false;
  }
}

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function textMetrics(value) {
  const content = String(value || '');
  return {
    chars: content.length,
    hash: textHash(content),
  };
}

function createContentDeveloperLogger(aiService, request) {
  try {
    return aiService?.createTechnicalPlanDeveloperLogger?.(request) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
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

// 标准化当前还原来源，不读取旧分段编号。
function normalizeOriginalMaterial(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    restored: Boolean(source.restored),
    optimized: Boolean(source.optimized),
    source_hash: String(source.source_hash || ''),
    source_ranges: Array.isArray(source.source_ranges) ? source.source_ranges.map(({ start_line, end_line }) => ({ start_line, end_line })) : [],
    restored_words: Math.max(0, Number(source.restored_words) || 0),
    ...(source.restored_at ? { restored_at: source.restored_at } : {}),
    ...(source.optimized_at ? { optimized_at: source.optimized_at } : {}),
  };
}

function normalizeContentPlan(value, allowedKnowledgeItemIds) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  const writing = source.writing && typeof source.writing === 'object' && !Array.isArray(source.writing) ? source.writing : {};
  const knowledgeSource = source.knowledge;
  const knowledge = knowledgeSource && typeof knowledgeSource === 'object' && !Array.isArray(knowledgeSource) ? knowledgeSource : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds;
  const table = source.table && typeof source.table === 'object' ? source.table : {};
  const tableNeeded = Boolean(table.needed);

  return {
    writing_focus: singleLine(source.writing_focus || source.writingFocus || writing.focus || writing.writing_focus || writing.writingFocus),
    image_suitability_score: source.image_suitability_score,
    image_needed: source.image_needed,
    knowledge: {
      item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowedKnowledgeItemIds),
    },
    table: {
      needed: tableNeeded,
      purpose: tableNeeded ? singleLine(table.purpose) : '',
    },
    original_material: normalizeOriginalMaterial(source.original_material || source.originalMaterial),
  };
}

// 按全文 AI 小节数确定配图名额；稳定排序保留同分小节的目录顺序，0 分不入选。
function selectContentImageTargets(leaves, plans, imageQuantity) {
  const ratio = imageQuantity === 'heavy' ? 0.5 : imageQuantity === 'light' ? 0.2 : 0;
  const limit = Math.floor(leaves.length * ratio);
  const candidates = leaves
    .filter(({ item }) => plans[item.id]?.plan?.image_suitability_score > 0)
    .sort((left, right) => plans[right.item.id].plan.image_suitability_score - plans[left.item.id].plan.image_suitability_score);
  return new Set(candidates.slice(0, limit).map(({ item }) => item.id));
}

function createStoredContentPlan(plan, tableRequirement) {
  const normalizedTableRequirement = tableRequirement ? normalizeTableRequirement(tableRequirement) : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan: normalizeContentPlan(plan),
    ...(normalizedTableRequirement ? { table_requirement: normalizedTableRequirement } : {}),
    updated_at: now(),
  };
}

function normalizeStoredContentPlan(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Number(value.plan_version ?? value.planVersion ?? 0) !== CONTENT_PLAN_VERSION) {
    return null;
  }

  const plan = normalizeContentPlan(value.plan || value.contentPlan || value);
  if (!plan.writing_focus) {
    return null;
  }
  try {
    validateContentPlan(plan);
  } catch {
    return null;
  }
  const tableRequirement = value.table_requirement || value.tableRequirement
    ? normalizeTableRequirement(value.table_requirement || value.tableRequirement)
    : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan,
    ...(tableRequirement ? { table_requirement: tableRequirement } : {}),
    updated_at: value.updated_at || value.updatedAt || now(),
  };
}

function isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement) {
  const currentRequirement = normalizeTableRequirement(tableRequirement);
  const storedRequirement = storedContentPlan?.table_requirement || '';
  if (storedRequirement) {
    return storedRequirement === currentRequirement;
  }
  return currentRequirement === 'none';
}

function originalMaterialFromStoredPlan(value) {
  const storedPlan = normalizeStoredContentPlan(value);
  return normalizeOriginalMaterial(storedPlan?.plan?.original_material);
}

function needsOriginalMaterialOptimization(value) {
  const originalMaterial = originalMaterialFromStoredPlan(value);
  return originalMaterial.restored && !originalMaterial.optimized;
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
  if (!Number.isInteger(plan.image_suitability_score) || plan.image_suitability_score < 0 || plan.image_suitability_score > 10) {
    throw new Error('正文编排决策的配图适配性评分必须是 0-10 的整数');
  }
  if (typeof plan.writing_focus !== 'string' || !plan.writing_focus.trim()) {
    throw new Error('正文编排决策缺少 writing_focus');
  }
  if (!plan.table || typeof plan.table.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 table.needed');
  }
}

function formatTablesForCleanupPrompt(tables) {
  return (tables || []).map((table) => `<table_block id="${table.id}" type="${table.type}">
上文片段：
${table.before || '无'}

待转换表格：
${table.text || ''}

下文片段：
${table.after || '无'}
</table_block>`).join('\n\n');
}

function buildTableCleanupMessages({ chapter, tables }) {
  const allowedIds = (tables || []).map((table) => table.id).join('、') || '无';
  return [
    {
      role: 'user',
      content: `你是投标技术方案正文编辑助手。请把指定小节中的表格转换为普通文字描述。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 必须逐个处理输入中的 table_id；允许按表格内容改写为普通段落或普通列表。
3. 不改变原文意思，不删除数字、参数、工期、标准、职责、流程、承诺、验收要求、频次和数量。
4. replacement_text 只写用于替换该表格块的正文片段，不返回完整小节正文。
5. replacement_text 严禁包含 Markdown 表格、HTML <table>、代码块、章节标题或伪目录标题。
6. 如表格本身为空或无法理解，也要用一句普通文字概括其表达意图，不要返回空字符串。

返回格式：
{
  "replacements": [
    { "table_id": "T001", "replacement_text": "普通文字描述" }
  ]
}

允许的 table_id：${allowedIds}`,
    },
    {
      role: 'user',
      content: `当前小节：${chapter?.id || 'unknown'} ${chapter?.title || '未命名章节'}
小节描述：${chapter?.description || '无'}`,
    },
    {
      role: 'user',
      content: `待转换表格块：
${formatTablesForCleanupPrompt(tables)}`,
    },
  ];
}

function normalizeTableCleanupResponse(value, allowedTableIds) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawReplacements = Array.isArray(source)
    ? source
    : Array.isArray(source.replacements)
      ? source.replacements
      : Array.isArray(source.items)
        ? source.items
        : [];
  const seen = new Set();
  const replacements = [];
  for (const item of rawReplacements) {
    const tableId = String(item?.table_id || item?.tableId || item?.id || '').trim();
    const replacementText = normalizeGeneratedMarkdown(String(item?.replacement_text || item?.replacementText || item?.text || item?.content || '')).trim();
    if (!tableId || seen.has(tableId) || (allowedTableIds instanceof Set && !allowedTableIds.has(tableId)) || !replacementText) {
      continue;
    }
    replacements.push({ table_id: tableId, replacement_text: replacementText });
    seen.add(tableId);
  }
  return { replacements };
}

function validateTableCleanupResponse(value) {
  if (!value || !Array.isArray(value.replacements)) {
    throw new Error('表格转换结果缺少 replacements 数组');
  }
}

function renderKnowledgeItemsForPrompt(items) {
  return JSON.stringify((items || []).map((item) => ({
    id: String(item.id || '').trim(),
    title: String(item.title || '').trim(),
    resume: String(item.resume || '').trim(),
  })).filter((item) => item.id && item.title && item.resume), null, 2);
}

// 将当前完整目录转换为 Agent 工作区文件；已有编排只保留本阶段负责的字段。
function buildContentPlanningOutline(items, storedContentPlans, root = true) {
  return (items || []).map((item) => {
    const children = normalizeChildren(item);
    const title = singleLine(item?.title) || '未命名章节';
    const node = {
      id: String(item?.id || '').trim(),
      title,
      description: String(item?.description || '').trim() || title,
      ...(root ? { attr: singleLine(item?.attr) || '其他' } : {}),
    };
    if (children.length) {
      return { ...node, children: buildContentPlanningOutline(children, storedContentPlans, false) };
    }
    const contentMode = String(item?.content_mode || '').trim();
    const stored = normalizeStoredContentPlan(storedContentPlans?.[node.id]);
    return {
      ...node,
      content_mode: contentMode,
      ...(String(item?.content_mode_note || '').trim() ? { content_mode_note: String(item.content_mode_note).trim() } : {}),
      ...(contentMode === 'ai-generate' && stored?.plan ? {
        content_plan: {
          writing_focus: stored.plan.writing_focus,
          image_suitability_score: stored.plan.image_suitability_score,
          knowledge: { item_ids: stored.plan.knowledge.item_ids },
          table: stored.plan.table,
        },
      } : {}),
    };
  });
}

function readContentPlanningJson(content) {
  try {
    return JSON.parse(String(content || '').trim());
  } catch (error) {
    throw new Error(`${CONTENT_PLANNING_OUTPUT_FILE}不是合法 JSON：${error?.message || String(error)}`);
  }
}

// 校验目录结构，只提取本次目标节点的编排，其他节点可尚未编排。
function extractContentPlanningPlans(value, sourceItems, allowedKnowledgeItemIds, targetItemIds) {
  if (!value || !Array.isArray(value.outline)) {
    throw new Error('正文编排结果缺少完整 outline');
  }
  const plans = new Map();
  function visit(actualItems, expectedItems, root) {
    if (!Array.isArray(actualItems) || actualItems.length !== expectedItems.length) {
      throw new Error('正文编排结果改变了目录节点数量');
    }
    expectedItems.forEach((expected, index) => {
      const actual = actualItems[index] || {};
      const expectedChildren = normalizeChildren(expected);
      const actualChildren = Array.isArray(actual.children) ? actual.children : [];
      const expectedTitle = singleLine(expected?.title) || '未命名章节';
      const expectedDescription = String(expected?.description || '').trim() || expectedTitle;
      if (String(actual.id || '').trim() !== String(expected?.id || '').trim()
        || String(actual.title || '').trim() !== expectedTitle
        || String(actual.description || '').trim() !== expectedDescription) {
        throw new Error(`正文编排结果修改了目录节点：${expected?.id || 'unknown'}`);
      }
      if (root && singleLine(actual.attr) !== (singleLine(expected?.attr) || '其他')) {
        throw new Error(`正文编排结果修改了一级目录属性：${expected?.id || 'unknown'}`);
      }
      if (expectedChildren.length) {
        if (!actualChildren.length || Object.prototype.hasOwnProperty.call(actual, 'content_plan')) {
          throw new Error(`正文编排结果修改了分支目录：${expected?.id || 'unknown'}`);
        }
        visit(actualChildren, expectedChildren, false);
        return;
      }
      if (actualChildren.length || String(actual.content_mode || '') !== String(expected?.content_mode || '')) {
        throw new Error(`正文编排结果修改了目录结构或内容模式：${expected?.id || 'unknown'}`);
      }
      const expectedNote = String(expected?.content_mode_note || '').trim();
      if (String(actual.content_mode_note || '').trim() !== expectedNote) {
        throw new Error(`正文编排结果修改了内容模式说明：${expected?.id || 'unknown'}`);
      }
      if (expected?.content_mode !== 'ai-generate') {
        if (Object.prototype.hasOwnProperty.call(actual, 'content_plan')) {
          throw new Error(`正文编排结果为非 AI 目录添加了编排：${expected?.id || 'unknown'}`);
        }
        return;
      }
      if (targetItemIds && !targetItemIds.has(String(expected.id))) return;
      const rawKnowledgeIds = actual.content_plan?.knowledge?.item_ids;
      if (Array.isArray(rawKnowledgeIds)
        && allowedKnowledgeItemIds instanceof Set
        && rawKnowledgeIds.some((id) => !allowedKnowledgeItemIds.has(String(id || '').trim()))) {
        throw new Error(`正文编排结果引用了不存在的知识库条目：${expected?.id || 'unknown'}`);
      }
      const plan = normalizeContentPlan(actual.content_plan, allowedKnowledgeItemIds);
      validateContentPlan(plan);
      if (plan.table.needed && !plan.table.purpose) {
        throw new Error(`正文编排结果缺少表格用途：${expected?.id || 'unknown'}`);
      }
      if (!plan.table.needed && String(actual.content_plan?.table?.purpose || '').trim()) {
        throw new Error(`正文编排结果为无表格目录填写了表格用途：${expected?.id || 'unknown'}`);
      }
      plans.set(String(expected.id), plan);
    });
  }
  visit(value.outline, sourceItems || [], true);
  return plans;
}

function formatContentPlanningProgress(value) {
  return Array.from(singleLine(value)).slice(0, 30).join('');
}

function createContentPlanningPrompt({ targetItemIds, regenerateTargetItemIds, regenerateRequirement, tableRequirement, maxTables, totalSections }) {
  const tableRequirementLabel = TABLE_REQUIREMENT_LABELS[tableRequirement] || TABLE_REQUIREMENT_LABELS.heavy;
  const tableLimitInstruction = tableRequirement === 'heavy'
    ? '表格需求为“大量”，没有数量上限，但仍然只有明显适合表格的小节才将 table.needed 设为 true。'
    : tableRequirement === 'none'
      ? '表格需求为“不要”，table.needed 必须为 false，table.purpose 留空。'
      : `表格需求为“${tableRequirementLabel}”，全文共 ${totalSections || 0} 个 AI 生成小节，表格上限为 ${maxTables || 0} 个；table.needed 只表示进入候选池，程序稍后还会全局择优。`;
  const targetText = targetItemIds.length
    ? targetItemIds.map((id) => `- ${id}`).join('\n')
    : '无。保持文件中已有编排不变，仅完成格式检查并写回。';
  const requirementText = String(regenerateRequirement || '').trim()
    ? `\n程序已确认以下节点需要应用本次重新生成的额外要求：\n${regenerateTargetItemIds.map((id) => `- ${id}`).join('\n')}\n\n额外要求：\n${String(regenerateRequirement).trim()}\n`
    : '';
  return `你是投标技术方案正文编排 Agent。工作区已经提供本次任务的全部材料：
- ${CONTENT_PLANNING_KNOWLEDGE_FILE}：参考知识库轻量条目，只包含 id、标题和简介。
- ${CONTENT_PLANNING_BID_INFO_FILE}：招标文件关键信息。
- ${CONTENT_PLANNING_OUTPUT_FILE}：当前最新的完整目录，也是最终输出文件。

程序已确定本次需要编排的目录节点：
${targetText}
${requirementText}
请严格完成以下工作：
1. 先读取全部三个文件，结合完整目录中的上下级和同级关系进行整体判断。
2. 只为 content_mode 为 ai-generate 的叶子节点编排；本次只修改程序列出的目标节点，其他节点及已有 content_plan 保持原样。
3. 本次目标叶子的 content_plan 必须包含 writing_focus、knowledge.item_ids、table.needed、table.purpose、image_suitability_score；非 AI 叶子和分支节点不得包含 content_plan。
4. writing_focus 用 1-2 句话概括本节正文重点，不展开成正文，不编造具体参数、周期、人员、设备、品牌、型号或承诺，并避免与相邻章节重复。
5. knowledge.item_ids 只能从 ${CONTENT_PLANNING_KNOWLEDGE_FILE} 中选择，可以多选或为空数组，不要编造 id。
6. ${tableLimitInstruction}
7. 表格仅在能明显提升职责、步骤、参数、风险、措施或成果等内容的表达清晰度时使用；需要时准确填写用途，不需要时 purpose 留空。
8. image_suitability_score 是本节配图适配性评分，必须为 0-10 的整数：0 表示不适合配图，10 表示非常适合配图。结合本节标题、说明、写作重点和项目背景，判断图片能否帮助读者理解流程、结构、关系或设备、场景示意等内容；图片带来的理解帮助越明显，评分越高，仅起装饰作用时不应给高分。
9. 不得修改目录节点数量、顺序、父子关系、id、title、description、attr、content_mode 或 content_mode_note。
10. 将完整结果覆盖写回 ${CONTENT_PLANNING_OUTPUT_FILE}。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${CONTENT_PLANNING_OUTPUT_FILE}"}；失败后先修改文件再重新校验。`;
}

function formatRestoreTargetsForPrompt(targets) {
  return (targets || []).map(({ item, parentChapters, siblingChapters }) => {
    const parentPath = (parentChapters || []).map((parent) => `${parent.id || 'unknown'} ${parent.title || '未命名章节'}`).join(' > ') || '无';
    const siblings = (siblingChapters || [])
      .filter((sibling) => sibling.id !== item.id)
      .map((sibling) => `${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}`)
      .join('；') || '无';
    return `- node_id: ${item.id || 'unknown'}
  标题: ${item.title || '未命名章节'}
  描述: ${item.description || ''}
  上级章节: ${parentPath}
  同级章节: ${siblings}`;
  }).join('\n');
}

function normalizeContentExpansionPatch(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatch = Array.isArray(source.operations) ? source.operations[0] : Array.isArray(source.patches) ? source.patches[0] : source;
  const operation = String(rawPatch.operation || rawPatch.type || '').trim().toLowerCase();
  const anchor = singleLine(rawPatch.anchor || rawPatch.position || rawPatch.after || rawPatch.target || rawPatch.replace_target || 'end') || 'end';
  const targetText = normalizeNewlines(rawPatch.target_text ?? rawPatch.targetText ?? rawPatch.old_text ?? rawPatch.oldText ?? '').trim();
  const content = normalizeGeneratedMarkdown(String(rawPatch.content || rawPatch.paragraph || rawPatch.text || rawPatch.new_content || ''))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  return { operation, anchor, target_text: targetText, content };
}

function validateContentExpansionPatch(patch) {
  if (!patch || !['insert', 'replace'].includes(patch.operation)) {
    throw new Error(`扩写结果 operation 无效：${patch?.operation || '空'}，只能是 insert 或 replace`);
  }
  if (patch.operation === 'replace' && !String(patch.target_text || '').trim()) {
    throw new Error('扩写 replace 结果缺少 target_text');
  }
  if (!String(patch.content || '').trim()) {
    throw new Error('扩写结果缺少 content');
  }
}

function buildContentExpansionRepairMessages({ invalidContent, issues }, currentContent = '') {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const currentContentBlock = String(currentContent || '').trim()
    ? [{ role: 'user', content: `当前正文，用于 replace 时逐字复制 target_text：\n${String(currentContent || '').slice(0, 60000)}` }]
    : [];
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“正文局部扩写”JSON。

必须满足：
1. 顶层只能包含 operation、anchor、target_text、content。
2. operation 只能是 "insert" 或 "replace"。
3. 严禁使用 delete、rewrite_full、rewrite、append、update 或其他 operation。
4. insert 表示新增段落；anchor 写建议插入在哪个原段落之后，无法确定时写 "end"。
5. replace 表示重写并扩写一个完整 Markdown 原文块；target_text 必须逐字复制完整待替换块，不得摘要、改写或只返回其中一句。
6. content 只能是新增或替换后的正文片段，不要返回完整章节正文。
7. content 不得包含章节标题、Markdown 标题、图片 Markdown、Mermaid、代码块或解释文字。
8. insert 时 target_text 留空；replace 时 anchor 可留空，但 target_text 必须非空。
9. 只返回 JSON，不要输出 Markdown 代码围栏或解释。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    ...currentContentBlock,
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractFencedAgentJsonBlocks(content) {
  const blocks = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(String(content || '')))) {
    blocks.push(match[1]);
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

  throw new Error(`Agent 未返回可解析的 JSON：${lastError?.message || '内容为空'}`);
}

function formatChapterPath(context) {
  return [...(context.parentChapters || []), context.item]
    .map((chapter) => `${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}`)
    .join(' > ');
}

function escapeSectionAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseAgentSectionMarkdown(markdown) {
  const sections = new Map();
  const lines = normalizeNewlines(markdown).split('\n');
  let currentId = '';
  let buffer = [];

  for (const line of lines) {
    const startMatch = /^\s*<!--\s*yibiao-section-start\s+id="([^"]+)"[^>]*-->\s*$/.exec(line);
    if (startMatch) {
      if (currentId) {
        throw new Error(`Agent 输出的小节标记嵌套：${currentId} 内出现 ${startMatch[1]}`);
      }
      currentId = String(startMatch[1] || '').trim();
      buffer = [];
      continue;
    }

    const endMatch = /^\s*<!--\s*yibiao-section-end\s+id="([^"]+)"\s*-->\s*$/.exec(line);
    if (endMatch) {
      const endId = String(endMatch[1] || '').trim();
      if (!currentId) {
        throw new Error(`Agent 输出存在未配对的小节结束标记：${endId}`);
      }
      if (endId !== currentId) {
        throw new Error(`Agent 输出小节标记不匹配：${currentId} / ${endId}`);
      }
      if (sections.has(currentId)) {
        throw new Error(`Agent 输出重复小节：${currentId}`);
      }
      sections.set(currentId, buffer.join('\n').trim());
      currentId = '';
      buffer = [];
      continue;
    }

    if (currentId) {
      buffer.push(line);
    }
  }

  if (currentId) {
    throw new Error(`Agent 输出小节未闭合：${currentId}`);
  }
  return sections;
}

function formatOriginalCoverageSources(sources) {
  return (sources || []).map((segment) => `<source id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content || ''}
</source>`).join('\n\n');
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

function normalizeReferenceDocumentIds(storedPlan) {
  const raw = storedPlan?.referenceKnowledgeDocumentIds ?? [];
  return Array.isArray(raw)
    ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

function loadContentKnowledgeReferences(knowledgeBaseService, documentIds, log) {
  if (!documentIds.length) {
    log('本次正文编排未选择参考知识库。');
    return { items: [] };
  }
  if (!knowledgeBaseService?.readReferences) {
    log('未找到知识库读取服务，正文编排不使用知识库。');
    return { items: [] };
  }

  try {
    const references = knowledgeBaseService.readReferences(documentIds);
    const items = [];
    for (const reference of Array.isArray(references) ? references : []) {
      const documentId = String(reference?.document?.id || '').trim();
      for (const item of Array.isArray(reference?.items) ? reference.items : []) {
        const itemId = String(item?.id || '').trim();
        const title = String(item?.title || '').trim();
        const resume = String(item?.resume || '').trim();
        if (reference?.document?.status === 'success' && documentId && itemId && title && resume) {
          items.push({ id: `${documentId}::${itemId}`, title, resume });
        }
      }
    }
    log(items.length ? `正文编排已读取 ${items.length} 条知识库轻量条目。` : '未读取到可用知识库轻量条目，正文编排不使用知识库。');
    return { items };
  } catch (error) {
    log(`读取正文编排参考知识库失败，已跳过：${error.message || String(error)}`);
    return { items: [] };
  }
}

function resolveSelectedFactsText(contentPlan, globalFacts) {
  const selectedFacts = resolveGlobalFactsByTitles(contentPlan?.facts?.titles, globalFacts);
  return formatSelectedGlobalFactsForPrompt(selectedFacts);
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

function normalizeParagraphs(content) {
  return String(content || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function findContentExpansionNeedleRanges(content, targetText) {
  const source = normalizeNewlines(content);
  const target = normalizeNewlines(targetText).trim();
  const matches = [];
  if (!target) {
    return matches;
  }

  let index = 0;
  while ((index = source.indexOf(target, index)) >= 0) {
    matches.push({ start: index, end: index + target.length, strategy: 'target_text-exact' });
    index += Math.max(1, target.length);
  }
  return matches;
}

function findContentExpansionTargetTextMatch(content, targetText) {
  const source = normalizeNewlines(content).trim();
  const target = normalizeNewlines(targetText).trim();
  if (!target) {
    return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace patch 缺少 target_text' };
  }

  const exactMatches = findContentExpansionNeedleRanges(source, target);
  if (exactMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: exactMatches[0].strategy, match: exactMatches[0], error: '' };
  }
  if (exactMatches.length > 1) {
    return { found: true, unique: false, count: exactMatches.length, strategy: 'target_text-exact', match: null, error: `replace target_text 精确命中 ${exactMatches.length} 处，拒绝替换` };
  }

  const sourceLines = splitLinesWithRanges(source);
  const targetLines = target.split('\n').map((line) => line.trim());
  const lineMatches = [];
  if (targetLines.length <= sourceLines.length) {
    for (let startIndex = 0; startIndex <= sourceLines.length - targetLines.length; startIndex += 1) {
      const matched = targetLines.every((line, offset) => sourceLines[startIndex + offset].text.trim() === line);
      if (!matched) {
        continue;
      }
      const firstLine = sourceLines[startIndex];
      const lastLine = sourceLines[startIndex + targetLines.length - 1];
      lineMatches.push({ start: firstLine.start, end: lastLine.end, strategy: 'target_text-line-trimmed' });
    }
  }

  if (lineMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: lineMatches[0].strategy, match: lineMatches[0], error: '' };
  }
  if (lineMatches.length > 1) {
    return { found: true, unique: false, count: lineMatches.length, strategy: 'target_text-line-trimmed', match: null, error: `replace target_text 逐行匹配命中 ${lineMatches.length} 处，拒绝替换` };
  }

  return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace target_text 未在当前章节正文中唯一命中' };
}

function applyContentExpansionPatch(content, patch) {
  const normalizedContent = normalizeNewlines(String(content || '')).trim();
  const patchContent = normalizeGeneratedMarkdown(patch.content).trim();
  if (!normalizedContent) {
    if (patch.operation === 'replace') {
      throw new Error('当前章节正文为空，replace target_text 无法执行替换');
    }
    return patchContent;
  }

  if (patch.operation === 'replace') {
    const targetMatch = findContentExpansionTargetTextMatch(normalizedContent, patch.target_text);
    if (!targetMatch.unique || !targetMatch.match) {
      throw new Error(targetMatch.error || 'replace target_text 未命中');
    }
    return `${normalizedContent.slice(0, targetMatch.match.start)}${patchContent}${normalizedContent.slice(targetMatch.match.end)}`;
  }

  const paragraphs = normalizeParagraphs(normalizedContent);
  const anchor = String(patch.anchor || '').trim();
  const anchorKey = anchor.replace(/\s+/g, ' ').trim();
  const anchorIndex = anchorKey && !/^end$/i.test(anchorKey)
    ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/g, ' ').includes(anchorKey) || anchorKey.includes(paragraph.replace(/\s+/g, ' ')))
    : -1;

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

function stripMarkdownHeadingsFromLeafContent(content) {
  let inFence = false;
  return String(content || '').split(/\r?\n/).map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }

    const match = /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      return line;
    }

    const text = match[2].trim();
    const unwrapped = text
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^__(.+)__$/, '$1')
      .trim();
    return `${match[1]}**${unwrapped || text}**`;
  }).join('\n');
}

function normalizeLeafContentForSave(content, chapter) {
  return stripMarkdownHeadingsFromLeafContent(
    stripRepeatedChapterTitle(normalizeGeneratedMarkdown(content), chapter),
  );
}

function normalizeWordAdjustmentResponse(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const mode = String(source.mode || '').trim();
  const granularity = String(source.granularity || '').trim();
  const operations = (Array.isArray(source.operations) ? source.operations : []).map((operation) => ({
    operation: String(operation?.operation || '').trim().toLowerCase(),
    anchor: normalizeNewlines(operation?.anchor || '').trim(),
    target_text: normalizeNewlines(operation?.target_text || '').trim(),
    content: normalizeGeneratedMarkdown(operation?.content || '').trim(),
  }));
  return { mode, granularity, operations };
}

function validateWordAdjustmentResponse(value) {
  if (!['expand', 'shrink'].includes(value?.mode)) throw new Error('字数调整 mode 只能是 expand 或 shrink');
  if (!['paragraph', 'sentence'].includes(value?.granularity)) throw new Error('字数调整 granularity 只能是 paragraph 或 sentence');
  if (!Array.isArray(value?.operations) || !value.operations.length) throw new Error('字数调整 operations 不能为空');
  for (const operation of value.operations) {
    const allowed = value.mode === 'expand' ? ['insert', 'replace'] : ['replace', 'delete'];
    if (!allowed.includes(operation.operation)) throw new Error(`当前调整方向不允许 ${operation.operation || '空'} 操作`);
    if (operation.operation === 'insert' && !operation.anchor) throw new Error('字数调整 insert anchor 不能为空');
    if (operation.operation !== 'insert' && !operation.target_text) throw new Error('字数调整 target_text 不能为空');
    if (operation.operation !== 'delete' && !operation.content) throw new Error('字数调整 content 不能为空');
    if (/^\s{0,3}#{1,6}\s/m.test(operation.content)
      || /!\[[^\]]*\]\([^)]*\)/.test(operation.content)
      || /<img\b/i.test(operation.content)
      || /```|~~~|\bmermaid\b/i.test(operation.content)
      || containsContentTable(operation.content)) {
      throw new Error('字数调整 content 不能包含标题、图片、Mermaid、代码块或表格');
    }
  }
}

function buildWordAdjustmentRepairMessages({ invalidContent, issues }, expectedMode, expectedGranularity, currentContent) {
  const operationRule = expectedMode === 'expand'
    ? '扩写只允许 insert/replace。insert 的 anchor 必须逐字复制当前正文中的唯一完整原文块，或使用 start/end；replace 的 target_text 必须逐字复制当前正文中的唯一完整目标。'
    : '缩写只允许 replace/delete，target_text 必须逐字复制当前正文中的唯一完整目标。';
  const responseFormat = expectedMode === 'expand'
    ? `{"mode":"expand","granularity":"${expectedGranularity}","operations":[{"operation":"insert","anchor":"完整唯一原文块或 start/end","target_text":"","content":"新增正文"}]}`
    : `{"mode":"shrink","granularity":"${expectedGranularity}","operations":[{"operation":"replace","target_text":"完整唯一原文块","content":"缩写后的正文"}]}`;
  return [
    { role: 'user', content: `请把待修复内容整理为正文局部字数调整 JSON。mode 必须是 ${expectedMode}，granularity 必须是 ${expectedGranularity}，operations 至少一项。${operationRule} content 不得包含标题、图片、Mermaid、代码块或表格，不得破坏列表层级、事实参数和服务承诺。返回格式：${responseFormat}。只返回 JSON。` },
    { role: 'user', content: `错误列表：\n${(issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n')}` },
    { role: 'user', content: `当前正文：\n${String(currentContent || '').slice(0, 60000)}` },
    { role: 'user', content: `待修复内容：\n${String(invalidContent || '').slice(0, 60000)}` },
  ];
}

function buildWordAdjustmentMessages({ context, currentContent, currentWords, targetWords, mode, granularity, selectedFactsText, maximumChangeWords, totalRemainingWords, totalWords, minimumWords, maximumWords, globalFactsMode }) {
  const { item, parentChapters, siblingChapters } = context;
  const chapterPath = [...(parentChapters || []), item].map((chapter) => `${chapter.id} ${chapter.title}`).join(' > ');
  const siblings = (siblingChapters || []).filter((chapter) => chapter.id !== item.id).map((chapter) => `${chapter.id} ${chapter.title}`).join('；') || '无';
  const adjustmentBudgetText = totalRemainingWords === undefined
    ? `当前小节本次最多允许${mode === 'expand' ? '增加' : '减少'} ${maximumChangeWords} 字。`
    : mode === 'expand'
      ? `本轮全文最多还需增加 ${totalRemainingWords} 字，当前小节本次最多允许增加 ${maximumChangeWords} 字。`
      : `本轮全文至少还需减少 ${totalRemainingWords} 字，当前小节本次最多允许减少 ${maximumChangeWords} 字。`;
  const totalWordText = totalWords === undefined
    ? ''
    : `当前全文 ${totalWords} 字，最少 ${minimumWords || '不限制'} 字，最多 ${maximumWords || '不限制'} 字。`;
  const responseFormat = mode === 'expand'
    ? `{"mode":"expand","granularity":"${granularity}","operations":[{"operation":"insert","anchor":"逐字复制当前正文中的唯一完整段落，或 start/end","target_text":"","content":"需要插入的新增正文"},{"operation":"replace","anchor":"","target_text":"逐字复制当前正文中的唯一完整原文块","content":"替换并扩写后的正文块"}]}`
    : `{"mode":"shrink","granularity":"${granularity}","operations":[{"operation":"replace","target_text":"逐字复制当前正文中的唯一完整${granularity === 'paragraph' ? '段落' : '句子'}","content":"缩写后的正文"}]}`;
  const operationRules = mode === 'expand'
    ? `2. 扩写只允许 insert、replace，优先使用 insert；可以返回多个操作，把新增内容按不同技术主题插入最相关的位置。
3. insert 的 anchor 必须逐字复制当前正文中的唯一完整原文段落或 Markdown 块；仅需插入开头或末尾时可写 start/end。锚点未命中时不会自动追加到末尾。
4. replace 的 target_text 必须逐字复制当前正文中的唯一完整原文块；多个操作的锚点和替换范围不能重复或重叠。
5. 新增正文的实际总字数应尽量接近但不得超过本次允许增加的字数；额度较大时应拆成多个 insert，禁止返回完整重写正文。`
    : `2. 缩写只允许 replace、delete。
3. target_text 必须逐字复制当前正文中的唯一完整目标，多项操作不能重叠。
4. 缩写优先删除重复、空泛、同义反复和不影响事实的修饰表达。
5. 不得返回完整重写正文。`;
  return [
    {
      role: 'user',
      content: `你是投标技术方案正文局部编辑助手。请对当前小节执行${mode === 'expand' ? '扩写' : '缩写'}，只返回 JSON，不返回完整重写正文。

JSON 格式：${responseFormat}

要求：
1. mode 和 granularity 必须与给定值一致。
${operationRules}
6. 不改变核心意思，不修改参数、数量、日期、周期和标准，不删除技术路线、职责、流程、风险措施、人员安排、验收要求、售后和服务承诺。
7. 不新增未提供的品牌、型号、人员、承诺和服务期限。
8. 不修改图片、Mermaid、代码块、表格结构、列表编号层级和资源路径，不生成 Markdown 标题或伪目录标题。
9. 不把其他目录应承载的内容移动到当前小节。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}` : ''}`,
    },
    { role: 'user', content: `当前章节路径：${chapterPath}\n章节描述：${item.description || ''}\n同级章节：${siblings}` },
    ...(String(selectedFactsText || '').trim() ? [{ role: 'user', content: `本章节全局事实变量：\n${selectedFactsText}` }] : []),
    { role: 'user', content: `当前小节正文：\n${currentContent}` },
    {
      role: 'user',
      content: `当前小节 ${currentWords} 字，目标约 ${targetWords} 字；${adjustmentBudgetText}${totalWordText}`,
    },
  ];
}

function collectProtectedContentRanges(content) {
  const ranges = collectFencedCodeRanges(content);
  ranges.push(...extractContentTableBlocks(content).map((table) => ({ start: table.start, end: table.end })));
  const patterns = [/!\[[^\]]*\]\([^)]*\)/g, /<img\b[^>]*>/gi];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content))) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function applyWordAdjustmentOperations(content, adjustment) {
  const source = String(content || '');
  const protectedRanges = collectProtectedContentRanges(source);
  const usedRanges = new Set();
  const edits = adjustment.operations.map((operation) => {
    if (operation.operation === 'insert') {
      const anchorKey = operation.anchor.trim().toLowerCase();
      let position;
      if (anchorKey === 'start') {
        position = 0;
      } else if (anchorKey === 'end') {
        position = source.length;
      } else {
        const anchorResult = findTextMatches(source, operation.anchor);
        if (!anchorResult.unique || anchorResult.strategy !== 'exact') {
          throw new Error('字数调整 insert anchor 未在当前正文中精确唯一命中');
        }
        const anchorMatch = anchorResult.matches[0];
        if (rangeOverlaps(anchorMatch.start, anchorMatch.end, protectedRanges)) {
          throw new Error('字数调整不能在图片、Mermaid、代码块或表格内部插入内容');
        }
        position = anchorMatch.end;
      }
      const rangeKey = `${position}:${position}`;
      if (usedRanges.has(rangeKey)) throw new Error('字数调整 insert anchor 重复');
      usedRanges.add(rangeKey);
      const newText = position === 0 ? `${operation.content}\n\n` : `\n\n${operation.content}`;
      return { start: position, end: position, newText };
    }

    const matchResult = findTextMatches(source, operation.target_text);
    if (!matchResult.unique || matchResult.strategy !== 'exact') {
      throw new Error('字数调整 target_text 未在当前正文中精确唯一命中');
    }
    const match = matchResult.matches[0];
    if (rangeOverlaps(match.start, match.end, protectedRanges)) {
      throw new Error('字数调整不能修改图片、Mermaid、代码块或表格');
    }
    const rangeKey = `${match.start}:${match.end}`;
    if (usedRanges.has(rangeKey)) throw new Error('字数调整 target_text 范围重复');
    usedRanges.add(rangeKey);
    return {
      start: match.start,
      end: match.end,
      newText: operation.operation === 'delete' ? '' : operation.content,
    };
  });
  const result = applyRangeEdits(source, edits);
  if (!result.changed || result.errors.length) {
    throw new Error(result.errors[0] || '字数调整没有产生有效修改');
  }
  return result.content;
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

function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

function normalizeContentGenerationRuntime(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    generation_started: Boolean(source.generation_started),
    direct_generation_item_ids: normalizeStringArray(source.direct_generation_item_ids),
    pending_item_ids: normalizeStringArray(source.pending_item_ids),
    phase: String(source.phase || ''),
    touched_item_ids: normalizeStringArray(source.touched_item_ids),
    completed_stages: normalizeStringArray(source.completed_stages),
    developer_stage_gate: String(source.developer_stage_gate || '').trim(),
    word_adjustment_stage: ['section', 'final-section', 'total'].includes(source.word_adjustment_stage) ? source.word_adjustment_stage : undefined,
    word_adjustment_item_id: String(source.word_adjustment_item_id || '').trim(),
    word_adjustment_round: Math.max(0, Math.round(Number(source.word_adjustment_round) || 0)),
    word_adjustment_item_rounds: { ...(source.word_adjustment_item_rounds || {}) },
    word_adjustment_completed_item_ids: normalizeStringArray(source.word_adjustment_completed_item_ids),
    word_adjustment_no_progress_rounds: Math.max(0, Math.round(Number(source.word_adjustment_no_progress_rounds) || 0)),
    word_adjustment_round_start_words: Math.max(0, Math.round(Number(source.word_adjustment_round_start_words) || 0)),
    target_item_id: String(source.target_item_id || '').trim(),
    regenerate_requirement: String(source.regenerate_requirement || '').trim(),
    simulate_partial_failures: Boolean(source.simulate_partial_failures),
    awaiting_content_decision: Boolean(source.awaiting_content_decision),
    updated_at: source.updated_at || now(),
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
  let firstError = null;

  async function runWorker() {
    while (true) {
      if (firstError || shouldStop?.()) {
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
        if (!firstError) {
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (firstError) {
    throw firstError;
  }
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

  const done = leaves.filter(({ item }) => ['success', 'error', 'ignored'].includes(sections[item.id]?.status)).length;
  return Math.round((done / leaves.length) * 100);
}

const CONTENT_PHASE_LABELS = {
  planning: '正文编排',
  restoring: '原方案还原',
  generating: '正文生成',
  'section-word-adjusting': '小节字数调整',
  'original-auditing': '原方案覆盖检查',
  auditing: '全文一致性检查',
  'table-cleaning': '表格清理',
  'final-section-word-adjusting': '最终小节复核',
  'total-word-adjusting': '全文字数调整',
  'illustration-planning': '全文图片编排',
  'illustration-generating': '全文图片生成',
  done: '已完成',
};

const CONTENT_PROGRESS_PROFILES = {
  full: {
    planning: [0, 12],
    restoring: [12, 18],
    generating: [18, 58],
    'section-word-adjusting': [58, 66],
    'original-auditing': [66, 73],
    auditing: [73, 81],
    'table-cleaning': [81, 85],
    'final-section-word-adjusting': [85, 90],
    'total-word-adjusting': [90, 95],
    'illustration-planning': [95, 98],
    'illustration-generating': [98, 99],
    done: [100, 100],
  },
  single: {
    planning: [0, 15],
    restoring: [15, 25],
    generating: [25, 65],
    'original-auditing': [65, 75],
    auditing: [75, 85],
    'table-cleaning': [85, 90],
    'section-word-adjusting': [90, 99],
    done: [100, 100],
  },
  correction: {
    'original-auditing': [0, 18],
    auditing: [18, 42],
    'table-cleaning': [42, 50],
    'final-section-word-adjusting': [50, 68],
    'total-word-adjusting': [68, 85],
    'illustration-planning': [85, 94],
    'illustration-generating': [94, 99],
    done: [100, 100],
  },
  illustration: {
    'illustration-planning': [0, 65],
    'illustration-generating': [65, 99],
    done: [100, 100],
  },
  'illustration-generation': {
    'illustration-generating': [0, 99],
    done: [100, 100],
  },
};

function clampPercentage(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function percentageFor(completed, total) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  if (!normalizedTotal) return 0;
  return clampPercentage((Math.max(0, Number(completed) || 0) / normalizedTotal) * 100);
}

// 将当前正文子阶段的计数统一为插件和 Renderer 可直接消费的进度明细。
function buildContentPhaseProgress(contentStats, latestLog = '', progressMode = 'full') {
  const stats = contentStats || {};
  const phase = stats.phase || 'planning';
  const phaseLabel = CONTENT_PHASE_LABELS[phase] || '正文生成';
  let step = phase;
  let stepLabel = latestLog || phaseLabel;
  let completed = 0;
  let total = 0;
  let phaseProgress = 0;

  if (phase === 'planning') {
    completed = stats.planning_completed;
    total = stats.planning_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'restoring') {
    completed = stats.restoration_completed;
    total = stats.restoration_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'generating') {
    completed = stats.generation_completed;
    total = stats.generation_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'section-word-adjusting' || phase === 'final-section-word-adjusting') {
    completed = Math.max(0, Number(stats.section_adjustment_completed) || 0);
    total = Math.max(0, Number(stats.section_adjustment_total) || 0);
    const activeCount = Math.min(Math.max(0, total - completed), Math.max(0, Number(stats.section_adjustment_active_count) || 0));
    const roundProgress = percentageFor(stats.section_adjustment_round, stats.section_adjustment_round_total) / 100;
    phaseProgress = total ? percentageFor(completed + activeCount * roundProgress, total) : 0;
    step = 'adjusting';
  } else if (phase === 'original-auditing' || phase === 'auditing') {
    completed = stats.audit_agent_step_completed;
    total = stats.audit_agent_step_total;
    phaseProgress = percentageFor(completed, total);
    step = 'agent';
    stepLabel = stats.audit_agent_step_label || stepLabel;
  } else if (phase === 'table-cleaning') {
    completed = stats.table_cleanup_completed;
    total = stats.table_cleanup_total;
    phaseProgress = percentageFor(completed, total);
    step = 'cleaning';
  } else if (phase === 'total-word-adjusting') {
    if (stats.total_adjustment_mode === 'expand') {
      const minimumWords = Math.max(0, Number(stats.minimum_words) || 0);
      const currentWords = Math.max(0, Number(stats.current_words) || 0);
      completed = Math.min(currentWords, minimumWords);
      total = minimumWords;
      phaseProgress = percentageFor(completed, total);
    } else {
      const round = Math.max(1, Number(stats.total_adjustment_round) || 1);
      const roundTotal = Math.max(1, Number(stats.total_adjustment_round_total) || 1);
      completed = stats.total_adjustment_batch_completed;
      total = stats.total_adjustment_batch_total;
      const batchProgress = total ? Math.max(0, Number(completed) || 0) / Math.max(1, Number(total) || 1) : 0;
      phaseProgress = clampPercentage((((round - 1) + batchProgress) / roundTotal) * 100);
    }
    step = 'adjusting';
  } else if (phase === 'illustration-planning') {
    completed = stats.illustration_planning_step_completed;
    total = stats.illustration_planning_step_total;
    phaseProgress = percentageFor(completed, total);
    step = 'planning';
    stepLabel = stats.illustration_planning_step_label || stepLabel;
  } else if (phase === 'illustration-generating') {
    completed = stats.illustration_generation_completed;
    total = stats.illustration_generation_total;
    phaseProgress = percentageFor(completed, total);
    step = 'generating';
    stepLabel = stats.illustration_generation_step_label || stepLabel;
  } else if (phase === 'done') {
    completed = 1;
    total = 1;
    phaseProgress = 100;
    step = 'done';
  }

  return {
    mode: progressMode,
    phase,
    phase_label: phaseLabel,
    phase_progress: phaseProgress,
    completed: Math.max(0, Number(completed) || 0),
    total: Math.max(0, Number(total) || 0),
    step,
    step_label: stepLabel,
  };
}

// 按当前任务模式把阶段内进度映射为单调递增的正文生成累计进度。
function buildContentOverallProgress(progressMode, detail, status) {
  if (status === 'success' || detail.phase === 'done') return 100;
  const profile = CONTENT_PROGRESS_PROFILES[progressMode] || CONTENT_PROGRESS_PROFILES.full;
  const range = profile[detail.phase];
  if (!range) return 0;
  const [start, end] = range;
  return Math.min(99, Math.round(start + ((end - start) * detail.phase_progress) / 100));
}

function taskStatusFor(leaves, sections) {
  if (leaves.some(({ item }) => isUnresolvedContentSection(sections[item.id]))) {
    return 'error';
  }

  return 'success';
}

// 后续流程开始前，正文小节只能是已成功或用户明确忽略。
function isUnresolvedContentSection(section) {
  return section?.status !== 'success' && section?.status !== 'ignored';
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

async function runContentGenerationTask({ aiService, agentService, ordinaryAgentService, workspaceStore, knowledgeBaseService, templateStore, updateTask: updateManagedTask, checkpointTask: checkpointManagedTask, payload, taskControl, previousState }) {
  const resume = Boolean(payload.resume);
  const storedPlan = resume ? (previousState || {}) : (workspaceStore.loadTechnicalPlan() || {});
  const wordControl = normalizeOutlineWordControlSnapshot(storedPlan.outlineWordControlSnapshot);
  let outlineData = storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const globalFacts = Array.isArray(storedPlan.globalFacts) ? storedPlan.globalFacts : [];
  const globalFactsText = formatGlobalFactsForPrompt(globalFacts);
  const globalFactsMode = normalizeGlobalFactsMode(storedPlan.globalFactsMode);
  if (!globalFactsText || storedPlan.globalFactsTask?.status !== 'success') {
    throw new Error('请先完成全局事实设定，再生成正文');
  }
  const globalFactTitlesText = formatGlobalFactTitlesForPrompt(globalFacts);
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan);
  const hasOriginalPlan = Boolean(storedPlan.originalPlanFile?.markdownPath);
  let originalPlanMarkdown = '';
  if (hasOriginalPlan) {
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = workspaceStore.readOriginalPlanMarkdown();
    workspaceStore.assertOriginalImageFiles(originalPlanMarkdown);
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成正文');
    }
  }
  const originalSource = hasOriginalPlan ? createOriginalSource(originalPlanMarkdown) : null;
  const originalPlanSourceHash = hasOriginalPlan ? textHash(originalPlanMarkdown.trim()) : '';

  const projectOverview = outlineData.project_overview || storedPlan.projectOverview || '';
  const techRequirements = storedPlan.techRequirements || '';
  if (resume && storedPlan.contentGenerationTask?.status !== 'paused') {
    throw new Error('没有可继续的已暂停正文生成任务');
  }
  const retryContentCorrection = !resume && Boolean(payload.retryContentCorrection ?? payload.retry_content_correction);
  const rerunIllustrations = !resume && Boolean(payload.rerunIllustrations ?? payload.rerun_illustrations);
  const retryFailedSections = !resume && Boolean(payload.retryFailedSections ?? payload.retry_failed_sections);
  const continuePostProcessing = !resume && Boolean(payload.continuePostProcessing ?? payload.continue_post_processing);
  let contentRuntime = normalizeContentGenerationRuntime(resume || retryContentCorrection || retryFailedSections || continuePostProcessing
    ? (storedPlan.contentGenerationRuntime || previousState?.contentGenerationRuntime)
    : {
      generation_started: true,
      direct_generation_item_ids: storedPlan.contentGenerationRuntime?.direct_generation_item_ids,
      pending_item_ids: storedPlan.contentGenerationRuntime?.pending_item_ids,
    });
  const runOnlyIllustrationPlanning = rerunIllustrations
    || (resume && contentRuntime.phase === 'illustration-planning')
    || (retryContentCorrection && previousState?.contentGenerationTask?.stats?.content?.phase === 'illustration-planning');
  const runOnlyIllustrationGeneration = (resume && contentRuntime.phase === 'illustration-generating')
    || (retryContentCorrection && previousState?.contentGenerationTask?.stats?.content?.phase === 'illustration-generating');
  const runOnlyIllustrationStage = runOnlyIllustrationPlanning || runOnlyIllustrationGeneration;
  const regenerate = !resume && !retryContentCorrection && !rerunIllustrations && !retryFailedSections && !continuePostProcessing && Boolean(payload.regenerate);
  const targetItemId = resume ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  if (retryContentCorrection && targetItemId) {
    throw new Error('单小节重新生成不支持重试内容矫正');
  }
  const fullRegenerate = regenerate && !targetItemId;
  if (fullRegenerate) {
    contentRuntime.direct_generation_item_ids = [];
    contentRuntime.pending_item_ids = [];
  }
  const directGenerationIds = new Set(contentRuntime.direct_generation_item_ids);
  if (fullRegenerate) {
    workspaceStore.clearMermaidCache?.();
    outlineData = { ...outlineData, outline: clearOutlineContent(outlineData.outline) };
  }

  let leaves = collectLeafContexts(outlineData.outline)
    .filter(({ item }) => item?.content_mode === 'ai-generate');
  if (!leaves.length) {
    throw new Error('当前目录没有标记为“AI生成”的正文小节');
  }
  const regenerateRequirement = resume ? contentRuntime.regenerate_requirement : String(payload.requirement || '').trim();
  const generationOptions = retryFailedSections || continuePostProcessing
    ? storedPlan.contentGenerationOptions || {}
    : payload.generationOptions || payload.generation_options || storedPlan.contentGenerationOptions || {};
  const imageQuantity = storedPlan.contentGenerationOptions.imageQuantity;
  const aiConfig = aiService.getConfig ? aiService.getConfig() : {};
  const contentConcurrency = normalizeContentConcurrency(aiConfig.concurrency_limit);
  const imageConcurrency = normalizeImageConcurrency(aiConfig.image_model?.concurrency_limit);
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const contentStats = {
    phase: 'planning',
    planning_total: 0,
    planning_completed: 0,
    restoration_total: 0,
    restoration_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    minimum_words: wordControl.minimumWords,
    maximum_words: wordControl.maximumWords,
    section_words: wordControl.sectionWords,
    strict_section_words: wordControl.strictSectionWords,
    current_words: 0,
    section_adjustment_total: 0,
    section_adjustment_completed: 0,
    section_adjustment_active_count: 0,
    section_adjustment_item_id: '',
    section_adjustment_round: 0,
    section_adjustment_round_total: MAX_WORD_ADJUSTMENT_ROUNDS,
    total_adjustment_round: 0,
    total_adjustment_round_total: 0,
    total_adjustment_mode: '',
    total_adjustment_batch_total: 0,
    total_adjustment_batch_completed: 0,
    total_adjustment_batch_failed: 0,
    total_adjustment_active_count: 0,
    total_adjustment_item_id: '',
    total_adjustment_remaining_words: 0,
    word_control_warning: undefined,
    audit_agent_step_total: 0,
    audit_agent_step_completed: 0,
    audit_agent_step_label: '',
    audit_agent_changed_sections: 0,
    audit_agent_failed_sections: 0,
    table_cleanup_total: 0,
    table_cleanup_completed: 0,
    table_cleanup_rewritten: 0,
    table_cleanup_skipped: 0,
    illustration_planning_step_total: 0,
    illustration_planning_step_completed: 0,
    illustration_planning_step_label: '',
    illustration_candidate_ai: 0,
    illustration_candidate_mermaid: 0,
    illustration_candidate_html: 0,
    illustration_selected_ai: 0,
    illustration_selected_mermaid: 0,
    illustration_selected_html: 0,
    illustration_generation_total: 0,
    illustration_generation_completed: 0,
    illustration_generation_ai_total: 0,
    illustration_generation_ai_completed: 0,
    illustration_generation_mermaid_total: 0,
    illustration_generation_mermaid_completed: 0,
    illustration_generation_html_total: 0,
    illustration_generation_html_completed: 0,
    illustration_generation_step_label: '',
    awaiting_content_decision: false,
    ignored_section_count: leaves.filter(({ item }) => storedPlan.contentGenerationSections?.[item.id]?.status === 'ignored').length,
  };
  // 同一原方案继续任务时保留已完成的统计，全文重新生成则等待本轮还原结果。
  const previousOriginalRestoration = previousState?.contentGenerationTask?.stats?.content?.original_restoration;
  if (hasOriginalPlan && !fullRegenerate && typeof previousOriginalRestoration?.total_words === 'number' && previousOriginalRestoration.source_hash === originalPlanSourceHash) {
    contentStats.original_restoration = { ...previousOriginalRestoration };
  }
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
    developer_stage_gate: resume && payload.developerStageAction === 'continue' ? '' : contentRuntime.developer_stage_gate,
    simulate_partial_failures: resume
      ? contentRuntime.simulate_partial_failures
      : Boolean(payload.simulatePartialFailures ?? payload.simulate_partial_failures),
  });
  const completedStages = new Set(contentRuntime.completed_stages);
  let contentAgentState = resume ? storedPlan.contentGenerationTask?.stats?.agent : undefined;
  const contentPlans = new Map();
  let storedContentPlans = pruneContentGenerationPlans(fullRegenerate ? {} : storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems = [];
  let allowedKnowledgeItemIds = new Set();
  let sections = createInitialSections(leaves, fullRegenerate ? {} : storedPlan.contentGenerationSections);
  const touchedItemIds = new Set(contentRuntime.touched_item_ids);
  let tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    const originalState = getOriginalMaterialRuntimeState(item);
    return regenerate || section?.status !== 'ignored'
      && (section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair);
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

  if (retryContentCorrection) {
    const successfulIds = leaves
      .filter(({ item }) => {
        const section = sections[item.id] || {};
        return section.status === 'success';
      })
      .map(({ item }) => item.id);
    const ignoredCount = leaves.filter(({ item }) => sections[item.id]?.status === 'ignored').length;
    if (successfulIds.length + ignoredCount !== leaves.length) {
      throw new Error('只有正文小节全部生成成功或已忽略后，才能重试内容矫正');
    }
    successfulIds.forEach((itemId) => touchedItemIds.add(itemId));
    tasksToRun = [];
  }

  if (retryFailedSections) {
    tasksToRun = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
  } else if (continuePostProcessing) {
    tasksToRun = [];
  }

  if (!fullRegenerate && !targetItemId && contentRuntime.pending_item_ids.length) {
    const pendingIds = new Set(contentRuntime.pending_item_ids);
    tasksToRun = tasksToRun.filter(({ item }) => pendingIds.has(item.id));
  }

  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
  });

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

  let runLimits = {
    maxTablesForRun: maxTables,
    retainedTableCount: 0,
  };

  function refreshRunLimits(targets = tasksToRun) {
    const taskItemIds = new Set(targets.map(({ item }) => item.id));
    maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
    const retainedTableCount = maxTables === null ? 0 : countRetainedTablePlans(storedContentPlans, taskItemIds);
    runLimits = {
      maxTablesForRun: maxTables === null ? null : Math.max(0, maxTables - retainedTableCount),
      retainedTableCount,
    };
    return runLimits;
  }

  refreshRunLimits(tasksToRun);
  let logs = [retryContentCorrection
    ? `准备重试内容矫正，共 ${leaves.length} 个已生成小节。`
    : resume
      ? `继续已暂停的正文生成任务，共 ${leaves.length} 个小节。`
      : `准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  } else if (retryFailedSections) {
    logs = [...logs, `开始重试 ${tasksToRun.length} 个失败或未完成正文小节。`];
  } else if (continuePostProcessing) {
    logs = [...logs, '用户已确认忽略失败或未完成小节，准备直接继续后续流程。'];
  }
  logs = [...logs, `文本模型并发上限：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  if (wordControl.minimumWords > 0 || wordControl.maximumWords > 0 || wordControl.sectionWords > 0) {
    logs = [...logs, `目录生效字数配置：最少 ${wordControl.minimumWords || '不限制'} 字，最多 ${wordControl.maximumWords || '不限制'} 字，每小节 ${wordControl.sectionWords || '不控制'} 字。`];
  }
  logs = [...logs, '全文一致性审计为必做阶段，正文扩写完成后将使用 Agent 检查并修复事实冲突。'];
  if (hasOriginalPlan) {
    logs = [...logs, `检测到已上传原方案：已读取完整原方案，交由 Agent 按语义还原。`];
    logs = [...logs, `原方案覆盖审计为必做阶段，本次将使用 Agent 检查并补回${targetItemId ? '当前小节' : '正文'}的原文保留情况。`];
  }

  const progressMode = resume && storedPlan.contentGenerationTask?.progress_detail?.mode
    ? storedPlan.contentGenerationTask.progress_detail.mode
    : runOnlyIllustrationGeneration
      ? 'illustration-generation'
      : runOnlyIllustrationPlanning
        ? 'illustration'
        : retryContentCorrection
          ? 'correction'
          : targetItemId
            ? 'single'
            : 'full';
  let lastTaskProgress = resume ? Math.max(0, Number(storedPlan.contentGenerationTask?.progress) || 0) : 0;

  // 所有正文任务更新都在这里补充累计进度和当前阶段明细。
  function buildTaskUpdate(partial = {}) {
    const latestLog = (partial.logs || logs || []).at(-1) || '';
    const progressDetail = buildContentPhaseProgress(contentStats, latestLog, progressMode);
    const calculatedProgress = buildContentOverallProgress(progressMode, progressDetail, partial.status);
    lastTaskProgress = partial.status === 'success'
      ? 100
      : Math.max(lastTaskProgress, calculatedProgress);
    return {
      ...partial,
      progress: lastTaskProgress,
      progress_detail: progressDetail,
    };
  }

  function updateTask(partial = {}, workspaceState, eventPatch, options) {
    return updateManagedTask(buildTaskUpdate(partial), workspaceState, eventPatch, options);
  }

  function checkpointTask(partial = {}, workspacePartial, eventPatch) {
    return checkpointManagedTask(buildTaskUpdate(partial), workspacePartial, eventPatch);
  }

  const developerLogger = createContentDeveloperLogger(aiService, {
    name: targetItemId ? `content-generation-${targetItemId}` : 'content-generation',
    meta: {
      mode: targetItemId ? 'single-section' : 'full',
      target_item_id: targetItemId || '',
      resume,
      regenerate,
      full_regenerate: fullRegenerate,
      retry_content_correction: retryContentCorrection,
      retry_failed_sections: retryFailedSections,
      continue_post_processing: continuePostProcessing,
      leaf_count: leaves.length,
      task_count: tasksToRun.length,
      text_concurrency_limit: contentConcurrency,
      table_requirement: tableRequirement,
      word_control: wordControl,
      original_plan_chars: originalPlanMarkdown.length,
      generation_options: generationOptions,
    },
  });

  function writeDeveloperLog(event, payload = {}) {
    if (!developerLogger.enabled) {
      return;
    }
    try {
      developerLogger.write(event, payload);
    } catch {
      // 调试日志不能影响正文生成主流程。
    }
  }

  function agentErrorDiagnostics(error) {
    return {
      error: error?.message || String(error || '未知错误'),
      name: error?.name || '',
      cause: error?.cause?.message || error?.cause?.code || '',
      stack: error?.stack || '',
      agent_runtime: error?.agentRuntimeId || '',
      agent_task_id: error?.agentTaskId || '',
      agent_title: error?.agentTitle || '',
      agent_workspace_dir: error?.agentWorkspaceDir || '',
      agent_runtime_root: error?.agentRuntimeRoot || '',
      agent_output_file: error?.agentOutputFile || '',
      agent_output_path: error?.agentOutputPath || '',
      agent_partial_output_chars: error?.agentPartialOutputChars || String(error?.agentPartialOutput || '').length,
      agent_validation_failed: Boolean(error?.agentValidationFailed),
      agent_retry_attempts: Array.isArray(error?.agentRetryAttempts) ? error.agentRetryAttempts : [],
      agent_diagnostics: error?.agentDiagnostics || {},
    };
  }

  function isAgentBusyResult(result) {
    return result?.status === 'busy' || result?.skipped === true;
  }

  function createAgentActivityProgressHandler(updateProgress, step, fallbackLabel) {
    let lastKey = '';
    return (event = {}) => {
      const message = String(event.message || '').trim();
      if (!message || event.visible === false) return;
      const key = `${event.stage || ''}:${message}`;
      if (key === lastKey) return;
      lastKey = key;
      logs = [...logs, `Agent 实时进度：${message}`];
      updateProgress(step, message || fallbackLabel);
    };
  }

  async function runAgentTaskWithRecoveredOutput(payload, eventPrefix) {
    function normalizeAgentFilePath(value) {
      return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\/)+/, '').toLowerCase();
    }

    function findSeededOutputContent() {
      const outputPath = normalizeAgentFilePath(payload.output_file || '');
      if (!outputPath) {
        return null;
      }
      const seededOutput = (Array.isArray(payload.files) ? payload.files : [])
        .find((file) => normalizeAgentFilePath(file?.path) === outputPath);
      return seededOutput ? String(seededOutput.content || '') : null;
    }

    try {
      const result = await (ordinaryAgentService || agentService).runTask(payload);
      if (isAgentBusyResult(result)) {
        writeDeveloperLog(`${eventPrefix}.agent.busy`, {
          message: result?.message || 'Agent 正在处理其他任务',
          active_task: result?.active_task || null,
        });
        return result;
      }
      writeDeveloperLog(`${eventPrefix}.agent.done`, {
        agent_runtime: result?.runtime_id || '',
        agent_task_id: result?.task_id || '',
        agent_session_id: result?.session_id || '',
        agent_workspace_dir: result?.workspace_dir || '',
        agent_runtime_root: result?.runtime_root || '',
        output_file: result?.output_file || '',
        output_metrics: textMetrics(result?.output_content || ''),
        agent_diagnostics: result?.diagnostics || {},
      });
      return result;
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        throw error;
      }
      const diagnostics = agentErrorDiagnostics(error);
      writeDeveloperLog(`${eventPrefix}.agent.error`, diagnostics);
      if (error?.agentValidationFailed) {
        throw error;
      }
      const recoveredOutput = String(error?.agentPartialOutput || '').trim();
      if (!recoveredOutput) {
        throw error;
      }
      const seededOutputContent = findSeededOutputContent();
      if (seededOutputContent !== null
        && normalizeNewlines(recoveredOutput).trim() === normalizeNewlines(seededOutputContent).trim()) {
        writeDeveloperLog(`${eventPrefix}.output.recovered_rejected`, {
          ...diagnostics,
          reason: 'same_as_seeded_output',
          output_metrics: textMetrics(recoveredOutput),
        });
        throw error;
      }
      writeDeveloperLog(`${eventPrefix}.output.recovered`, {
        ...diagnostics,
        output_metrics: textMetrics(recoveredOutput),
      });
      return {
        success: true,
        recovered: true,
        runtime_id: error?.agentRuntimeId || '',
        task_id: error?.agentTaskId || '',
        title: error?.agentTitle || payload.title || 'Agent 任务',
        workspace_dir: error?.agentWorkspaceDir || '',
        runtime_root: error?.agentRuntimeRoot || '',
        output_file: error?.agentOutputFile || payload.output_file || '',
        output_content: recoveredOutput,
        assistant_text: '',
        diff: [],
        session_id: '',
        retry_count: diagnostics.agent_retry_attempts.length,
        retry_attempts: diagnostics.agent_retry_attempts,
        diagnostics: diagnostics.agent_diagnostics,
      };
    }
  }

  writeDeveloperLog('content.task.started', {
    sections: leaves.map(({ item }) => ({ id: item.id, title: item.title || '未命名章节' })),
    tasks_to_run: tasksToRun.map(({ item }) => item.id),
  });

  // 持久化并推送正文任务进度，但不重新加载完整技术方案。
  function publishTaskUpdate(partial, eventPatch) {
    updateTask(
      partial,
      { contentGenerationRuntime: contentRuntime },
      eventPatch,
      { skipWorkspaceReload: true },
    );
  }

  function appendDeveloperLog(message) {
    if (!developerModeEnabled) {
      return;
    }
    logs = [...logs, message];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  const knowledgeReferences = loadContentKnowledgeReferences(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });
  knowledgeItems = knowledgeReferences.items;
  allowedKnowledgeItemIds = new Set(knowledgeItems.map((item) => item.id));

  function updateContentAgentState(partial = {}, persist = true) {
    contentAgentState = {
      ...(contentAgentState || {}),
      task_key: CONTENT_PLANNING_AGENT_TASK_KEY,
      ...partial,
    };
    if (persist) {
      checkpointTask({ status: 'running', logs, stats: statsSnapshot() });
    }
  }

  // 完整目录只作上下文，持久 Agent 仅编排并返回本次目标节点。
  async function runContentPlanningAgent(targetItemIds, regenerateTargetItemIds = targetItemIds) {
    const hasSession = agentService.hasPersistentTaskSession(CONTENT_PLANNING_AGENT_TASK_KEY);
    const runId = crypto.randomUUID();
    if (hasSession) {
      agentService.updatePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY, {
        run_id: runId,
        status: 'running',
        phase: 'content-planning',
        agent_connection: 'running',
        error: null,
      });
    } else {
      agentService.deletePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY);
    }
    updateContentAgentState({
      run_id: runId,
      status: 'running',
      phase: 'content-planning',
      agent_connection: 'running',
      session_file: hasSession ? contentAgentState?.session_file || '' : '',
    });
    logs = [...logs, `正文编排 Agent 已启动，本次处理 ${targetItemIds.length} 个目录节点。`];
    publishTaskUpdate({ status: 'running', logs, stats: statsSnapshot() });

    const agentResult = await agentService.runTask({
      task_id: runId,
      title: '技术方案正文编排',
      prompt: createContentPlanningPrompt({
        targetItemIds,
        regenerateTargetItemIds,
        regenerateRequirement,
        tableRequirement,
        maxTables,
        totalSections: leaves.length,
      }),
      output_file: CONTENT_PLANNING_OUTPUT_FILE,
      files: [
        { path: CONTENT_PLANNING_KNOWLEDGE_FILE, content: renderKnowledgeItemsForPrompt(knowledgeItems) },
        { path: CONTENT_PLANNING_BID_INFO_FILE, content: formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText) },
        {
          path: CONTENT_PLANNING_OUTPUT_FILE,
          content: JSON.stringify({ outline: buildContentPlanningOutline(outlineData.outline, storedContentPlans) }, null, 2),
        },
      ],
      signal: taskControl.signal,
      persistent_task: {
        task_key: CONTENT_PLANNING_AGENT_TASK_KEY,
        mode: hasSession ? 'resume' : 'create',
      },
      initial_stage: 'content-planning',
      json_validation_schemas: {
        [CONTENT_PLANNING_OUTPUT_FILE]: CONTENT_PLANNING_JSON_SCHEMA,
      },
      max_retries: 0,
      onActivity(event = {}) {
        const title = formatContentPlanningProgress(event.message);
        if (!title || event.visible === false) return;
        const message = `正文编排 Agent：${title}`;
        if (logs[logs.length - 1] !== message) logs = [...logs, message];
        publishTaskUpdate({ status: 'running', logs, stats: statsSnapshot() });
      },
      onCheckpoint(checkpoint = {}) {
        updateContentAgentState({
          status: checkpoint.status,
          phase: checkpoint.phase,
          agent_connection: checkpoint.agent_connection,
          session_file: checkpoint.session_file,
        });
      },
    });

    const plans = extractContentPlanningPlans(
      readContentPlanningJson(agentResult.output_content),
      outlineData.outline,
      allowedKnowledgeItemIds,
      new Set(targetItemIds),
    );
    updateContentAgentState({
      status: 'success',
      phase: 'completed',
      agent_connection: 'idle',
    }, false);
    agentService.updatePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY, {
      status: 'success',
      phase: 'completed',
      agent_connection: 'idle',
      error: null,
      completed_at: now(),
    });
    return plans;
  }

  function getLeafContentForWords(item) {
    const section = sections[item.id];
    if (section?.status === 'ignored') return '';
    return section && Object.prototype.hasOwnProperty.call(section, 'content')
      ? section.content || ''
      : item.content || '';
  }

  const contentWordCounts = new Map();
  let totalContentWords = 0;

  // 更新单个小节字数及全文累计字数。
  function updateContentWordCount(itemId, content) {
    const previousWords = contentWordCounts.get(itemId) || 0;
    const nextWords = countContentWords(content);
    contentWordCounts.set(itemId, nextWords);
    totalContentWords += nextWords - previousWords;
    return nextWords;
  }

  // 正文整体替换后重建内存字数索引。
  function rebuildContentWordCounts() {
    contentWordCounts.clear();
    totalContentWords = 0;
    for (const { item } of leaves) {
      updateContentWordCount(item.id, getLeafContentForWords(item));
    }
  }

  function getLeafWordCount(item) {
    return contentWordCounts.get(item.id) || 0;
  }

  rebuildContentWordCounts();

  function countTotalContentWords() {
    return totalContentWords;
  }

  function leafWordStats() {
    return leaves.map((context) => ({
      ...context,
      content: getLeafContentForWords(context.item),
      words: getLeafWordCount(context.item),
    }));
  }

  function statsSnapshot() {
    contentStats.current_words = countTotalContentWords();
    contentStats.minimum_words = wordControl.minimumWords;
    contentStats.maximum_words = wordControl.maximumWords;
    contentStats.section_words = wordControl.sectionWords;
    contentStats.strict_section_words = wordControl.strictSectionWords;
    contentStats.ignored_section_count = leaves.filter(({ item }) => sections[item.id]?.status === 'ignored').length;
    return {
      ...(contentAgentState ? { agent: { ...contentAgentState } } : {}),
      content: { ...contentStats },
    };
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

  function markStageCompleted(stage, { pauseForDeveloper = true } = {}) {
    const alreadyCompleted = completedStages.has(stage);
    completedStages.add(stage);
    const shouldPauseForDeveloper = developerModeEnabled && pauseForDeveloper && !alreadyCompleted;
    contentStats.phase = stage;
    contentStats.developer_stage_gate = shouldPauseForDeveloper ? stage : undefined;
    if (shouldPauseForDeveloper) {
      logs = [...logs, `${CONTENT_PHASE_LABELS[stage] || stage}阶段已完成，等待开发者继续或从头重新执行。`];
    }
    const runtime = syncRuntime({
      completed_stages: Array.from(completedStages),
      developer_stage_gate: shouldPauseForDeveloper ? stage : '',
    });
    checkpointTask({ status: shouldPauseForDeveloper ? 'paused' : 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    if (shouldPauseForDeveloper) {
      throw createContentGenerationPausedError();
    }
  }

  // 在实际生成入口同步阶段，覆盖全文/单节、首次执行和暂停恢复。
  function startContentGenerationStage() {
    contentStats.phase = 'generating';
    contentStats.developer_stage_gate = undefined;
    const runtime = syncRuntime({ phase: 'generating', developer_stage_gate: '' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
  }

  function isPauseRequested() {
    return Boolean(taskControl?.isPauseRequested?.());
  }

  function persistPausedContentGeneration(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    logs = [...logs, message];
    const runtime = syncRuntime();
    checkpointTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
  }

  // 所有正文请求结束后存在失败时，保存等待用户重试或忽略的稳定状态。
  function persistContentDecisionWait(unresolvedContexts) {
    const unresolvedIds = unresolvedContexts.map(({ item }) => item.id);
    const message = `正文小节生成结束，${unresolvedIds.length} 个小节失败或未完成。请重试失败小节，或确认忽略后继续后续流程。`;
    logs = [...logs, message, `失败或未完成小节：${unresolvedIds.join('、')}。`];
    contentStats.phase = 'generating';
    contentStats.awaiting_content_decision = true;
    contentStats.ignored_section_count = leaves.filter(({ item }) => sections[item.id]?.status === 'ignored').length;
    const runtime = syncRuntime({ phase: 'generating', awaiting_content_decision: true });
    const taskPatch = {
      status: 'error',
      error: message,
      progress: progressFor(leaves, sections),
      logs,
      stats: statsSnapshot(),
      pause_requested: false,
    };
    checkpointTask(taskPatch, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
  }

  function pauseIfRequested(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    if (!isPauseRequested()) {
      return;
    }

    persistPausedContentGeneration(message);
    throw createContentGenerationPausedError();
  }

  async function runContentAgentTask({ title, prompt, outputFile, files, eventPrefix, activityLabel, timeoutMs, startPauseMessage, resultPauseMessage, pausedLogMessage, validateOutput }) {
    if (!agentService?.runTask) {
      writeDeveloperLog(`${eventPrefix}.unavailable`, { title, output_file: outputFile });
      throw new Error(`Agent 服务尚未初始化，无法执行${title}`);
    }

    function updateContentAgentProgress(_step, label) {
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }

    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, `已请求暂停${title}，正在取消本轮 Agent 任务。`];
        updateContentAgentProgress(0, `正在取消${title}，继续后将重新执行`);
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested(startPauseMessage || `正文生成已在${title}开始前暂停，本次 Agent 未启动；继续后将重新执行。`);
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title,
        prompt,
        output_file: outputFile,
        files,
        timeout_ms: timeoutMs || 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: async (agentResult, context) => {
          const outputContent = String(agentResult?.output_content || '').trim();
          if (!outputContent) {
            throw new Error(`Agent 未返回 ${outputFile}`);
          }
          if (typeof validateOutput === 'function') {
            return validateOutput(agentResult, context);
          }
          return null;
        },
        onActivity: createAgentActivityProgressHandler(updateContentAgentProgress, 0, activityLabel || title),
      }, eventPrefix);
      if (isAgentBusyResult(agentResult)) {
        writeDeveloperLog(`${eventPrefix}.busy`, { active_task: agentResult?.active_task || null });
        throw new Error(`Agent 正在处理其他任务，无法执行${title}`);
      }
      pauseIfRequested(resultPauseMessage || `正文生成已在${title}结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。`);

      const outputContent = String(agentResult?.output_content || '').trim();
      if (!outputContent) {
        writeDeveloperLog(`${eventPrefix}.empty_output`, { agent_result: agentResult, output_file: outputFile });
        throw new Error(`Agent 未返回 ${outputFile}`);
      }
      return { agentResult, outputContent };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        logs = [...logs, pausedLogMessage || `${title}已暂停：本轮 Agent 已取消并清理，继续后将重新执行。`];
        writeDeveloperLog(`${eventPrefix}.paused`, {
          title,
          output_file: outputFile,
          error: error.message || String(error),
        });
        updateContentAgentProgress(0, `${title}已暂停，继续后将重新执行`);
        pauseIfRequested(`正文生成已在${title}阶段暂停，本次 Agent 已取消；继续后将重新执行。`);
      }
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  function rememberTouchedItem(itemId) {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  const initialRuntime = syncRuntime();
  const initialIllustrationPatch = runOnlyIllustrationGeneration || completedStages.has('illustration-planning') || targetItemId ? {} : { contentIllustrationPlan: undefined };
  checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    ...initialIllustrationPatch,
    contentGenerationRuntime: initialRuntime,
    referenceKnowledgeDocumentIds,
  }, {
    contentRuntime: initialRuntime,
    technicalPlanPatch: {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      ...initialIllustrationPatch,
      contentGenerationRuntime: initialRuntime,
      referenceKnowledgeDocumentIds,
    },
  });

  if (!tasksToRun.length && !runOnlyIllustrationStage) {
    logs = [...logs, retryContentCorrection
      ? '正文已全部生成，将直接重试内容矫正和后续处理。'
      : continuePostProcessing ? '正文已全部生成，将执行内容复核和字数控制。' : '本次没有待生成的 AI 小节。'];
  }

  // 原图属于已有方案，保存任何后续改写前核对引用，失败时不覆盖旧正文。
  function validateSectionOriginalImages(itemId, content) {
    if (!hasOriginalPlan || !originalSource.images.length) return;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan;
    const material = plan?.original_material;
    const originalContent = material?.source_hash === originalPlanSourceHash
      ? (material.source_ranges || []).map(range => readOriginalRange(originalSource, range)).join('\n\n')
      : sections[itemId]?.content || '';
    validateOriginalImages(originalImageReferences(originalContent), content, originalSource.images);
  }

  function saveSection(item, partial, contentForOutline, taskPartial = {}) {
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeLeafContentForSave(nextPartial.content, item);
    }
    const currentOutlineData = outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeLeafContentForSave(contentForOutline ?? nextPartial.content ?? sections[item.id]?.content ?? '', item)
      : (sections[item.id]?.content || '');
    if (hasOutlineContent || hasPartialContent) validateSectionOriginalImages(item.id, outlineContent);
    sections = withSection(sections, item, nextPartial);
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    if (hasOutlineContent || hasPartialContent) {
      updateContentWordCount(item.id, outlineContent);
    }
    const runtime = syncRuntime();
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, {
      contentGenerationItem: {
        nodeId: item.id,
        section: sections[item.id],
        runtime,
      },
    }, {
      contentSection: sections[item.id],
      contentRuntime: runtime,
    });
    return sections[item.id];
  }

  function getStoredContentPlan(itemId) {
    return normalizeStoredContentPlan(storedContentPlans[itemId]);
  }

  function applyCurrentTableRequirementToPlan(plan) {
    const normalizedPlan = normalizeContentPlan(plan, allowedKnowledgeItemIds);
    return tableRequirement === 'none' ? clearContentPlanTable(normalizedPlan) : normalizedPlan;
  }

  function getReusableStoredContentPlan(itemId) {
    const storedContentPlan = getStoredContentPlan(itemId);
    if (!storedContentPlan || !isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement)) {
      return null;
    }
    return {
      ...storedContentPlan,
      plan: applyCurrentTableRequirementToPlan(storedContentPlan.plan),
    };
  }

  function getContentPlanForItem(itemId) {
    const plan = contentPlans.get(itemId) || getReusableStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds);
    contentPlans.set(itemId, plan);
    return plan;
  }

  // 后续扩写与覆盖检查读取当前原文范围；不复用或重建旧分段记录。
  function getOriginalMaterialRuntimeState(itemOrId) {
    if (!hasOriginalPlan) return { needsOptimization: false, needsRestoreRepair: false };
    const itemId = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    const item = typeof itemOrId === 'string' ? leaves.find(context => context.item.id === itemId)?.item : itemOrId;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan || {};
    const originalMaterial = normalizeOriginalMaterial(plan.original_material);
    const content = sections[itemId]?.content || item?.content || '';
    const validRestored = Boolean(originalMaterial.restored && originalMaterial.source_hash === originalPlanSourceHash
      && originalMaterial.source_ranges.length && String(content).trim());
    return {
      plan, originalMaterial, content, validRestored,
      needsRestoreRepair: Boolean(originalMaterial.restored && !validRestored),
      needsOptimization: Boolean(validRestored && !originalMaterial.optimized),
    };
  }

  function saveSectionAndContentPlan(item, partial, contentForOutline, plan, taskPartial = {}, { preserveOriginal = false } = {}) {
    // 还原底稿已经逐字校验，保存时保留原文标题和表格格式。
    const normalizeContent = preserveOriginal ? value => String(value ?? '') : value => normalizeLeafContentForSave(value, item);
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeContent(nextPartial.content);
    }
    const currentOutlineData = outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeContent(contentForOutline ?? nextPartial.content ?? sections[item.id]?.content ?? '')
      : (sections[item.id]?.content || '');
    if (!preserveOriginal && (hasOutlineContent || hasPartialContent)) validateSectionOriginalImages(item.id, outlineContent);
    sections = withSection(sections, item, nextPartial);
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    contentPlans.set(item.id, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(plan, tableRequirement),
    }, leaves);
    if (hasOutlineContent || hasPartialContent) {
      updateContentWordCount(item.id, outlineContent);
    }
    const runtime = syncRuntime();
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, {
      contentGenerationItem: {
        nodeId: item.id,
        section: sections[item.id],
        storedPlan: storedContentPlans[item.id],
        runtime,
      },
    }, {
      contentSection: sections[item.id],
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
    return sections[item.id];
  }

  // 只更新本轮目标；全文评分用于判定目标配图，其他节点的标记与时间保持原样。
  function persistContentPlans(targets, generatedPlans) {
    const nextPlans = { ...storedContentPlans };
    for (const { item } of targets) {
      const contentPlan = contentPlans.get(item.id) || generatedPlans.get(item.id);
      if (!contentPlan) throw new Error(`正文编排结果缺少目标节点：${item.id}`);
      const originalMaterial = storedContentPlans[item.id]?.plan?.original_material;
      nextPlans[item.id] = createStoredContentPlan({
        ...contentPlan,
        ...(originalMaterial ? { original_material: originalMaterial } : {}),
      }, tableRequirement);
    }
    const selectedImageIds = selectContentImageTargets(leaves, nextPlans, imageQuantity);
    for (const { item } of targets) {
      const plan = { ...nextPlans[item.id].plan, image_needed: selectedImageIds.has(item.id) };
      nextPlans[item.id] = { ...nextPlans[item.id], plan, updated_at: now() };
      contentPlans.set(item.id, plan);
    }
    logs = [...logs, `本次 ${targets.length} 个小节的编排及配图标记已保存。`];
    storedContentPlans = pruneContentGenerationPlans(nextPlans, leaves);
    const runtime = syncRuntime();
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return storedContentPlans;
  }

  async function planAll() {
    refreshRunLimits(tasksToRun);
    contentStats.phase = 'planning';
    contentStats.planning_total = tasksToRun.length;
    const planningTargets = [];
    for (const context of tasksToRun) {
      const storedContentPlan = getReusableStoredContentPlan(context.item.id);
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
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

    const missingPlanItemIds = planningTargets.map(({ item }) => item.id);
    let generatedPlans = new Map();
    if (missingPlanItemIds.length) {
      generatedPlans = await runContentPlanningAgent(missingPlanItemIds);
      for (const { item } of planningTargets) {
        let contentPlan = generatedPlans.get(item.id);
        if (!contentPlan) throw new Error(`正文编排结果缺少目标节点：${item.id}`);
        if (tableRequirement === 'none') contentPlan = clearContentPlanTable(contentPlan);
        contentPlans.set(item.id, contentPlan);
      }
    }
    contentStats.planning_completed = tasksToRun.length;
    const tableCandidates = planningTargets.filter(({ item }) => contentPlans.get(item.id)?.table.needed);
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

    logs = [...logs, `整体编排完成：表格候选 ${tableCandidates.length} 个，${runLimits.maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}。`];
    persistContentPlans(planningTargets, generatedPlans);
    pauseIfRequested('正文生成已在编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  // 仅在还原结束时统计全文有效来源，重复引用同一原文段只计一次。
  // 保存完成后统一统计全文来源；日常进度快照不重复扫描。
  function updateOriginalRestorationStats() {
    if (!hasOriginalPlan) return;
    const ranges = leaves.flatMap(({ item }) => {
      const state = getOriginalMaterialRuntimeState(item);
      return state.validRestored ? state.originalMaterial.source_ranges : [];
    });
    contentStats.original_restoration = calculateOriginalRestoration(originalSource, ranges, originalPlanSourceHash);
  }

  // 未完成的还原阶段直接执行 Agent；完成后由流程阶段标记跳过，保护已扩写正文。
  async function restoreOriginalMaterialsIfNeeded(targets) {
    if (!hasOriginalPlan || !targets?.length || completedStages.has('restoring')) return;
    const allowedNodeIds = new Set(targets.map(({ item }) => item.id));
    const coveredRanges = leaves.filter(({ item }) => !allowedNodeIds.has(item.id)).flatMap(({ item }) => {
      const state = getOriginalMaterialRuntimeState(item);
      return state.validRestored ? state.originalMaterial.source_ranges.map(range => ({ ...range, node_id: item.id })) : [];
    });
    contentStats.phase = 'restoring';
    contentStats.restoration_total = targets.length;
    contentStats.restoration_completed = 0;
    logs = [...logs, `开始原方案还原：完整原方案交由 Agent 分析，${targets.length} 个候选小节。`];
    const runtime = syncRuntime({ phase: 'restoring' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    const validationContext = { source: originalSource, allowedNodeIds, coveredRanges };
    writeDeveloperLog('original_restore.agent.start', { target_count: targets.length, original_plan_chars: originalPlanMarkdown.length });
    pauseIfRequested('原方案还原尚未启动，继续后将创建或恢复持久会话。');
    const resumeSession = resume && agentService.hasPersistentTaskSession(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
    const runId = crypto.randomUUID();
    if (resumeSession) {
      agentService.updatePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY, {
        run_id: runId, status: 'running', phase: 'restoring', agent_connection: 'running', error: null,
      });
    }
    updateContentAgentState({
      task_key: ORIGINAL_RESTORATION_AGENT_TASK_KEY, run_id: runId,
      status: 'running', phase: 'restoring', agent_connection: 'running',
      session_file: resumeSession ? agentService.loadPersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY).state.session_file : '',
    });
    const controller = new AbortController();
    // 暂停取消本轮执行，但 Pi 会保留工作区和 Session，供下次继续。
    const abortOnPause = () => {
      if (isPauseRequested() && !controller.signal.aborted) controller.abort(createContentGenerationPausedError());
    };
    const pauseWatcher = setInterval(abortOnPause, 1000);
    let agentResult;
    try {
      abortOnPause();
      const restorationFiles = buildOriginalRestorationFiles({
        source: originalSource,
        targetsText: formatRestoreTargetsForPrompt(targets),
        contextText: `${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}\n\n全局事实变量标题：\n${globalFactTitlesText || '未提供'}`,
        coveredRanges,
      });
      const numberedPartPaths = restorationFiles
        .filter(file => file.path.startsWith('original-plan-numbered-part-'))
        .map(file => file.path);
      agentResult = await agentService.runTask({
        task_id: runId,
        title: '原方案正文还原 Agent',
        primary_session: true,
        summary_enabled: false,
        prompt: buildOriginalRestorationPrompt({ resume: resumeSession, numberedPartPaths }),
        output_file: 'original-restore-result.json',
        files: restorationFiles,
        signal: AbortSignal.any([taskControl.signal, controller.signal]),
        timeout_ms: 30 * 60 * 1000,
        persistent_task: { task_key: ORIGINAL_RESTORATION_AGENT_TASK_KEY, mode: resumeSession ? 'resume' : 'create' },
        initial_stage: 'restoring',
        json_validation_schemas: { 'original-restore-result.json': ORIGINAL_RESTORATION_JSON_SCHEMA },
        auto_validate_json: true,
        max_retries: 1,
        validateOutput: result => validateOriginalRestoration(parseAgentJsonContent(result?.output_content), validationContext),
        onActivity: createAgentActivityProgressHandler(() => {
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        }, 0, 'Agent 正在按语义还原完整原方案'),
        onCheckpoint(checkpoint = {}) {
          updateContentAgentState({
            task_key: ORIGINAL_RESTORATION_AGENT_TASK_KEY,
            status: checkpoint.status, phase: checkpoint.phase,
            agent_connection: checkpoint.agent_connection, session_file: checkpoint.session_file,
          });
        },
      });
      abortOnPause();
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      const paused = isPauseRequested() || isPauseLikeError(error);
      updateContentAgentState({
        task_key: ORIGINAL_RESTORATION_AGENT_TASK_KEY,
        status: paused ? 'paused' : 'error', agent_connection: 'idle',
      }, false);
      writeDeveloperLog('original_restore.agent.error', agentErrorDiagnostics(error));
      if (paused) {
        if (agentService.hasPersistentTaskSession(ORIGINAL_RESTORATION_AGENT_TASK_KEY)) {
          agentService.updatePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY, { status: 'paused', agent_connection: 'idle' });
        }
        persistPausedContentGeneration('原方案还原已暂停，工作区和 Session 已保留，继续后从原会话接着处理。');
        throw createContentGenerationPausedError();
      }
      throw error;
    } finally {
      clearInterval(pauseWatcher);
    }
    const outputContent = String(agentResult.output_content || '');
    // 持久会话返回的结果也须通过现有原文完整性检查后才能写入业务正文。
    const result = validateOriginalRestoration(parseAgentJsonContent(outputContent), validationContext);
    writeDeveloperLog('original_restore.agent.validated', {
      assignment_count: result.assignments.length,
      unassigned: result.unassigned,
      agent_task_id: agentResult?.task_id || '',
      agent_session_id: agentResult?.session_id || '',
      output_metrics: textMetrics(outputContent),
    });
    const assignments = new Map(result.assignments.map(assignment => [assignment.node_id, assignment]));
    for (const { item } of targets) {
      const assignment = assignments.get(item.id);
      const plan = getContentPlanForItem(item.id);
      contentStats.restoration_completed += 1;
      const content = assignment ? assignment.content.replace(/\r\n?/g, '\n').trim() : '';
      saveSectionAndContentPlan(item, { status: 'idle', content, error: undefined }, content, {
        ...plan,
        original_material: normalizeOriginalMaterial({
          restored: Boolean(assignment), optimized: false,
          source_hash: originalPlanSourceHash,
          source_ranges: assignment?.source_ranges || [],
          restored_words: countReadableWords(content), restored_at: now(),
        }),
      }, { logs }, { preserveOriginal: true });
    }
    updateOriginalRestorationStats();
    agentService.updatePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY, {
      status: 'success', phase: 'completed', agent_connection: 'idle', error: null, completed_at: now(),
    });
    updateContentAgentState({
      task_key: ORIGINAL_RESTORATION_AGENT_TASK_KEY, status: 'success', phase: 'completed', agent_connection: 'idle',
    }, false);
    logs = [...logs, `原方案还原完成：已还原 ${result.assignments.length} 个小节，未还原范围 ${result.unassigned.length} 处，还原率 ${contentStats.original_restoration.rate?.toFixed(1) ?? '—'}%。`];
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  async function prepareSingleSectionPlan() {
    const context = tasksToRun[0];
    const previousOriginalMaterial = getOriginalMaterialRuntimeState(context.item).originalMaterial;
    const resumedPlan = resume && Number(storedPlan.contentGenerationTask?.stats?.content?.planning_completed || 0) >= 1
      ? getReusableStoredContentPlan(context.item.id)
      : null;
    contentStats.phase = 'planning';
    contentStats.planning_total = 1;
    contentStats.planning_completed = 0;
    contentStats.generation_total = 1;

    if (resumedPlan) {
      contentPlans.set(context.item.id, resumedPlan.plan);
      contentStats.planning_completed = 1;
      logs = [...logs, `继续当前小节任务，复用本次任务已完成的编排：${context.item.id} ${context.item.title || '未命名章节'}。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      contentStats.phase = 'generating';
      return;
    }

    logs = [...logs, `开始重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    const targetIds = [context.item.id];
    const generatedPlans = await runContentPlanningAgent(targetIds, [context.item.id]);
    let contentPlan = generatedPlans.get(context.item.id);
    if (!contentPlan) throw new Error(`正文编排结果缺少目标节点：${context.item.id}`);
    if (tableRequirement === 'none') contentPlan = clearContentPlanTable(contentPlan);
    if (previousOriginalMaterial?.restored || previousOriginalMaterial?.source_ranges?.length) {
      contentPlan = { ...contentPlan, original_material: previousOriginalMaterial };
    }
    contentPlans.set(context.item.id, contentPlan);
    contentStats.planning_completed = 1;
    persistContentPlans([context], generatedPlans);
    pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
    logs = [...logs, `当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}。`];

    pauseIfRequested('正文生成已在小节编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  // 正文生成只产出持久工作区内的 HTML 文件，本轮结束于此，不写回 Markdown 正文。
  async function runContentGeneration(targets) {
    const controller = new AbortController();
    const abortOnPause = () => {
      if (isPauseRequested() && !controller.signal.aborted) controller.abort(createContentGenerationPausedError());
    };
    const watcher = setInterval(abortOnPause, 500);
    contentStats.generation_total = targets.length;
    contentStats.generation_completed = 0;
    try {
      abortOnPause();
      const result = await runContentGenerationAgent({
        agentService, aiService, resume: resume || retryFailedSections,
        hasKnowledgeBase: referenceKnowledgeDocumentIds.length > 0,
        signal: AbortSignal.any([taskControl.signal, controller.signal]),
        buildFiles: () => buildContentGenerationFiles({
          outline: outlineData.outline, targets, plans: storedContentPlans,
          projectOverview, globalFacts, globalFactsMode, wordControl,
          generationOptions: storedPlan.contentGenerationOptions,
          requirement: regenerateRequirement,
          template: templateStore.getTemplate(storedPlan.exportTemplateId),
          knowledgeBaseService, documentIds: referenceKnowledgeDocumentIds,
        }),
        onCheckpoint: checkpoint => updateContentAgentState(checkpoint),
        onActivity(event = {}) {
          if (event.visible === false || !event.message) return;
          publishTaskUpdate({ status: 'running', logs: [...logs, `正文生成 Agent：${event.message}`], stats: statsSnapshot() });
        },
        onProgress(result) {
          contentStats.generation_completed = result.completed;
          logs = [...logs, `正文文件已保存：${result.section_id}，${result.words} 字（${result.completed}/${result.total}）。`];
          publishTaskUpdate({ status: 'running', logs, stats: statsSnapshot() });
        },
      });
      abortOnPause();
      controller.signal.throwIfAborted();
      contentStats.generation_completed = result.sections.length;
      contentStats.generated_html_words = result.sections.reduce((sum, section) => sum + section.words, 0);
      contentStats.generated_html_workspace = result.workspaceDir;
      updateContentAgentState({ task_key: CONTENT_GENERATION_AGENT_TASK_KEY, status: 'success', agent_connection: 'idle' }, false);
      logs = [...logs, `正文 HTML 文件生成完成，共 ${result.sections.length} 节、${contentStats.generated_html_words} 字。`, `输出目录：${result.workspaceDir}`, '本轮仅生成文件，未进入后续处理。'];
      const runtime = syncRuntime({ phase: 'generating', developer_stage_gate: '' });
      checkpointTask({ status: 'success', progress: 100, logs, stats: statsSnapshot(), pause_requested: false }, {
        contentGenerationRuntime: runtime,
      }, { contentRuntime: runtime });
    } catch (error) {
      const paused = isPauseRequested() || isPauseLikeError(error);
      updateContentAgentState({ task_key: CONTENT_GENERATION_AGENT_TASK_KEY, status: paused ? 'paused' : 'error', agent_connection: 'idle' }, false);
      if (paused) {
        if (agentService.hasPersistentTaskSession(CONTENT_GENERATION_AGENT_TASK_KEY)) {
          agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'paused', agent_connection: 'idle' });
        }
        persistPausedContentGeneration('正文生成已暂停，已完成的 HTML 文件和 Agent 会话已保留，继续后接着生成。');
        throw createContentGenerationPausedError();
      }
      throw error;
    } finally {
      clearInterval(watcher);
    }
  }

  function setWordAdjustmentRuntime(stage, itemId = '', round = 0, completedItemIds = [], itemRounds = {}, noProgressRounds = 0, roundStartWords = 0) {
    const runtime = syncRuntime({
      word_adjustment_stage: stage,
      word_adjustment_item_id: itemId,
      word_adjustment_round: round,
      word_adjustment_item_rounds: itemRounds,
      word_adjustment_completed_item_ids: completedItemIds,
      word_adjustment_no_progress_rounds: noProgressRounds,
      word_adjustment_round_start_words: roundStartWords,
    });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
  }

  async function requestWordAdjustment(context, options) {
    const { item } = context;
    const currentContent = getLeafContentForWords(item);
    const currentWords = getLeafWordCount(item);
    const selectedFactsText = resolveSelectedFactsText(getContentPlanForItem(item.id), globalFacts);
    pauseIfRequested('正文生成已在字数调整请求前暂停，继续后将重新执行本轮。');
    const adjustment = await aiService.collectJsonResponse({
      messages: buildWordAdjustmentMessages({
        context,
        currentContent,
        currentWords,
        targetWords: options.targetWords,
        mode: options.mode,
        granularity: options.granularity,
        selectedFactsText,
        maximumChangeWords: options.maximumChangeWords,
        totalRemainingWords: options.totalRemainingWords,
        totalWords: targetItemId ? undefined : countTotalContentWords(),
        minimumWords: targetItemId ? 0 : wordControl.minimumWords,
        maximumWords: targetItemId ? 0 : wordControl.maximumWords,
        globalFactsMode,
      }),
      logTitle: `正文${options.mode === 'expand' ? '扩写' : '缩写'}-${item.id}-${item.title || '未命名章节'}`,
      progressLabel: '正文字数调整',
      failureMessage: '模型返回的正文字数调整结果格式无效',
      max_retries: 0,
      normalizer: normalizeWordAdjustmentResponse,
      validator: (value) => {
        validateWordAdjustmentResponse(value);
        if (value.mode !== options.mode || value.granularity !== options.granularity) {
          throw new Error('模型返回的调整方向或粒度与当前要求不一致');
        }
      },
      repairMessagesBuilder: (repairContext) => buildWordAdjustmentRepairMessages(repairContext, options.mode, options.granularity, currentContent),
    });
    pauseIfRequested('正文生成已在字数调整结果应用前暂停，继续后将重新执行本轮。');
    const nextContent = normalizeLeafContentForSave(applyWordAdjustmentOperations(currentContent, adjustment), item);
    const nextWords = countContentWords(nextContent);
    if (nextWords <= 0) throw new Error('字数调整后正文没有有效可读内容');
    if (options.mode === 'expand' && nextWords <= currentWords) throw new Error('扩写后字数没有增加');
    if (options.mode === 'shrink' && nextWords >= currentWords) throw new Error('缩写后字数没有减少');
    if (Math.abs(nextWords - currentWords) > options.maximumChangeWords) {
      throw new Error('本轮实际调整字数超过允许额度');
    }
    if (Math.abs(nextWords - options.targetWords) >= Math.abs(currentWords - options.targetWords)) {
      throw new Error('字数调整后与目标的差距没有缩小');
    }
    if (options.enforceSectionBounds && wordControl.strictSectionWords) {
      if (nextWords < wordControl.sectionMinimumWords || nextWords > wordControl.sectionMaximumWords) {
        throw new Error('本轮调整会使小节超出强控范围');
      }
    }
    if (options.enforceTotalBounds !== false) {
      const nextTotalWords = countTotalContentWords() - currentWords + nextWords;
      if (wordControl.maximumWords > 0 && options.mode === 'expand' && nextTotalWords > wordControl.maximumWords) {
        throw new Error('本轮扩写会使全文超过最多字数');
      }
      if (wordControl.minimumWords > 0 && options.mode === 'shrink' && nextTotalWords < wordControl.minimumWords) {
        throw new Error('本轮缩写会使全文低于最少字数');
      }
    }
    rememberTouchedItem(item.id);
    saveSection(item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
    return { currentWords, nextWords };
  }

  function isSectionWordsOutsideRange(words) {
    return wordControl.strictSectionWords
      && (words < wordControl.sectionMinimumWords || words > wordControl.sectionMaximumWords);
  }

  async function adjustSectionToRange(context, stage, itemRounds, completedItemIds) {
    const { item } = context;
    let rounds = Math.min(MAX_WORD_ADJUSTMENT_ROUNDS, Math.max(0, Number(itemRounds[item.id]) || 0));
    while (rounds < MAX_WORD_ADJUSTMENT_ROUNDS) {
      const currentWords = getLeafWordCount(item);
      if (!isSectionWordsOutsideRange(currentWords)) return true;
      rounds += 1;
      const mode = currentWords < wordControl.sectionMinimumWords ? 'expand' : 'shrink';
      const differenceRatio = Math.abs(currentWords - wordControl.sectionWords) / wordControl.sectionWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      contentStats.section_adjustment_item_id = item.id;
      contentStats.section_adjustment_round = rounds;
      itemRounds[item.id] = rounds - 1;
      setWordAdjustmentRuntime(stage, item.id, rounds - 1, completedItemIds, itemRounds);
      logs = [...logs, `调整小节字数：${item.id} ${item.title || '未命名章节'}，第 ${rounds}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮，当前 ${currentWords} 字。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      try {
        await requestWordAdjustment(context, {
          mode,
          granularity,
          targetWords: wordControl.sectionWords,
          maximumChangeWords: Math.abs(currentWords - wordControl.sectionWords),
          enforceSectionBounds: false,
          enforceTotalBounds: !targetItemId,
        });
      } catch (error) {
        if (isPauseLikeError(error)) throw error;
        logs = [...logs, `小节字数第 ${rounds} 轮调整未应用：${item.id}，${error.message || String(error)}。`];
      }
      itemRounds[item.id] = rounds;
      setWordAdjustmentRuntime(stage, item.id, rounds, completedItemIds, itemRounds);
      pauseIfRequested('正文生成已在字数调整结果处理后暂停，可稍后继续。');
    }
    return !isSectionWordsOutsideRange(getLeafWordCount(item));
  }

  async function runSectionWordAdjustments(targets, stage) {
    if (!wordControl.strictSectionWords) return [];
    const candidates = (targets || []).filter(({ item }) => sections[item.id]?.status === 'success' && getLeafWordCount(item) > 0);
    const violations = candidates.filter(({ item }) => isSectionWordsOutsideRange(getLeafWordCount(item)));
    const resumingStage = resume && contentRuntime.word_adjustment_stage === stage;
    const completedItemIds = resumingStage ? [...contentRuntime.word_adjustment_completed_item_ids] : [];
    const completedItemIdSet = new Set(completedItemIds);
    const itemRounds = resumingStage ? { ...contentRuntime.word_adjustment_item_rounds } : {};
    const activeItemIds = new Set();
    const pendingViolations = violations.filter(({ item }) => !completedItemIdSet.has(item.id));
    contentStats.phase = stage === 'final-section' ? 'final-section-word-adjusting' : 'section-word-adjusting';
    contentStats.section_adjustment_total = completedItemIds.length + pendingViolations.length;
    contentStats.section_adjustment_completed = completedItemIds.length;
    contentStats.section_adjustment_active_count = 0;
    if (!resumingStage) setWordAdjustmentRuntime(stage, '', 0, completedItemIds, itemRounds);
    const unresolved = new Set(violations.filter(({ item }) => completedItemIdSet.has(item.id)).map(({ item }) => item.id));
    await runItemsWithWorkerPool(pendingViolations, contentConcurrency, async (context) => {
      activeItemIds.add(context.item.id);
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_item_id = context.item.id;
      contentStats.section_adjustment_round = Number(itemRounds[context.item.id]) || 0;
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

      if (!await adjustSectionToRange(context, stage, itemRounds, completedItemIds)) unresolved.add(context.item.id);
      completedItemIds.push(context.item.id);
      completedItemIdSet.add(context.item.id);
      activeItemIds.delete(context.item.id);
      const nextActiveItemId = activeItemIds.values().next().value || '';
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_completed = completedItemIds.length;
      contentStats.section_adjustment_item_id = nextActiveItemId;
      contentStats.section_adjustment_round = nextActiveItemId ? Number(itemRounds[nextActiveItemId]) || 0 : 0;
      setWordAdjustmentRuntime(stage, nextActiveItemId, contentStats.section_adjustment_round, completedItemIds, itemRounds);
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }, isPauseRequested);
    contentStats.section_adjustment_item_id = '';
    contentStats.section_adjustment_round = 0;
    contentStats.section_adjustment_active_count = 0;
    return [...unresolved];
  }

  function getTotalWordDirection() {
    if (!wordControl.minimumWords && !wordControl.maximumWords) return null;
    const currentWords = countTotalContentWords();
    if (wordControl.minimumWords > 0 && currentWords < wordControl.minimumWords) {
      return { mode: 'expand', currentWords, targetWords: wordControl.minimumWords };
    }
    if (wordControl.maximumWords > 0 && currentWords > wordControl.maximumWords) {
      return { mode: 'shrink', currentWords, targetWords: wordControl.maximumWords };
    }
    return null;
  }

  // 扩写先按小节指导缺口分配，剩余额度再均摊；3000 仅是 sectionWords 为 0 时的内部指导值，不构成小节上限。
  function buildTotalWordExpansionBatch(selected, direction) {
    const guidanceWords = wordControl.sectionWords > 0 ? wordControl.sectionWords : DEFAULT_SECTION_WORD_GUIDANCE;
    const entries = selected.map((candidate, index) => {
      const capacity = wordControl.strictSectionWords
        ? Math.max(0, wordControl.sectionMaximumWords - candidate.words)
        : Number.POSITIVE_INFINITY;
      return {
        context: candidate,
        index,
        guidanceWords,
        guidanceGap: Math.min(Math.max(0, guidanceWords - candidate.words), capacity),
        capacity,
        budget: 0,
      };
    });
    let unallocatedWords = Math.abs(direction.currentWords - direction.targetWords);
    const totalGuidanceGap = entries.reduce((sum, entry) => sum + entry.guidanceGap, 0);
    const guidanceBudget = Math.min(unallocatedWords, totalGuidanceGap);

    if (guidanceBudget > 0 && totalGuidanceGap > 0) {
      const allocations = entries.map((entry) => {
        const rawBudget = (guidanceBudget * entry.guidanceGap) / totalGuidanceGap;
        return {
          entry,
          budget: Math.floor(rawBudget),
          remainder: rawBudget - Math.floor(rawBudget),
        };
      });
      let remainderWords = guidanceBudget - allocations.reduce((sum, allocation) => sum + allocation.budget, 0);
      const remainderOrder = [...allocations]
        .filter((allocation) => allocation.budget < allocation.entry.guidanceGap)
        .sort((left, right) => right.remainder - left.remainder || left.entry.index - right.entry.index);
      for (const allocation of remainderOrder) {
        if (remainderWords <= 0) break;
        allocation.budget += 1;
        remainderWords -= 1;
      }
      for (const allocation of allocations) {
        allocation.entry.budget = allocation.budget;
      }
      unallocatedWords -= guidanceBudget;
    }

    while (unallocatedWords > 0) {
      const available = entries.filter((entry) => entry.budget < entry.capacity);
      if (!available.length) break;
      const fairShare = Math.ceil(unallocatedWords / available.length);
      let allocatedThisPass = 0;
      for (const entry of available) {
        const capacity = entry.capacity - entry.budget;
        const addition = Math.max(0, Math.min(unallocatedWords, fairShare, capacity));
        if (addition <= 0) continue;
        entry.budget += addition;
        unallocatedWords -= addition;
        allocatedThisPass += addition;
      }
      if (!allocatedThisPass) break;
    }

    return entries
      .filter((entry) => entry.budget > 0)
      .map(({ context, budget, guidanceWords: itemGuidanceWords }) => ({
        context,
        budget,
        guidanceWords: itemGuidanceWords,
      }));
  }

  // 强控缩写限制单次最多减少 25%；非强控只受全文差额和正文可读空间限制。
  function buildTotalWordShrinkBatch(selected, direction) {
    let unallocatedWords = Math.abs(direction.currentWords - direction.targetWords);
    const batch = [];
    for (let index = 0; index < selected.length && unallocatedWords > 0; index += 1) {
      const candidate = selected[index];
      const remainingSlots = selected.length - index;
      const fairShare = Math.ceil(unallocatedWords / remainingSlots);
      const ratioCapacity = Math.max(1, Math.floor(candidate.words * TOTAL_WORD_SHRINK_SECTION_RATIO));
      const readableCapacity = Math.max(0, candidate.words - 1);
      const sectionCapacity = wordControl.strictSectionWords
        ? Math.min(ratioCapacity, candidate.words - wordControl.sectionMinimumWords, readableCapacity)
        : readableCapacity;
      const budget = Math.max(0, Math.min(unallocatedWords, fairShare, sectionCapacity));
      if (budget <= 0) continue;
      batch.push({ context: candidate, budget, guidanceWords: 0 });
      unallocatedWords -= budget;
    }
    return batch;
  }

  // 每轮最多选择十个小节，批次总预算不超过当前全文差额。
  function buildTotalWordAdjustmentBatch(candidates, direction, slotCount) {
    const selected = candidates.slice(0, slotCount);
    return direction.mode === 'expand'
      ? buildTotalWordExpansionBatch(selected, direction)
      : buildTotalWordShrinkBatch(selected, direction);
  }

  async function runTotalWordAdjustments() {
    if (!wordControl.minimumWords && !wordControl.maximumWords || targetItemId || runOnlyIllustrationStage) return;
    contentStats.phase = 'total-word-adjusting';
    const resumingStage = resume && contentRuntime.word_adjustment_stage === 'total';
    const initialRound = resumingStage
      ? Math.max(1, Number(contentRuntime.word_adjustment_round) || 1)
      : 1;
    if (!resumingStage) setWordAdjustmentRuntime('total', '', 0, [], {}, 0, 0);
    let lastItemId = resumingStage ? contentRuntime.word_adjustment_item_id : '';
    let noProgressRounds = resumingStage
      ? Math.max(0, Number(contentRuntime.word_adjustment_no_progress_rounds) || 0)
      : 0;
    let round = initialRound;
    while (true) {
      let direction = getTotalWordDirection();
      if (!direction) return;
      const isExpansion = direction.mode === 'expand';
      if (!isExpansion && round > MAX_WORD_ADJUSTMENT_ROUNDS) return;
      const resumingRound = resumingStage && round === initialRound;
      const persistedRoundStartWords = Math.max(0, Number(contentRuntime.word_adjustment_round_start_words) || 0);
      const roundStartWords = resumingRound && persistedRoundStartWords > 0
        ? persistedRoundStartWords
        : direction.currentWords;
      contentStats.total_adjustment_mode = direction.mode;
      contentStats.total_adjustment_round = round;
      contentStats.total_adjustment_round_total = isExpansion ? 0 : MAX_WORD_ADJUSTMENT_ROUNDS;
      const completedItemIds = resumingRound
        ? [...contentRuntime.word_adjustment_completed_item_ids]
        : [];
      const completedItemIdSet = new Set(completedItemIds);
      setWordAdjustmentRuntime('total', lastItemId, round, completedItemIds, {}, noProgressRounds, roundStartWords);
      const differenceRatio = Math.abs(direction.currentWords - direction.targetWords) / direction.targetWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      // 本轮单节平均预算，用于缩写时过滤可缩空间过小的小节，避免它们占用批次名额却几乎缩不动。
      const averageBudget = Math.abs(direction.currentWords - direction.targetWords) / TOTAL_WORD_ADJUSTMENT_BATCH_SIZE;
      let candidates = leafWordStats().filter(({ item, words }) => {
        if (sections[item.id]?.status !== 'success' || words <= 0) return false;
        if (completedItemIdSet.has(item.id)) return false;
        if (!wordControl.strictSectionWords) return true;
        if (direction.mode === 'expand') return words < wordControl.sectionMaximumWords;
        // 缩写：仅保留可缩空间不小于平均预算 30% 的小节，集中资源到真正缩得动的小节上。
        const shrinkableWords = words - wordControl.sectionMinimumWords;
        return shrinkableWords >= averageBudget * TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO;
      }).sort((left, right) => direction.mode === 'expand' ? left.words - right.words : right.words - left.words);
      if (candidates.length > 1 && candidates[0].item.id === lastItemId) candidates = [...candidates.slice(1), candidates[0]];
      const remainingSlots = Math.max(0, TOTAL_WORD_ADJUSTMENT_BATCH_SIZE - completedItemIds.length);
      const batch = buildTotalWordAdjustmentBatch(candidates, direction, remainingSlots);
      const previousContentStats = storedPlan.contentGenerationTask?.stats?.content;
      contentStats.total_adjustment_batch_total = completedItemIds.length + batch.length;
      contentStats.total_adjustment_batch_completed = completedItemIds.length;
      contentStats.total_adjustment_batch_failed = resumingRound
        ? Number(previousContentStats?.total_adjustment_batch_failed) || 0
        : 0;
      contentStats.total_adjustment_active_count = 0;
      contentStats.total_adjustment_item_id = '';
      contentStats.total_adjustment_remaining_words = Math.abs(direction.currentWords - direction.targetWords);
      if (!batch.length && !completedItemIds.length) {
        if (isExpansion) {
          logs = [...logs, '全文扩写没有可继续调整的小节，停止自动扩写。'];
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          return;
        }
        round += 1;
        setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
        continue;
      }

      if (batch.length) {
        const roundLabel = isExpansion ? `第 ${round} 轮` : `第 ${round}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮`;
        logs = [...logs, `全文字数调整${roundLabel}：提交 ${batch.length} 个小节，当前还需${direction.mode === 'expand' ? '增加' : '减少'} ${contentStats.total_adjustment_remaining_words} 字。`];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        const activeItemIds = new Set();
        const batchResults = await Promise.allSettled(batch.map(async ({ context: candidate, budget, guidanceWords }) => {
          activeItemIds.add(candidate.item.id);
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = candidate.item.id;
          logs = [...logs, direction.mode === 'expand'
            ? `全文扩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，当前 ${candidate.words} 字，内部指导 ${guidanceWords} 字，本次预算 ${budget} 字。`
            : `全文缩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，本次预算 ${budget} 字。`];
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          let failed = false;
          try {
            await requestWordAdjustment(candidate, {
              mode: direction.mode,
              granularity,
              targetWords: direction.mode === 'expand' ? candidate.words + budget : Math.max(1, candidate.words - budget),
              maximumChangeWords: budget,
              totalRemainingWords: contentStats.total_adjustment_remaining_words,
              enforceSectionBounds: wordControl.strictSectionWords,
            });
            lastItemId = candidate.item.id;
          } catch (error) {
            if (isPauseLikeError(error)) throw error;
            failed = true;
            logs = [...logs, `全文字数调整未应用：${candidate.item.id}，${error.message || String(error)}。`];
          }
          completedItemIds.push(candidate.item.id);
          completedItemIdSet.add(candidate.item.id);
          activeItemIds.delete(candidate.item.id);
          const nextActiveItemId = activeItemIds.values().next().value || '';
          const nextDirection = getTotalWordDirection();
          contentStats.total_adjustment_batch_completed = completedItemIds.length;
          if (failed) contentStats.total_adjustment_batch_failed += 1;
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = nextActiveItemId;
          contentStats.total_adjustment_remaining_words = nextDirection
            ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
            : 0;
          setWordAdjustmentRuntime('total', candidate.item.id, round, completedItemIds, {}, noProgressRounds, roundStartWords);
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          pauseIfRequested('正文生成已在全文字数调整后暂停，可稍后继续。');
        }));
        const rejected = batchResults.find((result) => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }

      const currentWords = countTotalContentWords();
      if (isExpansion) {
        if (currentWords > roundStartWords) {
          noProgressRounds = 0;
        } else {
          noProgressRounds += 1;
          logs = [...logs, `全文扩写第 ${round} 轮未增加有效字数，连续无进展 ${noProgressRounds}/${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮。`];
        }
      }
      const nextDirection = getTotalWordDirection();
      contentStats.total_adjustment_remaining_words = nextDirection
        ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
        : 0;
      round += 1;
      setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
      if (isExpansion && noProgressRounds >= MAX_EXPANSION_NO_PROGRESS_ROUNDS) {
        logs = [...logs, `全文扩写连续 ${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮没有增加有效字数，停止自动扩写。`];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        return;
      }
    }
  }

  function buildOriginalCoverageAuditTargets(auditTargetItemId = '') {
    if (!hasOriginalPlan) {
      return [];
    }
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    return leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const originalState = getOriginalMaterialRuntimeState(context.item);
        const sources = originalState.validRestored ? originalState.originalMaterial.source_ranges.map(range => ({
          id: `L${range.start_line}-${range.end_line}`,
          title_path: [`原方案第 ${range.start_line}-${range.end_line} 行`],
          content: readOriginalRange(originalSource, range),
        })) : [];
        return {
          ...context,
          content: originalState.content,
          originalMaterial: originalState.originalMaterial,
          sources,
          originalState,
        };
      })
      .filter(({ item, originalState, sources }) => sections[item.id]?.status === 'success' && originalState.validRestored && !originalState.needsOptimization && sources.length);
  }

  function buildAgentOriginalCoverageSourcesMarkdown(targets) {
    const lines = ['# 原方案覆盖来源段', ''];
    for (const target of targets || []) {
      const id = target.item?.id || 'unknown';
      const title = target.item?.title || '未命名章节';
      lines.push(`## ${id} ${title}`);
      lines.push(`章节路径：${formatChapterPath(target)}`);
      lines.push('需要保留的来源段：');
      lines.push(formatOriginalCoverageSources(target.sources) || '未提供');
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function buildAgentOriginalCoverageRepairPrompt() {
    return `请在当前工作目录中完成原方案覆盖修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- original-coverage-sources.md：每个章节对应需要保留的来源段，是判断原方案核心内容是否已保留的依据。
- technical-plan.md：当前技术方案正文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
检查并修复 technical-plan.md，使各章节正文尽量保留 original-coverage-sources.md 中对应来源段的实质内容。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 每个小节已有原方案图片必须原样保留引用及顺序，不能移到其他小节、删除、重复或替换成新图；证书和报告图片是原方案实质内容。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 补回来源段中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法等内容；不追求逐字一致。
- 如果来源段与当前正文存在明显冲突，可以保留当前正文，后续会由全文一致性审计或人工核对处理。
- 用户可见正文中不出现“原方案”“来源段”“用户原文”或类似过程性表述。`;
  }

  function updateAgentOriginalCoverageProgress(step, label, extra = {}) {
    contentStats.phase = 'original-auditing';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'original-auditing' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return runtime;
  }

  async function runAgentOriginalCoverageRepair(options = {}) {
    if (!hasOriginalPlan) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const normalizedTargetId = String(options.targetItemId || targetItemId || '').trim();
    const coverageTargets = buildOriginalCoverageAuditTargets(normalizedTargetId);
    const sectionIndex = buildAgentConsistencySectionIndex(coverageTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'no_targets' });
      logs = [...logs, '原方案覆盖 Agent 修复跳过：没有可检查的已还原成功正文小节。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    logs = [...logs, `开始 Agent 原方案覆盖修复：共 ${sectionIndex.size} 个已还原小节${normalizedTargetId ? `，目标小节 ${normalizedTargetId}` : ''}。`];
    writeDeveloperLog('original_coverage.agent.start', {
      target_item_id: normalizedTargetId,
      section_count: sectionIndex.size,
      sections: coverageTargets.map((target) => ({
        id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });

    updateAgentOriginalCoverageProgress(1, '准备原方案覆盖 Agent 输入文件');
    const files = [
      { path: 'original-coverage-sources.md', content: buildAgentOriginalCoverageSourcesMarkdown(coverageTargets) },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(sectionIndex) },
    ];
    pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');

    if (!agentService?.runTask) {
      throw new Error('Agent 服务尚未初始化，无法执行必做的原方案覆盖审计');
    }

    updateAgentOriginalCoverageProgress(2, 'Agent 正在检查并补回原方案内容');
    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, '已请求暂停原方案覆盖 Agent 修复，正在取消本轮 Agent 任务。'];
        updateAgentOriginalCoverageProgress(0, '正在取消本轮原方案覆盖 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '原方案覆盖 Agent 修复',
        prompt: buildAgentOriginalCoverageRepairPrompt(),
        output_file: 'technical-plan.md',
        files,
        timeout_ms: 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: (resultForValidation) => {
          const repairedMarkdownForValidation = String(resultForValidation?.output_content || '').trim();
          if (!repairedMarkdownForValidation) {
            throw new Error('Agent 未返回修复后的 technical-plan.md');
          }
          const parsedSectionsForValidation = parseAgentSectionMarkdown(repairedMarkdownForValidation);
          validateAgentConsistencySections(parsedSectionsForValidation, sectionIndex);
          return { section_count: parsedSectionsForValidation.size };
        },
        onActivity: createAgentActivityProgressHandler(updateAgentOriginalCoverageProgress, 2, 'Agent 正在检查并补回原方案内容'),
      }, 'original_coverage.agent');
      if (isAgentBusyResult(agentResult)) {
        writeDeveloperLog('original_coverage.agent.busy', { active_task: agentResult?.active_task || null });
        throw new Error('Agent 正在处理其他任务，无法执行必做的原方案覆盖审计');
      }
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      updateAgentOriginalCoverageProgress(3, '读取 Agent 修复后的正文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('original_coverage.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      updateAgentOriginalCoverageProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      updateAgentOriginalCoverageProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, new Set(sectionIndex.keys()));
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      logs = [...logs, applyResult.changedCount
        ? `原方案覆盖 Agent 修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : '原方案覆盖 Agent 修复完成：未发现需要回写的小节。'];
      writeDeveloperLog('original_coverage.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        logs = [...logs, '原方案覆盖 Agent 修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。'];
        writeDeveloperLog('original_coverage.agent.paused', {
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        updateAgentOriginalCoverageProgress(0, '原方案覆盖 Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        pauseIfRequested('正文生成已在原方案覆盖 Agent 修复阶段暂停，本次 Agent 已取消；继续后将重新执行。');
      }

      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `原方案覆盖 Agent 修复失败：${error.message || '未知错误'}。已保留原正文，原方案覆盖审计未完成。`];
      writeDeveloperLog('original_coverage.agent.failed', {
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      updateAgentOriginalCoverageProgress(contentStats.audit_agent_step_completed || 2, '原方案覆盖 Agent 修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  function buildConsistencyTargets(targetItemIdForAudit = '') {
    const normalizedTargetId = String(targetItemIdForAudit || '').trim();
    return leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const content = sections[context.item.id]?.content || context.item.content || '';
        return {
          ...context,
          content,
        };
      })
      .filter(({ item, content }) => sections[item.id]?.status === 'success' && String(content || '').trim());
  }

  function buildAgentConsistencySectionIndex(targets) {
    const index = new Map();
    for (const context of targets || []) {
      const id = String(context.item?.id || '').trim();
      const content = String(context.content || '').trim();
      if (!id || !content) {
        continue;
      }
      index.set(id, {
        ...context,
        originalContent: content,
        originalHash: textHash(content),
      });
    }
    return index;
  }

  function renderAgentTechnicalPlanOutline(items, sectionIndex, level = 1, lines = []) {
    for (const item of items || []) {
      const id = String(item?.id || '').trim();
      const title = singleLine(item?.title || '未命名章节');
      const headingLevel = Math.min(level + 1, 6);
      lines.push(`${'#'.repeat(headingLevel)} ${id ? `${id} ` : ''}${title}`.trim());

      if (item?.children?.length) {
        renderAgentTechnicalPlanOutline(item.children, sectionIndex, level + 1, lines);
        continue;
      }

      const section = sectionIndex.get(id);
      if (!section) {
        continue;
      }
      lines.push(`<!-- yibiao-section-start id="${escapeSectionAttribute(id)}" title="${escapeSectionAttribute(title)}" -->`);
      lines.push(section.originalContent);
      lines.push(`<!-- yibiao-section-end id="${escapeSectionAttribute(id)}" -->`);
    }
    return lines;
  }

  function buildAgentTechnicalPlanMarkdown(sectionIndex) {
    const lines = ['# 技术方案正文', ''];
    renderAgentTechnicalPlanOutline(outlineData.outline || [], sectionIndex, 1, lines);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function buildAgentGlobalFactsMarkdown() {
    return [
      '# 全局事实变量',
      globalFactsText || '未提供',
      '# 招标文件关键解析结果',
      bidAnalysisFactsText || '未提供',
    ].join('\n\n');
  }

  function buildAgentConsistencyRepairPrompt() {
    return `请在当前工作目录中完成全文一致性修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- global-facts.md：全局事实变量、招标文件关键解析结果和需要保持一致的项目信息。
- technical-plan.md：当前技术方案正文全文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
审计并修复 technical-plan.md，使正文不与 global-facts.md 中的全局事实变量冲突，并尽量消除正文前后矛盾。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 每个小节已有原方案图片必须原样保留引用及顺序，不能移到其他小节、删除、重复或替换成新图；证书和报告图片是原方案实质内容。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 修复事实冲突、前后矛盾、同一信息多处表达不一致等问题。
- 优先以 global-facts.md 中的事实变量和关键项目信息为准。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}\n不得把【待填写】改成具体值，也不得为缺失项杜撰事实。` : ''}`;
  }

  function updateAgentConsistencyProgress(step, label, extra = {}) {
    contentStats.phase = 'auditing';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'auditing' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return runtime;
  }

  function validateAgentConsistencySections(parsedSections, sectionIndex) {
    for (const id of parsedSections.keys()) {
      if (!sectionIndex.has(id)) {
        throw new Error(`Agent 输出包含未知小节：${id}`);
      }
    }
    for (const [id, section] of sectionIndex.entries()) {
      if (!parsedSections.has(id)) {
        throw new Error(`Agent 输出缺少小节：${id}`);
      }
      const nextContent = String(parsedSections.get(id) || '').trim();
      validateSectionOriginalImages(id, nextContent);
      if (String(section.originalContent || '').trim() && !nextContent) {
        throw new Error(`Agent 输出把非空小节改为空：${id}`);
      }
    }
  }

  function applyAgentConsistencySections(parsedSections, sectionIndex, writableIds) {
    // 先检查完整输出，避免后面某节丢图时前面小节已被写回。
    validateAgentConsistencySections(parsedSections, sectionIndex);
    let changedCount = 0;
    let skippedCount = 0;
    const changedIds = [];
    for (const [id, section] of sectionIndex.entries()) {
      if (writableIds instanceof Set && !writableIds.has(id)) {
        skippedCount += 1;
        continue;
      }
      const nextContent = String(parsedSections.get(id) || '').trim();
      const currentContent = String(section.originalContent || '').trim();
      if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
        skippedCount += 1;
        continue;
      }
      changedCount += 1;
      changedIds.push(id);
      rememberTouchedItem(id);
      saveSection(section.item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
    }
    return { changedCount, skippedCount, changedIds };
  }

  async function runAgentConsistencyRepair(options = {}) {
    if (!agentService?.runTask) {
      throw new Error('Agent 服务尚未初始化，无法执行 Agent 一致性修复');
    }

    const allTargets = buildConsistencyTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(allTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, 'Agent 一致性修复跳过：没有可审计的成功正文小节。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const normalizedTargetId = String(options.targetItemId || targetItemId || '').trim();
    const writableIds = normalizedTargetId ? new Set([normalizedTargetId]) : new Set(sectionIndex.keys());
    if (normalizedTargetId && !sectionIndex.has(normalizedTargetId)) {
      logs = [...logs, `Agent 一致性修复跳过：目标小节 ${normalizedTargetId} 当前没有成功正文。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    logs = [...logs, `开始 Agent 全文一致性修复：共 ${sectionIndex.size} 个正文小节${normalizedTargetId ? `，仅回写目标小节 ${normalizedTargetId}` : ''}。`];
    writeDeveloperLog('consistency.agent.start', {
      target_item_id: normalizedTargetId,
      section_count: sectionIndex.size,
      writable_ids: [...writableIds],
      sections: Array.from(sectionIndex.values()).map((section) => ({
        id: section.item.id,
        title: section.item.title || '未命名章节',
        content_metrics: textMetrics(section.originalContent),
      })),
    });

    updateAgentConsistencyProgress(1, '准备 Agent 输入文件');
    const files = [
      { path: 'global-facts.md', content: buildAgentGlobalFactsMarkdown() },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(sectionIndex) },
    ];
    pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');

    updateAgentConsistencyProgress(2, 'Agent 正在审计并修复全文');
    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, '已请求暂停 Agent 一致性修复，正在取消本轮 Agent 任务。'];
        updateAgentConsistencyProgress(0, '正在取消本轮 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '全文一致性 Agent 修复',
        prompt: buildAgentConsistencyRepairPrompt(),
        output_file: 'technical-plan.md',
        files,
        timeout_ms: 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: (resultForValidation) => {
          const repairedMarkdownForValidation = String(resultForValidation?.output_content || '').trim();
          if (!repairedMarkdownForValidation) {
            throw new Error('Agent 未返回修复后的 technical-plan.md');
          }
          const parsedSectionsForValidation = parseAgentSectionMarkdown(repairedMarkdownForValidation);
          validateAgentConsistencySections(parsedSectionsForValidation, sectionIndex);
          return { section_count: parsedSectionsForValidation.size };
        },
        onActivity: createAgentActivityProgressHandler(updateAgentConsistencyProgress, 2, 'Agent 正在审计并修复全文'),
      }, 'consistency.agent');
      if (isAgentBusyResult(agentResult)) {
        writeDeveloperLog('consistency.agent.busy', { active_task: agentResult?.active_task || null });
        throw new Error('Agent 正在处理其他任务，无法执行必做的全文一致性审计');
      }
      pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      updateAgentConsistencyProgress(3, '读取 Agent 修复后的全文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('consistency.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      updateAgentConsistencyProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      updateAgentConsistencyProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, writableIds);
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      logs = [...logs, applyResult.changedCount
        ? `Agent 一致性修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : 'Agent 一致性修复完成：未发现需要回写的小节。'];
      writeDeveloperLog('consistency.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      updateAgentConsistencyProgress(5, 'Agent 一致性修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        logs = [...logs, 'Agent 一致性修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。'];
        writeDeveloperLog('consistency.agent.paused', {
          target_item_id: normalizedTargetId,
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        updateAgentConsistencyProgress(0, 'Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        pauseIfRequested('正文生成已在 Agent 全文一致性修复阶段暂停，本次 Agent 已取消；继续后将重新执行 Agent 修复。');
      }
      const failedCount = normalizedTargetId ? 1 : sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `Agent 一致性修复失败：${error.message || '未知错误'}。已保留原正文，全文一致性审计未完成。`];
      writeDeveloperLog('consistency.agent.failed', {
        target_item_id: normalizedTargetId,
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      updateAgentConsistencyProgress(contentStats.audit_agent_step_completed || 2, 'Agent 一致性修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  function getCurrentSuccessfulContent(item) {
    const section = sections[item.id] || {};
    return section.status === 'success' ? String(section.content || '') : '';
  }

  function buildTableCleanupTargets(cleanupTargetItemId = '') {
    const normalizedTargetId = String(cleanupTargetItemId || '').trim();
    return leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const content = getCurrentSuccessfulContent(context.item);
        return {
          ...context,
          content,
          tables: extractContentTableBlocks(content),
        };
      })
      .filter(({ content, tables }) => String(content || '').trim() && tables.length);
  }

  async function cleanupTablesForSection(target) {
    const { item } = target;
    let currentContent = target.content;
    const originalTables = extractContentTableBlocks(currentContent);
    let rewrittenCount = 0;
    let skippedCount = 0;
    if (!originalTables.length) {
      return { rewrittenCount, skippedCount };
    }

    const batches = createTableCleanupBatches(originalTables).reverse();
    writeDeveloperLog('table_cleanup.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      table_count: originalTables.length,
      batch_count: batches.length,
      content_metrics: textMetrics(currentContent),
    });

    for (const batch of batches) {
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const allowedTableIds = new Set(batch.map((table) => table.id));
      const tableById = new Map(batch.map((table) => [table.id, table]));
      try {
        const response = await aiService.collectJsonResponse({
          messages: buildTableCleanupMessages({ chapter: item, tables: batch }),
          logTitle: `正文去表格-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文去表格',
          failureMessage: '模型返回的表格转换结果格式无效',
          normalizer: (value) => normalizeTableCleanupResponse(value, allowedTableIds),
          validator: validateTableCleanupResponse,
          max_retries: 1,
        });
        const edits = [];
        const returnedIds = new Set();
        for (const replacement of response.replacements || []) {
          const table = tableById.get(replacement.table_id);
          returnedIds.add(replacement.table_id);
          if (!table) {
            continue;
          }
          if (containsContentTable(replacement.replacement_text)) {
            skippedCount += 1;
            writeDeveloperLog('table_cleanup.replacement.skipped', {
              section_id: item.id,
              table_id: table.id,
              reason: 'replacement_still_contains_table',
              replacement_metrics: textMetrics(replacement.replacement_text),
            });
            continue;
          }
          edits.push({ start: table.start, end: table.end, newText: replacement.replacement_text });
        }

        const missingCount = batch.filter((table) => !returnedIds.has(table.id)).length;
        skippedCount += missingCount;
        if (!edits.length) {
          contentStats.table_cleanup_completed += batch.length;
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          continue;
        }

        const editResult = applyRangeEdits(currentContent, edits);
        if (editResult.errors.length) {
          skippedCount += edits.length;
          writeDeveloperLog('table_cleanup.apply.failed', {
            section_id: item.id,
            errors: editResult.errors,
            edit_count: edits.length,
          });
        } else {
          currentContent = editResult.content;
          rewrittenCount += editResult.edits.length;
          contentStats.table_cleanup_rewritten += editResult.edits.length;
          rememberTouchedItem(item.id);
          saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
          writeDeveloperLog('table_cleanup.apply.success', {
            section_id: item.id,
            applied_count: editResult.edits.length,
            edit_results: editResult.edits,
            content_metrics: textMetrics(currentContent),
          });
        }
        contentStats.table_cleanup_completed += batch.length;
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        skippedCount += batch.length;
        contentStats.table_cleanup_completed += batch.length;
        logs = [...logs, `正文去表格跳过：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
        writeDeveloperLog('table_cleanup.batch.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          table_ids: batch.map((table) => table.id),
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      }
    }

    const remainingTables = extractContentTableBlocks(currentContent).length;
    if (remainingTables) {
      writeDeveloperLog('table_cleanup.section.remaining', {
        section_id: item.id,
        title: item.title || '未命名章节',
        remaining_tables: remainingTables,
      });
    }
    return { rewrittenCount, skippedCount: Math.max(0, originalTables.length - rewrittenCount) };
  }

  async function removeTablesBeforeIllustration(options = {}) {
    if (tableRequirement !== 'none') {
      return { ran: false, rewrittenCount: 0, skippedCount: 0 };
    }

    contentStats.phase = 'table-cleaning';
    contentStats.table_cleanup_total = 0;
    contentStats.table_cleanup_completed = 0;
    contentStats.table_cleanup_rewritten = 0;
    contentStats.table_cleanup_skipped = 0;
    const runtime = syncRuntime({ phase: 'table-cleaning' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });

    const targets = buildTableCleanupTargets(options.targetItemId || targetItemId);
    const tableTotal = targets.reduce((sum, target) => sum + target.tables.length, 0);
    contentStats.table_cleanup_total = tableTotal;

    if (!tableTotal) {
      logs = [...logs, '正文去表格检查完成：未发现需要转换的表格。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return { ran: true, rewrittenCount: 0, skippedCount: 0 };
    }

    logs = [...logs, `开始正文去表格：发现 ${targets.length} 个小节、${tableTotal} 个表格，将按小节并发转换为普通文字描述。`];
    writeDeveloperLog('table_cleanup.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      section_count: targets.length,
      table_count: tableTotal,
      sections: targets.map(({ item, tables }) => ({ id: item.id, title: item.title || '未命名章节', table_count: tables.length })),
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

    let rewrittenCount = 0;
    let skippedCount = 0;
    pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    const settled = await Promise.allSettled(targets.map(async (target) => {
      const result = await cleanupTablesForSection(target);
      rewrittenCount += result.rewrittenCount;
      skippedCount += result.skippedCount;
      contentStats.table_cleanup_skipped = skippedCount;
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;

    pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    logs = [...logs, `正文去表格完成：成功转换 ${rewrittenCount} 个表格，跳过 ${skippedCount} 个。`];
    writeDeveloperLog('table_cleanup.done', {
      table_count: tableTotal,
      rewritten_count: rewrittenCount,
      skipped_count: skippedCount,
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    return { ran: true, rewrittenCount, skippedCount };
  }

  async function runIllustrationPlanning() {
    contentStats.phase = 'illustration-planning';
    contentStats.illustration_planning_step_total = 3;
    contentStats.illustration_planning_step_completed = 0;
    contentStats.illustration_planning_step_label = '正在准备全文和目录输入';
    const strippedDocument = stripGeneratedIllustrationsFromDocument(outlineData, sections);
    outlineData = strippedDocument.outlineData;
    sections = strippedDocument.sections;
    rebuildContentWordCounts();
    workspaceStore.clearIllustrationFiles?.();
    const phaseRuntime = syncRuntime({ phase: 'illustration-planning' });
    logs = [...logs, '正文后处理完成，开始使用 Agent 编排全文图片计划。'];
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationRuntime: phaseRuntime,
    }, {
      outlineData,
      contentRuntime: phaseRuntime,
    });
    workspaceStore.clearUnreferencedGeneratedImages?.();

    const imageAvailability = aiService.getImageModelAvailability
      ? aiService.getImageModelAvailability()
      : { available: false };
    const planningContext = buildIllustrationPlanningContext({
      outlineData,
      sections,
      options: generationOptions,
      aiImagesAvailable: imageAvailability.available,
    });
    contentStats.illustration_planning_step_completed = 1;
    contentStats.illustration_planning_step_label = '正在执行全文图片编排 Agent';
    pauseIfRequested('正文生成已在图片编排输入准备后暂停，本次 Agent 未启动；继续后将重新执行。');

    const enabledKinds = ['html', 'ai', 'mermaid'].filter((kind) => planningContext.config[kind].enabled);
    let resolved;
    if (!planningContext.eligibleSectionIds.length || !enabledKinds.length) {
      resolved = resolveIllustrationPlan({ items: [] }, planningContext);
      logs = [...logs, planningContext.eligibleSectionIds.length
        ? '所有图片类型均未启用，已生成空的全文图片计划。'
        : '没有可编排的成功正文小节，已生成空的全文图片计划。'];
    } else {
      let validatedPlan = null;
      const { agentResult, outputContent } = await runContentAgentTask({
        title: '技术方案全文图片编排 Agent',
        prompt: buildIllustrationPlanningPrompt(),
        outputFile: 'illustration-plan.json',
        files: planningContext.files,
        eventPrefix: 'illustration_planning.agent',
        activityLabel: 'Agent 正在阅读全文并编排图片',
        startPauseMessage: '正文生成已在全文图片编排 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
        resultPauseMessage: '正文生成已在全文图片编排结果保存前暂停，本次 Agent 输出未保存；继续后将重新执行。',
        pausedLogMessage: '全文图片编排 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
        validateOutput: (resultForValidation) => {
          validatedPlan = resolveIllustrationPlan(resultForValidation?.output_content || '', planningContext);
          return validatedPlan;
        },
      });
      resolved = validatedPlan || resolveIllustrationPlan(outputContent, planningContext);
      writeDeveloperLog('illustration_planning.agent.done', {
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
        candidate_stats: resolved.stats.candidate,
        selected_stats: resolved.stats.selected,
        selected_items: resolved.plan.items.map((item) => ({
          item_id: item.item_id,
          kind: item.kind,
          image_type: item.image_type,
          title: item.title,
          section_ids: item.section_ids,
        })),
      });
    }

    pauseIfRequested('正文生成已在全文图片编排结果保存前暂停，本次计划未保存；继续后将重新执行。');
    contentStats.illustration_planning_step_completed = 2;
    contentStats.illustration_planning_step_label = '正在保存全文图片计划';
    contentStats.illustration_candidate_ai = resolved.stats.candidate.ai;
    contentStats.illustration_candidate_mermaid = resolved.stats.candidate.mermaid;
    contentStats.illustration_candidate_html = resolved.stats.candidate.html;
    contentStats.illustration_selected_ai = resolved.stats.selected.ai;
    contentStats.illustration_selected_mermaid = resolved.stats.selected.mermaid;
    contentStats.illustration_selected_html = resolved.stats.selected.html;
    const planRuntime = syncRuntime({ phase: 'illustration-planning' });
    contentStats.illustration_planning_step_completed = 3;
    contentStats.illustration_planning_step_label = '全文图片编排完成';
    logs = [...logs, `全文图片编排完成：候选 ${resolved.stats.candidate.html + resolved.stats.candidate.mermaid + resolved.stats.candidate.ai} 项，最终保留 HTML ${resolved.stats.selected.html} 项、Mermaid ${resolved.stats.selected.mermaid} 项、AI ${resolved.stats.selected.ai} 项。`];
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentIllustrationPlan: resolved.plan,
      contentGenerationRuntime: planRuntime,
    }, {
      contentRuntime: planRuntime,
      technicalPlanPatch: { contentIllustrationPlan: resolved.plan, contentGenerationRuntime: planRuntime },
    });
    return resolved.plan;
  }

  async function runIllustrationGeneration(initialPlan) {
    let illustrationPlan = initialPlan;
    if (Number(illustrationPlan?.plan_version) !== ILLUSTRATION_PLAN_VERSION) {
      throw new Error('图片计划版本无效');
    }
    if (!illustrationPlan?.items?.length) {
      logs = [...logs, '全文图片计划为空，跳过图片生成。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return illustrationPlan;
    }

    illustrationPlan = {
      ...illustrationPlan,
      items: illustrationPlan.items.map((item) => item.generation?.status === 'running'
        ? { ...item, generation: { ...item.generation, status: 'pending', error: undefined, updated_at: now() } }
        : item),
    };
    const executions = buildIllustrationExecutionContexts(illustrationPlan, leaves, sections);
    const aiExecutions = executions.filter(({ planItem }) => planItem.kind === 'ai');
    const normalTextExecutions = executions.filter(({ planItem, reference }) => planItem.kind === 'mermaid'
      || (planItem.kind === 'html' && reference.length <= HTML_AGENT_THRESHOLD_CHARS));
    const agentHtmlExecutions = executions.filter(({ planItem, reference }) => planItem.kind === 'html' && reference.length > HTML_AGENT_THRESHOLD_CHARS);

    function countCompleted(kind) {
      return illustrationPlan.items.filter((item) => item.kind === kind && ['success', 'error'].includes(item.generation?.status)).length;
    }

    function refreshIllustrationGenerationStats(label) {
      contentStats.illustration_generation_total = illustrationPlan.items.length;
      contentStats.illustration_generation_completed = illustrationPlan.items.filter((item) => ['success', 'error'].includes(item.generation?.status)).length;
      contentStats.illustration_generation_ai_total = aiExecutions.length;
      contentStats.illustration_generation_ai_completed = countCompleted('ai');
      contentStats.illustration_generation_mermaid_total = executions.filter(({ planItem }) => planItem.kind === 'mermaid').length;
      contentStats.illustration_generation_mermaid_completed = countCompleted('mermaid');
      contentStats.illustration_generation_html_total = executions.filter(({ planItem }) => planItem.kind === 'html').length;
      contentStats.illustration_generation_html_completed = countCompleted('html');
      contentStats.illustration_generation_step_label = label || contentStats.illustration_generation_step_label;
    }

    function persistIllustrationGeneration(itemId, generation, label) {
      illustrationPlan = {
        ...illustrationPlan,
        items: illustrationPlan.items.map((item) => item.item_id === itemId
          ? { ...item, generation: { ...(item.generation || {}), ...generation, updated_at: now() } }
          : item),
        updated_at: now(),
      };
      refreshIllustrationGenerationStats(label);
      const runtime = syncRuntime({ phase: 'illustration-generating' });
      const changedItem = illustrationPlan.items.find((item) => item.item_id === itemId);
      const taskPatch = { status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() };
      const eventPatch = {
        contentRuntime: runtime,
        technicalPlanPatch: { contentIllustrationPlan: illustrationPlan, contentGenerationRuntime: runtime },
      };
      if (changedItem && ['success', 'error'].includes(changedItem.generation?.status)) {
        checkpointTask(taskPatch, {
          contentIllustrationItem: changedItem,
          contentGenerationRuntime: runtime,
        }, eventPatch);
        return;
      }
      publishTaskUpdate(taskPatch, eventPatch);
    }

    async function runExecution(execution) {
      const { planItem } = execution;
      if (['success', 'error'].includes(planItem.generation?.status)) return;
      persistIllustrationGeneration(planItem.item_id, { status: 'running', error: undefined }, `正在生成${planItem.kind === 'ai' ? ' AI' : planItem.kind === 'mermaid' ? ' Mermaid' : ' HTML'} 图片`);
      try {
        let result;
        if (planItem.kind === 'ai') {
          result = await generateAiIllustration(aiService, execution);
          logs = [...logs, `AI 配图完成：${planItem.section_ids[0]} ${planItem.title}`];
        } else if (planItem.kind === 'mermaid') {
          result = await generateMermaidIllustration(aiService, execution, isPauseLikeError);
          logs = [...logs, result.attempts
            ? `Mermaid 配图已修复并完成：${planItem.section_ids[0]} ${planItem.title}（修复 ${result.attempts} 轮）`
            : `Mermaid 配图完成：${planItem.section_ids[0]} ${planItem.title}`];
        } else {
          result = await generateHtmlIllustration({
            aiService,
            execution,
            plan: illustrationPlan,
            workspaceStore,
            onSourceSaved: (source) => persistIllustrationGeneration(
              planItem.item_id,
              { status: 'running', error: undefined, ...source },
              'HTML 源文件已保存，正在转换图片',
            ),
            runAgentHtml: async ({ title, prompt, outputFile, files, validateOutput }) => {
              const response = await runContentAgentTask({
                title,
                prompt,
                outputFile,
                files,
                eventPrefix: 'html_illustration.agent',
                activityLabel: 'Agent 正在生成 HTML 图片',
                startPauseMessage: '正文生成已在 HTML 图片 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
                resultPauseMessage: '正文生成已在 HTML 图片 Agent 结果保存前暂停，本次输出未保存；继续后将重新执行。',
                pausedLogMessage: 'HTML 图片 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
                validateOutput,
              });
              return response.outputContent;
            },
            onRenderRetry: (attempt, error) => writeDeveloperLog('illustration.html.render.retry', {
              item_id: planItem.item_id,
              attempt,
              error: compactError(error?.message || error),
            }),
            isPauseRequested,
            createPauseError: createContentGenerationPausedError,
          });
        }
        persistIllustrationGeneration(planItem.item_id, { status: 'success', error: undefined, ...result }, '正在汇总已生成图片');
      } catch (error) {
        if (isPauseLikeError(error) || isPauseRequested()) throw error;
        const partial = error?.illustrationGeneration || {};
        persistIllustrationGeneration(planItem.item_id, {
          status: 'error',
          ...partial,
          error: compactError(error?.message || error),
        }, '正在继续生成其他图片');
        writeDeveloperLog(`illustration.${planItem.kind}.failed`, {
          item_id: planItem.item_id,
          section_ids: planItem.section_ids,
          image_type: planItem.image_type,
          title: planItem.title,
          error: compactError(error?.message || error),
        });
        const kindLabel = planItem.kind === 'ai' ? 'AI' : planItem.kind === 'mermaid' ? 'Mermaid' : 'HTML';
        logs = [...logs, `${kindLabel} 配图失败：${planItem.section_ids[0]}，${error.message || '生成失败'}，已保留正文。`];
      }
    }

    contentStats.phase = 'illustration-generating';
    refreshIllustrationGenerationStats('正在启动文本组和生图组');
    logs = [...logs, `开始生成图片：文本组 ${normalTextExecutions.length} 项（并发 ${contentConcurrency}），超长 HTML Agent ${agentHtmlExecutions.length} 项（串行），AI 生图组 ${aiExecutions.length} 项（并发 ${imageConcurrency}）。`];
    const runtime = syncRuntime({ phase: 'illustration-generating' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, {
      contentRuntime: runtime,
      technicalPlanPatch: { contentIllustrationPlan: illustrationPlan, contentGenerationRuntime: runtime },
    });

    async function runTextGroup() {
      await runItemsWithWorkerPool(normalTextExecutions, contentConcurrency, runExecution, isPauseRequested);
      pauseIfRequested('正文生成已在普通文本图片完成后暂停，超长 HTML Agent 尚未继续执行。');
      for (const execution of agentHtmlExecutions) {
        pauseIfRequested('正文生成已在超长 HTML 图片 Agent 开始前暂停，继续后将重新执行。');
        await runExecution(execution);
      }
    }

    const settled = await Promise.allSettled([
      runTextGroup(),
      runItemsWithWorkerPool(aiExecutions, imageConcurrency, runExecution, isPauseRequested),
    ]);
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.reason) throw rejected.reason;
    pauseIfRequested('正文生成已在图片生成阶段暂停，可导出当前已完成正文，稍后继续。');

    const applied = applyGeneratedIllustrationsToDocument(illustrationPlan, outlineData, sections);
    outlineData = applied.outlineData;
    sections = applied.sections;
    rebuildContentWordCounts();
    refreshIllustrationGenerationStats('图片生成和正文插入完成');
    const completedRuntime = syncRuntime({ phase: 'illustration-generating' });
    logs = [...logs, '图片生成阶段完成。'];
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationRuntime: completedRuntime,
    }, {
      outlineData,
      contentRuntime: completedRuntime,
      technicalPlanPatch: {
        contentGenerationSections: sections,
        contentIllustrationPlan: illustrationPlan,
        contentGenerationRuntime: completedRuntime,
      },
    });
    return illustrationPlan;
  }

  try {
    if (continuePostProcessing) {
      const ignoredContexts = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
      for (const { item } of ignoredContexts) {
        const content = String(sections[item.id]?.content || item.content || '');
        saveSection(item, {
          status: 'ignored',
          content,
          error: undefined,
        }, content, { logs });
      }
      contentStats.ignored_section_count = ignoredContexts.length;
      contentStats.awaiting_content_decision = false;
      contentRuntime = syncRuntime({ awaiting_content_decision: false });
      logs = [...logs, `已按用户确认忽略 ${ignoredContexts.length} 个失败或未完成小节，开始执行后续流程。`];
      checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
        contentGenerationRuntime: contentRuntime,
      }, { contentRuntime });
    }

    if (!runOnlyIllustrationStage && tasksToRun.length) {
      if (targetItemId) {
        if (!completedStages.has('planning')) {
          await prepareSingleSectionPlan();
          markStageCompleted('planning');
          pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        }
        if (hasOriginalPlan && !completedStages.has('restoring') && tasksToRun.some(({ item }) => !directGenerationIds.has(item.id))) {
          await restoreOriginalMaterialsIfNeeded(tasksToRun.filter(({ item }) => !directGenerationIds.has(item.id)));
          markStageCompleted('restoring');
          pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        }
        startContentGenerationStage();
        await runContentGeneration(tasksToRun);
        return;
      } else {
        if (!completedStages.has('planning')) {
          await planAll();
          markStageCompleted('planning');
          pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        }
        if (hasOriginalPlan && !completedStages.has('restoring') && tasksToRun.some(({ item }) => !directGenerationIds.has(item.id))) {
          await restoreOriginalMaterialsIfNeeded(tasksToRun.filter(({ item }) => !directGenerationIds.has(item.id)));
          markStageCompleted('restoring');
          pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        }
        startContentGenerationStage();
        await runContentGeneration(tasksToRun);
        return;
      }
    }

    // HTML 文件产出阶段没有目标时也直接结束，只有显式后处理入口继续走原流程。
    if (!runOnlyIllustrationStage && !retryContentCorrection && !continuePostProcessing && !tasksToRun.length) {
      checkpointTask({ status: 'success', progress: 100, logs, stats: statsSnapshot() });
      return;
    }

    if (!runOnlyIllustrationStage && !targetItemId && !retryContentCorrection && !continuePostProcessing) {
      const unresolvedContexts = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
      if (unresolvedContexts.length) {
        persistContentDecisionWait(unresolvedContexts);
        return;
      }
      contentStats.awaiting_content_decision = false;
      contentRuntime = syncRuntime({ awaiting_content_decision: false });
      checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
        contentGenerationRuntime: contentRuntime,
      }, { contentRuntime });
    }

    if (!runOnlyIllustrationStage && !targetItemId && !retryContentCorrection && !completedStages.has('section-word-adjusting')) {
      await runSectionWordAdjustments(leaves, 'section');
      markStageCompleted('section-word-adjusting', { pauseForDeveloper: wordControl.strictSectionWords });
      pauseIfRequested('正文生成已在小节字数调整后暂停，可导出当前已完成内容，稍后继续。');
    }

    if (!runOnlyIllustrationStage && !targetItemId) {
      if (retryContentCorrection) {
        logs = [...logs, '本次为内容矫正重试，跳过正文生成，直接进入内容矫正阶段。'];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      }
      if (!completedStages.has('original-auditing')) {
        const result = await runAgentOriginalCoverageRepair();
        markStageCompleted('original-auditing', { pauseForDeveloper: Boolean(result?.ran) });
      }
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (!completedStages.has('auditing')) {
        const result = await runAgentConsistencyRepair();
        markStageCompleted('auditing', { pauseForDeveloper: Boolean(result?.ran) });
      }
      if (!completedStages.has('table-cleaning')) {
        const result = await removeTablesBeforeIllustration();
        markStageCompleted('table-cleaning', { pauseForDeveloper: Boolean(result?.ran) });
      }
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const unresolvedSections = completedStages.has('final-section-word-adjusting')
        ? leaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(getLeafWordCount(item))).map(({ item }) => item.id)
        : await runSectionWordAdjustments(leaves, 'final-section');
      markStageCompleted('final-section-word-adjusting', { pauseForDeveloper: wordControl.strictSectionWords });
      if (!completedStages.has('total-word-adjusting')) {
        await runTotalWordAdjustments();
        markStageCompleted('total-word-adjusting', { pauseForDeveloper: Boolean(wordControl.minimumWords || wordControl.maximumWords) });
      }
      const postAdjustmentSectionViolations = wordControl.strictSectionWords
        ? leaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(getLeafWordCount(item)))
        : [];
      if (unresolvedSections.length && !postAdjustmentSectionViolations.length) {
        logs = [...logs, '全文调整已同时修复此前未达标的小节字数。'];
      }
    } else if (!runOnlyIllustrationStage) {
      if (!completedStages.has('original-auditing')) {
        const result = await runAgentOriginalCoverageRepair({ targetItemId });
        markStageCompleted('original-auditing', { pauseForDeveloper: Boolean(result?.ran) });
      }
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (!completedStages.has('auditing')) {
        const result = await runAgentConsistencyRepair({ targetItemId });
        markStageCompleted('auditing', { pauseForDeveloper: Boolean(result?.ran) });
      }
      if (!completedStages.has('table-cleaning')) {
        const result = await removeTablesBeforeIllustration({ targetItemId });
        markStageCompleted('table-cleaning', { pauseForDeveloper: Boolean(result?.ran) });
      }
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const targetContext = leaves.find(({ item }) => item.id === targetItemId);
      if (targetContext && wordControl.strictSectionWords && !completedStages.has('section-word-adjusting')) {
        contentStats.phase = 'section-word-adjusting';
        contentStats.section_adjustment_total = 1;
        contentStats.section_adjustment_completed = 0;
        contentStats.section_adjustment_active_count = 1;
        const resumingSectionAdjustment = resume
          && contentRuntime.word_adjustment_stage === 'section';
        const itemRounds = resumingSectionAdjustment ? { ...contentRuntime.word_adjustment_item_rounds } : {};
        const completedItemIds = resumingSectionAdjustment ? [...contentRuntime.word_adjustment_completed_item_ids] : [];
        if (!resumingSectionAdjustment) setWordAdjustmentRuntime('section', targetItemId, 0, completedItemIds, itemRounds);
        await adjustSectionToRange(
          targetContext,
          'section',
          itemRounds,
          completedItemIds,
        );
        if (!completedItemIds.includes(targetItemId)) completedItemIds.push(targetItemId);
        contentStats.section_adjustment_completed = 1;
        contentStats.section_adjustment_active_count = 0;
        contentStats.section_adjustment_item_id = '';
        contentStats.section_adjustment_round = 0;
        setWordAdjustmentRuntime('section', '', 0, completedItemIds, itemRounds);
        markStageCompleted('section-word-adjusting');
      }
    } else if (runOnlyIllustrationPlanning) {
      logs = [...logs, rerunIllustrations
        ? '开始仅重新配图：清除旧配图后，重新执行全文图片编排和生成阶段。'
        : '继续全文图片编排，跳过已完成的正文生成和内容矫正阶段。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    } else {
      logs = [...logs, '继续图片生成，跳过已完成的正文生成、内容矫正和图片编排阶段。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }

    if (!targetItemId) {
      let illustrationPlan = runOnlyIllustrationGeneration || completedStages.has('illustration-planning') ? storedPlan.contentIllustrationPlan : null;
      if (!runOnlyIllustrationGeneration && !completedStages.has('illustration-planning')) {
        pauseIfRequested('正文生成已在全文图片编排前暂停，可导出当前已完成内容，稍后继续。');
        illustrationPlan = await runIllustrationPlanning();
        markStageCompleted('illustration-planning');
      }
      if (!completedStages.has('illustration-generating')) {
        pauseIfRequested('正文生成已在图片生成前暂停，可导出当前已完成内容，稍后继续。');
        contentStats.phase = 'illustration-generating';
        await runIllustrationGeneration(illustrationPlan);
        markStageCompleted('illustration-generating');
      }
    }
    pauseIfRequested('正文生成已在完成前暂停，可导出当前已完成内容，稍后继续。');

    const statusLeaves = targetItemId ? leaves.filter(({ item }) => item.id === targetItemId) : leaves;
    for (const { item } of statusLeaves) {
      const status = sections[item.id]?.status;
      if (status === 'error' || status === 'ignored') continue;
      const content = getLeafContentForWords(item);
      if (countContentWords(content) > 0) {
        if (status !== 'success') {
          saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
        }
        continue;
      }
      const message = '正文最终结果没有有效可读内容';
      logs = [...logs, `正文有效性检查失败：${item.id} ${item.title || '未命名章节'}，${message}。`];
      saveSection(item, { status: 'error', content, error: message }, content, { logs });
    }
    rebuildContentWordCounts();
    const finalSectionViolations = wordControl.strictSectionWords
      ? statusLeaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(getLeafWordCount(item)))
      : [];
    const finalTotalDirection = targetItemId ? null : getTotalWordDirection();
    contentStats.word_control_warning = finalSectionViolations.length || finalTotalDirection
      ? (targetItemId ? SECTION_WORD_CONTROL_WARNING : CONTENT_WORD_CONTROL_WARNING)
      : undefined;
    const failedCount = statusLeaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
    const finalProgress = progressFor(leaves, sections);
    const finalStatus = taskStatusFor(statusLeaves, sections);
    contentStats.phase = 'done';
    logs = [...logs, targetItemId
      ? (failedCount ? `小节重新生成结束，当前整体进度 ${finalProgress}%，${failedCount} 个小节失败。` : `小节重新生成完成，当前整体进度 ${finalProgress}%。`)
      : (failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。')];
    if (contentStats.word_control_warning) logs = [...logs, contentStats.word_control_warning];
    writeDeveloperLog('content.task.completed', {
      status: finalStatus,
      progress: finalProgress,
      failed_count: failedCount,
      stats: statsSnapshot(),
      touched_item_ids: [...touchedItemIds],
    });
    checkpointTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: {
        generation_started: true,
        direct_generation_item_ids: contentRuntime.direct_generation_item_ids,
        pending_item_ids: contentRuntime.pending_item_ids.filter(id => !['success', 'ignored'].includes(sections[id]?.status)),
      },
    });
  } catch (error) {
    if (isAiQueueScopePausedError(error)) {
      persistPausedContentGeneration('正文生成已暂停，未发起的 AI 请求已从队列丢弃，可导出当前已完成内容，稍后继续。');
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'queue paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    if (isContentGenerationPausedError(error)) {
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    writeDeveloperLog('content.task.error', {
      error: error.message || '任务执行失败',
      stack: error.stack || '',
      stats: statsSnapshot(),
    });
    throw error;
  }
}

// 仅供开发者局部测试页复用当前正式正文扩写 patch runtime。
// 正式业务入口仍然只使用 runContentGenerationTask；测试页不得复制这组逻辑另起实现。
const __developerContentExpansionPatchRuntime = {
  normalizeContentExpansionPatch,
  validateContentExpansionPatch,
  buildContentExpansionRepairMessages,
  findContentExpansionTargetTextMatch,
  applyContentExpansionPatch,
};

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle, __developerContentExpansionPatchRuntime };
