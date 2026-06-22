const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');
const { createNoopDeveloperLogger } = require('../utils/developerLog.cjs');
const { applyRangeEdits } = require('../utils/textEdit.cjs');
const { countReadableWords } = require('../utils/wordCount.cjs');

const IMAGE_STYLES = new Set(['engineering_diagram', 'realistic_photo']);
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;
const MERMAID_REPAIR_ATTEMPTS = 3;
const MERMAID_RENDER_TIMEOUT_MS = 15000;
const MERMAID_IMAGE_CONCURRENCY = 5;
const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';
const MAX_OUTLINE_EXPANSION_ROUNDS = 3;
const OUTLINE_EXPANSION_STEPS_PER_ROUND = 6;
const OUTLINE_EXPANSION_TARGET_RATIO = 0.8;
const EARLY_CONTENT_PROBE_COUNT = 3;
const MIN_SECTION_EXPANSION_INCREMENT = 800;
const CONSISTENCY_AUDIT_GROUP_WORD_LIMIT = 300000;
const CONSISTENCY_REPAIR_MAX_ATTEMPTS = 2;
const ORIGINAL_PLAN_SEGMENT_MAX_CHARS = 6000;
const ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS = 2;
const TABLE_CLEANUP_CONTEXT_CHARS = 600;
const TABLE_CLEANUP_BATCH_CHAR_LIMIT = 30000;
const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';
const CONTENT_PLAN_VERSION = 2;
const PROMPT_CACHE_WARMUP_DELAY_MS = 5000;
const TABLE_REQUIREMENT_LABELS = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
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

function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function appendSelectedFactsMessage(messages, selectedFactsText) {
  const content = String(selectedFactsText || '').trim();
  if (!content) return;
  messages.push({
    role: 'user',
    content: `本章节需要使用的全局事实变量（正文涉及时优先使用这些变量值，保证全文一致）：\n${content}`,
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

function hasFactSelection(value) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  return Object.prototype.hasOwnProperty.call(source || {}, 'facts')
    || Object.prototype.hasOwnProperty.call(source || {}, 'fact_titles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'factTitles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'global_fact_titles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'globalFactTitles');
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

function normalizeConsistencyRepairMode(value) {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

function normalizeOriginalPlanCoverageRepairMode(value) {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

function normalizeMinimumWords(value) {
  const words = Number(value);
  return Math.max(0, Number.isFinite(words) ? Math.round(words) : 0);
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

function normalizeOriginalMaterial(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceIds = Array.isArray(source.source_ids || source.sourceIds)
    ? source.source_ids || source.sourceIds
    : [];
  const sourceTitles = Array.isArray(source.source_titles || source.sourceTitles)
    ? source.source_titles || source.sourceTitles
    : [];
  const sourceHashes = Array.isArray(source.source_hashes || source.sourceHashes)
    ? source.source_hashes || source.sourceHashes
    : [];
  return {
    restored: Boolean(source.restored),
    optimized: Boolean(source.optimized),
    source_ids: [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))],
    source_titles: [...new Set(sourceTitles.map((title) => singleLine(title)).filter(Boolean))],
    source_hashes: [...new Set(sourceHashes.map((hash) => String(hash || '').trim()).filter(Boolean))],
    restored_chars: Math.max(0, Math.round(Number(source.restored_chars ?? source.restoredChars) || 0)),
    ...(source.restored_at || source.restoredAt ? { restored_at: source.restored_at || source.restoredAt } : {}),
    ...(source.optimized_at || source.optimizedAt ? { optimized_at: source.optimized_at || source.optimizedAt } : {}),
  };
}

function normalizeContentPlan(value, allowedKnowledgeItemIds, allowedFactTitles) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  const writing = source.writing && typeof source.writing === 'object' && !Array.isArray(source.writing) ? source.writing : {};
  const knowledgeSource = source.knowledge;
  const knowledge = knowledgeSource && typeof knowledgeSource === 'object' && !Array.isArray(knowledgeSource) ? knowledgeSource : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds;
  const factsSource = source.facts;
  const facts = factsSource && typeof factsSource === 'object' && !Array.isArray(factsSource) ? factsSource : {};
  const rawFactTitles = Array.isArray(factsSource)
    ? factsSource
    : facts.titles ?? facts.fact_titles ?? facts.factTitles ?? source.fact_titles ?? source.factTitles ?? source.global_fact_titles ?? source.globalFactTitles;
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
    writing_focus: singleLine(source.writing_focus || source.writingFocus || writing.focus || writing.writing_focus || writing.writingFocus),
    knowledge: {
      item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowedKnowledgeItemIds),
    },
    facts: {
      titles: normalizeFactTitles(rawFactTitles, allowedFactTitles),
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
    original_material: normalizeOriginalMaterial(source.original_material || source.originalMaterial),
  };
}

function normalizeIllustrationType(value) {
  return ['ai', 'mermaid', 'none'].includes(value) ? value : 'none';
}

function createStoredContentPlan(plan, illustrationType, tableRequirement) {
  const normalizedTableRequirement = tableRequirement ? normalizeTableRequirement(tableRequirement) : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan: normalizeContentPlan(plan),
    illustration_type: normalizeIllustrationType(illustrationType),
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

  if (!hasFactSelection(value)) {
    return null;
  }

  const plan = normalizeContentPlan(value.plan || value.contentPlan || value);
  if (!plan.writing_focus) {
    return null;
  }
  const tableRequirement = value.table_requirement || value.tableRequirement
    ? normalizeTableRequirement(value.table_requirement || value.tableRequirement)
    : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan,
    illustration_type: normalizeIllustrationType(value.illustration_type || value.illustrationType),
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
  if (!plan.facts || !Array.isArray(plan.facts.titles)) {
    throw new Error('正文编排决策缺少 facts.titles');
  }
  if (typeof plan.writing_focus !== 'string' || !plan.writing_focus.trim()) {
    throw new Error('正文编排决策缺少 writing_focus');
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
    `写作重点：${plan.writing_focus || '围绕当前章节标题和描述展开'}`,
    `事实变量：${plan.facts?.titles?.length ? plan.facts.titles.join('；') : '无'}`,
    `表格：${plan.table.needed ? `需要，目的：${plan.table.purpose || '提升正文表达清晰度'}` : '不需要，本小节不要输出 Markdown 表格'}`,
    `AI 生图：${plan.image.needed ? `需要，风格：${plan.image.style}，标题：${plan.image.title}` : '不需要'}`,
    `原方案还原：${plan.original_material?.restored ? `已还原 ${plan.original_material.restored_chars || 0} 字` : '未还原'}`,
  ];
  return lines.join('\n');
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

function buildMermaidRepairMessages({ chapter, parentChapters, siblingChapters, projectOverview, selectedFactsText, regenerateRequirement, mermaidPlan, invalidCode, errorMessage, attempt }) {
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
  appendSelectedFactsMessage(messages, selectedFactsText);
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

function buildChapterContentPlanMessages({ chapter, parentChapters, siblingChapters, projectOverview, bidAnalysisFactsText, globalFactTitlesText, regenerateRequirement, tableRequirement, maxTables, tableTotalSections, imageGenerationAvailable, mermaidGenerationAvailable, maxAiImages, totalSections, knowledgeItems }) {
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
13. knowledge.item_ids 只能从参考知识库轻量条目的 id 中选择；可以多选，可以为空数组；不要编造 id，不要输出 reason。
14. facts.titles 只能从全局事实变量标题清单中选择；请选择编写本章节正文时会用到的变量组标题，可以多选，可以为空数组；不要编造标题，不要输出具体变量内容。
15. writing_focus 用 1-2 句话概括本节正文重点，只围绕当前章节标题和描述，不展开成正文，不编造具体承诺、参数、周期、品牌或型号。
16. 编排判断必须结合招标文件关键信息和全局事实变量标题，不要规划会造成时间、地点、人员、设备、标准或服务承诺前后不一致的表达。`,
    },
  ];

  messages.push({
    role: 'user',
    content: `参考知识库轻量条目（只包含 id、标题和简介，不包含正文；如无合适条目，knowledge.item_ids 返回空数组）：
${renderKnowledgeItemsForPrompt(knowledgeItems)}`,
  });

  messages.push({ role: 'user', content: `招标文件关键信息（用于判断正文需要引用哪些事实）：\n${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}` });
  if (String(globalFactTitlesText || '').trim()) {
    messages.push({ role: 'user', content: `Step04 全局事实变量标题清单（编排时只能选择标题，不要输出具体变量内容）：\n${globalFactTitlesText}` });
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
  "writing_focus": "1-2 句话说明本节正文重点展开什么，只聚焦当前章节，不写成正文",
  "knowledge": {
    "item_ids": ["从参考知识库轻量条目中选择的 id；没有合适条目时返回空数组"]
  },
  "facts": {
    "titles": ["从全局事实变量标题清单中选择正文会用到的变量组标题；没有需要引用的变量时返回空数组"]
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

function buildChapterContentMessages({ chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, preSectionInstruction }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const chapterDescription = chapter.description || '';
  const tableAllowed = Boolean(contentPlan?.table?.needed);
  const messages = [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 围绕当前章节标题、描述和正文编排重点展开，保持内容聚焦。
6. ${tableAllowed ? '可以使用 Markdown 段落、列表和表格；表格必须服务于内容表达，不要为了形式硬插。' : '只能使用 Markdown 段落、普通列表和加粗引导语，严禁输出 Markdown 表格或 HTML 表格。'}
7. ${tableAllowed ? '正文只生成文字、列表、表格等内容，配图由系统另行处理。' : '正文只生成文字和普通列表，配图由系统另行处理。'}
8. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown；配图由系统另行处理。
9. ${tableAllowed ? '表格单元格内如有多项内容，优先使用编号、顿号、分号或短句，不要使用 HTML <br> 标签。' : '如需表达多项参数、职责、流程或措施，请改用分段文字或普通列表，不要用表格模拟。'}
10. 严禁使用 Markdown 标题语法（#、##、###、####、#####、######），也不要生成与当前章节同级或下级的伪目录标题。
11. 如需在正文中分层表达，只能使用普通段落、列表、表格或加粗引导语，例如 **实施要点：**。
12. 直接返回章节内容，不生成标题，不要任何额外说明。
13. 如果本章节需要使用的全局事实变量中包含相关内容，必须优先使用变量值，不得前后矛盾。
14. 仅使用本章节提供的全局事实变量；未提供时不要主动编造具体人员、周期、质保、品牌、型号等会影响全文一致性的承诺。`,
    },
  ];

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }
  if (String(preSectionInstruction || '').trim()) {
    messages.push({ role: 'user', content: String(preSectionInstruction || '').trim() });
  }
  appendSelectedFactsMessage(messages, selectedFactsText);

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

请结合项目概述信息、本章节全局事实变量、参考正文素材和正文编排决策，围绕当前章节标题、描述和写作重点生成详细的专业内容。
直接返回编写的正文内容，不要输出标题、Markdown 标题、解释、总结等任何其他内容`,
  });

  return messages;
}

function buildRestoredChapterContentMessages({ chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent }) {
  const messages = buildChapterContentMessages({
    chapter,
    projectOverview,
    selectedFactsText,
    regenerateRequirement,
    contentPlan,
    knowledgeContents,
    preSectionInstruction: `当前章节已经从用户原方案中还原出正文底稿。该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

处理要求：
1. 首要遵从正文底稿，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节、增加过渡和说明，让正文更完整、更适合投标文件。
4. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
5. 输出当前章节完整正文，不输出标题。`,
  });
  const finalMessage = messages.pop();
  if (finalMessage) {
    messages.push(finalMessage);
  }
  messages.push({
    role: 'user',
    content: `已还原正文底稿：
${String(restoredContent || '').trim()}`,
  });
  messages.push({
    role: 'user',
    content: '请基于已还原正文底稿输出当前章节完整正文。必须保留底稿中的实质内容，可以优化扩写，但不要从零重写，不要输出标题或解释。',
  });
  return messages;
}

function splitLongOriginalSegment(segment) {
  const content = String(segment.content || '').trim();
  if (!content || content.length <= ORIGINAL_PLAN_SEGMENT_MAX_CHARS) {
    return content ? [segment] : [];
  }

  const paragraphs = content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let buffer = [];
  let size = 0;
  for (const paragraph of paragraphs.length ? paragraphs : [content]) {
    if (buffer.length && size + paragraph.length > ORIGINAL_PLAN_SEGMENT_MAX_CHARS) {
      chunks.push({ ...segment, content: buffer.join('\n\n') });
      buffer = [];
      size = 0;
    }
    buffer.push(paragraph);
    size += paragraph.length;
  }
  if (buffer.length) {
    chunks.push({ ...segment, content: buffer.join('\n\n') });
  }
  return chunks;
}

function splitOriginalPlanSegments(markdown) {
  const lines = normalizeNewlines(markdown).split('\n');
  const rawSegments = [];
  let titleStack = [];
  let currentTitlePath = [];
  let buffer = [];

  function flush() {
    const content = buffer.join('\n').trim();
    if (content) {
      rawSegments.push({ title_path: [...currentTitlePath], content });
    }
    buffer = [];
  }

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = singleLine(heading[2]);
      titleStack = titleStack.slice(0, level - 1);
      titleStack[level - 1] = title;
      currentTitlePath = titleStack.filter(Boolean);
      buffer.push(line.trim());
      continue;
    }
    buffer.push(line);
  }
  flush();

  const sourceSegments = rawSegments.length ? rawSegments : [{ title_path: [], content: String(markdown || '').trim() }];
  const segments = sourceSegments.flatMap(splitLongOriginalSegment)
    .map((segment, index) => {
      const content = String(segment.content || '').trim();
      return {
        id: `P${String(index + 1).padStart(3, '0')}`,
        title_path: Array.isArray(segment.title_path) ? segment.title_path.map((title) => singleLine(title)).filter(Boolean) : [],
        content,
        hash: textHash(content),
        chars: content.length,
      };
    })
    .filter((segment) => segment.content);

  return segments;
}

function formatOriginalSegmentsForPrompt(segments) {
  return (segments || []).map((segment) => `<original_segment id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content}
</original_segment>`).join('\n\n');
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

function buildOriginalMaterialRestoreMessages({ targets, originalSegments, projectOverview, bidAnalysisFactsText, globalFactTitlesText }) {
  return [
    {
      role: 'user',
      content: `你是投标技术方案原文归属判断助手。用户提供的原方案是本次要扩写的核心草稿。请判断每个原方案段落应该还原到当前目录的哪个叶子小节。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 你只能返回原方案段编号与叶子节点 ID 的映射，严禁改写、总结或生成正文。
3. node_id 必须逐字使用“当前可还原叶子节点”中给出的 ID。
4. source_ids 必须逐字使用“原方案段落”中的编号。
5. 每个原方案段默认只分配给一个最匹配的主节点；如果完全不适合当前叶子节点，可以不分配。
6. 优先按标题语义、章节职责、技术路线和同级章节边界归属，避免把同一内容拆散到无关章节。

返回格式：
{
  "assignments": [
    { "node_id": "1.1", "source_ids": ["P001", "P002"] }
  ]
}`,
    },
    { role: 'user', content: `招标文件关键信息：\n${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}` },
    { role: 'user', content: `Step04 全局事实变量标题清单：\n${globalFactTitlesText || '未提供'}` },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `原方案段落：\n${formatOriginalSegmentsForPrompt(originalSegments)}` },
    { role: 'user', content: '请只返回 JSON，不要生成正文。' },
  ];
}

function normalizeOriginalRestoreAssignments(value, context) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawAssignments = Array.isArray(source)
    ? source
    : Array.isArray(source.assignments)
      ? source.assignments
      : Array.isArray(source.items)
        ? source.items
        : [];
  const allowedNodeIds = context.allowedNodeIds || new Set();
  const allowedSourceIds = context.allowedSourceIds || new Set();
  const usedSourceIds = new Set();
  const byNode = new Map();

  for (const assignment of rawAssignments) {
    const nodeId = String(assignment?.node_id || assignment?.nodeId || assignment?.id || '').trim();
    if (!allowedNodeIds.has(nodeId)) {
      continue;
    }
    const rawSourceIds = Array.isArray(assignment.source_ids || assignment.sourceIds)
      ? assignment.source_ids || assignment.sourceIds
      : Array.isArray(assignment.sources)
        ? assignment.sources
        : [];
    const sourceIds = rawSourceIds
      .map((sourceId) => String(sourceId || '').trim())
      .filter((sourceId) => allowedSourceIds.has(sourceId) && !usedSourceIds.has(sourceId));
    if (!sourceIds.length) {
      continue;
    }
    for (const sourceId of sourceIds) {
      usedSourceIds.add(sourceId);
    }
    byNode.set(nodeId, [...(byNode.get(nodeId) || []), ...sourceIds]);
  }

  return {
    assignments: Array.from(byNode.entries()).map(([node_id, source_ids]) => ({
      node_id,
      source_ids: [...new Set(source_ids)],
    })),
  };
}

function validateOriginalRestoreAssignments(value) {
  if (!value || !Array.isArray(value.assignments)) {
    throw new Error('原方案还原映射缺少 assignments 数组');
  }
  for (const assignment of value.assignments) {
    if (!assignment.node_id || !Array.isArray(assignment.source_ids)) {
      throw new Error('原方案还原映射项缺少 node_id 或 source_ids');
    }
  }
}

function buildOriginalRestoreRepairMessages({ invalidContent, issues }, targets, originalSegments) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“原方案段落归属映射”JSON。

必须满足：
1. 顶层只能包含 assignments 数组。
2. 每条 assignment 必须包含 node_id 和 source_ids。
3. node_id 只能使用当前可还原叶子节点中的 ID。
4. source_ids 只能使用原方案段落编号。
5. 严禁输出正文、总结、解释或 Markdown。`,
    },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `可用原方案段编号：\n${(originalSegments || []).map((segment) => segment.id).join('、')}` },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
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

function formatOutlineExpansionContext(items, level = 1, lines = [], restoredNodeIds = new Set()) {
  for (const item of items || []) {
    const id = String(item?.id || 'unknown').trim() || 'unknown';
    const title = singleLine(item?.title || '未命名章节');
    const indent = '  '.repeat(Math.max(0, level - 1));
    const addState = restoredNodeIds.has(id) ? 'locked-restored' : level >= 1 && level <= 3 ? `add:L${level + 1}` : 'locked';
    lines.push(`${indent}- ${id} | L${level} | ${addState} | ${title}`);
    if (item?.children?.length) {
      formatOutlineExpansionContext(item.children, level + 1, lines, restoredNodeIds);
    }
  }
  return lines.join('\n');
}

function buildOutlineExpansionMessages({ projectOverview, globalFactsText, outlineData, currentWords, minimumWords, medianLeafWords, round, nodeMap, restoredNodeIds }) {
  const sampleParentId = Array.from(nodeMap.entries()).find(([id, info]) => info.level === 1 && !restoredNodeIds?.has(id))?.[0] || '1';
  return [
    {
      role: 'user',
      content: `你是投标技术方案目录补充专家。当前技术方案正文字数不足，需要通过补充二级、三级或四级目录扩展可生成正文的空间。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只能新增二级、三级、四级目录，严禁新增、删除、重命名或调整一级目录。
3. parent_id 只能使用目录上下文中标记为 add:* 的节点 ID，必须逐字复制；locked 和 locked-restored 节点不能作为 parent_id。
4. 只输出新增目录，不要输出完整目录，不要输出正文内容。
5. 允许补充通用但不违背项目的技术方案内容，例如组织管理、质量控制、安全管理、进度保障、验收交付、运维服务、培训计划、资料管理、风险控制、应急响应等。
6. 不要重复已有目录，不要输出明显凑字数的空泛标题。
7. 四级目录不能再包含 children。
8. 新增目录不得引入与全局事实变量冲突的项目范围、周期、地点、验收、质保、售后或技术边界方向。
9. locked-restored 节点已经承载用户原方案正文，严禁新增子节点，不允许把已还原正文节点拆成下级目录。

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
    ...(String(globalFactsText || '').trim() ? [{ role: 'user', content: `全局事实变量（新增目录不得冲突）：\n${globalFactsText}` }] : []),
    { role: 'user', content: `目录上下文（每行：id | 层级 | 可挂载状态 | 标题）：\n${formatOutlineExpansionContext(outlineData.outline || [], 1, [], restoredNodeIds)}` },
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
    if (context.restoredNodeIds?.has(parentId)) {
      issues.push(`additions[${index}].parent_id 不能使用已还原原方案正文的节点：${parentId}`);
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

function buildOutlineExpansionRepairMessages({ invalidContent, issues }, outlineItems, restoredNodeIds = new Set()) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“最低字数补目录”JSON。

必须满足：
1. 顶层只能有 additions 数组。
2. 每条 additions 必须包含 parent_id、title、description，可以包含 children。
3. parent_id 只能使用目录上下文中标记为 add:* 的节点 ID，必须逐字复制；locked 和 locked-restored 节点不能作为 parent_id。
4. 只能新增二级、三级、四级目录；四级目录不能包含 children。
5. 禁止输出完整 outline、正文、图片、表格或解释文字。
6. 如果没有可补充目录，返回 {"additions":[]}。
7. locked-restored 节点已经承载用户原方案正文，严禁新增子节点。

目录上下文（每行：id | 层级 | 可挂载状态 | 标题）：
${formatOutlineExpansionContext(outlineItems || [], 1, [], restoredNodeIds)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildContentExpansionMessages({ outlineData, context, projectOverview, selectedFactsText, currentContent, currentWords, targetWords }) {
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
9. 严禁使用 Markdown 标题语法（#、##、###、####、#####、######），也不要新增伪目录标题；需要分层时使用加粗引导语或列表。
10. 如果本章节需要使用的全局事实变量中包含相关内容，扩写必须优先使用变量值，不得新增前后不一致的时间、地点、人员、设备、标准或服务承诺。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "content": "扩写后的新增段落或替换段落"
}`,
    },
    { role: 'user', content: `项目概述：\n${projectOverview || '未提供'}` },
    { role: 'user', content: `完整目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    ...(String(selectedFactsText || '').trim() ? [{ role: 'user', content: `本章节需要使用的全局事实变量（扩写涉及这些内容时必须参考）：\n${selectedFactsText}` }] : []),
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
7. content 不得包含章节标题、Markdown 标题、图片 Markdown、Mermaid、代码块或解释文字。
8. 只返回 JSON，不要输出 Markdown 代码围栏或解释。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripPromptLineNumbers(text) {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => line.replace(/^\[\d{1,6}\]\s?/, ''))
    .join('\n');
}

function normalizeConsistencyPatchText(text) {
  return stripPromptLineNumbers(text).trim();
}

function formatChapterPath(context) {
  return [...(context.parentChapters || []), context.item]
    .map((chapter) => `${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}`)
    .join(' > ');
}

function formatContentWithLineNumbers(content) {
  const lines = normalizeNewlines(content).split('\n');
  const width = Math.max(3, String(lines.length).length);
  return lines
    .map((line, index) => `[${String(index + 1).padStart(width, '0')}] ${line}`)
    .join('\n');
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

function findExactOccurrences(content, search) {
  const indexes = [];
  if (!search) return indexes;
  let startIndex = 0;
  while (startIndex <= content.length) {
    const index = content.indexOf(search, startIndex);
    if (index < 0) break;
    indexes.push(index);
    startIndex = index + search.length;
  }
  return indexes;
}

function extractLineRangeText(content, startLine, endLine) {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > lines.length) {
    return null;
  }
  return lines.slice(start - 1, end).join('\n');
}

function replaceLineRange(content, startLine, endLine, replacement) {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...normalizeNewlines(replacement).split('\n'),
    ...lines.slice(end),
  ];
  return nextLines.join('\n');
}

function describeConsistencyPatchMatch(content, patch) {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  const detail = {
    section_id: singleLine(patch.section_id),
    start_line: Number.isFinite(startLine) ? startLine : 0,
    end_line: Number.isFinite(endLine) ? endLine : 0,
    old_text: oldText,
    new_text: newText,
    old_text_metrics: textMetrics(oldText),
    new_text_metrics: textMetrics(newText),
    before_content_metrics: textMetrics(currentContent),
    line_range: null,
    exact_match_count: 0,
  };

  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    detail.line_range = {
      exists: candidate !== null,
      matches_old_text: candidate === oldText,
      candidate_metrics: candidate === null ? null : textMetrics(candidate),
    };
  }

  detail.exact_match_count = findExactOccurrences(currentContent, oldText).length;
  return detail;
}

function applyExactConsistencyPatch(content, patch) {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  if (!oldText) {
    throw new Error('old_text 为空');
  }
  if (!newText) {
    throw new Error('new_text 为空');
  }
  if (oldText === newText) {
    throw new Error('old_text 与 new_text 相同');
  }

  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    if (candidate === oldText) {
      return replaceLineRange(currentContent, startLine, endLine, newText);
    }
  }

  const matches = findExactOccurrences(currentContent, oldText);
  if (!matches.length) {
    throw new Error('old_text 未在当前小节正文中找到');
  }
  if (matches.length > 1) {
    throw new Error('old_text 在当前小节正文中出现多次，请提供更多上下文确保唯一定位');
  }
  const index = matches[0];
  return `${currentContent.slice(0, index)}${newText}${currentContent.slice(index + oldText.length)}`;
}

function applyConsistencyRepairPatches(content, patches) {
  let nextContent = normalizeNewlines(content);
  const errors = [];
  const patchResults = [];
  let appliedCount = 0;

  for (const [index, patch] of (patches || []).entries()) {
    const detail = { index, ...describeConsistencyPatchMatch(nextContent, patch) };
    try {
      nextContent = applyExactConsistencyPatch(nextContent, patch);
      appliedCount += 1;
      patchResults.push({
        ...detail,
        applied: true,
        after_content_metrics: textMetrics(nextContent),
      });
    } catch (error) {
      errors.push(`patch[${index}] ${error.message || '应用失败'}`);
      patchResults.push({
        ...detail,
        applied: false,
        error: error.message || '应用失败',
        after_content_metrics: textMetrics(nextContent),
      });
    }
  }

  return { content: nextContent, appliedCount, errors, patchResults };
}

function formatConsistencyAuditGroupContent(group) {
  return (group.items || []).map((entry) => `<section>
编号：${entry.item.id || 'unknown'}
标题：${entry.item.title || '未命名章节'}
路径：${formatChapterPath(entry)}
正文：
${entry.content || ''}
</section>`).join('\n\n');
}

function buildConsistencyAuditMessages({ group, globalFactsText, bidAnalysisFactsText }) {
  const allowedIds = (group.items || []).map(({ item }) => item.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是投标技术方案全文一致性审计助手。请审计本组正文是否与给定事实冲突。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只找正文中已经明确写出、且与事实相违背的内容。
3. 正文没有涉及某条事实时，不要报告缺失，不要建议补充。
4. 不报告文风、质量、重复、篇幅、表达优化等问题。
5. section_id 必须来自允许的目录编号清单，禁止编造编号。
6. 只筛选冲突目录编号和冲突证据，不要重写正文。

返回格式：
{
  "conflicts": [
    {
      "section_id": "1.2.3",
      "fact_title": "相关事实变量标题",
      "evidence": "正文中的冲突原文摘录",
      "reason": "为什么与事实冲突",
      "severity": "high"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `允许返回的目录编号清单：\n${JSON.stringify(allowedIds, null, 2)}` },
    { role: 'user', content: `待审计正文分组：\n${formatConsistencyAuditGroupContent(group)}` },
  ];
}

function normalizeConsistencyAuditResponse(value, allowedSectionIds) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawConflicts = Array.isArray(source)
    ? source
    : Array.isArray(source.conflicts)
      ? source.conflicts
      : Array.isArray(source.items)
        ? source.items
        : [];
  const allowed = allowedSectionIds instanceof Set ? allowedSectionIds : new Set(allowedSectionIds || []);
  const issues = [];
  const conflicts = [];

  rawConflicts.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`conflicts[${index}] 必须是对象`);
      return;
    }
    const sectionId = singleLine(item.section_id || item.sectionId || item.id || item.chapter_id || item.chapterId);
    if (!sectionId || !allowed.has(sectionId)) {
      issues.push(`conflicts[${index}].section_id 无效：${sectionId || '空'}`);
      return;
    }
    conflicts.push({
      section_id: sectionId,
      fact_title: singleLine(item.fact_title || item.factTitle || item.fact || item.title),
      evidence: String(item.evidence || item.quote || item.source || '').trim(),
      reason: String(item.reason || item.description || item.issue || '').trim(),
      severity: singleLine(item.severity || 'medium') || 'medium',
    });
  });

  if (issues.length) {
    throw new Error(`审计结果格式无效：${issues.join('；')}`);
  }
  return { conflicts };
}

function validateConsistencyAuditResponse(value) {
  if (!value || !Array.isArray(value.conflicts)) {
    throw new Error('一致性审计结果缺少 conflicts 数组');
  }
}

function buildConsistencyAuditRepairMessages({ invalidContent, issues }, allowedSectionIds) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“全文一致性审计”JSON。

必须满足：
1. 顶层只能包含 conflicts 数组。
2. conflicts 可以为空数组。
3. 每条 conflict 必须包含 section_id、fact_title、evidence、reason、severity。
4. section_id 只能来自允许清单。
5. 禁止输出正文、修复方案、Markdown 或解释文字。

允许的 section_id：
${JSON.stringify(Array.from(allowedSectionIds || []), null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildConsistencyRepairMessages({ context, conflicts, globalFactsText, bidAnalysisFactsText, currentContent, attempt, failures, tableRequirement }) {
  const { item } = context;
  const tableAllowed = normalizeTableRequirement(tableRequirement) !== 'none';
  const failureBlock = (failures || []).length
    ? `\n上次修复应用失败原因：\n${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回能够在当前正文中唯一定位的 old_text。`
    : '';

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文一致性修复助手。请只针对当前小节返回局部精确替换 patch。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回需要局部替换的 patches。
3. 事实输入比当前小节实际需要的更多；正文没有涉及的事实必须忽略。
4. 目标只修正正文中与事实冲突的内容，不要参照事实重写或扩充正文。
5. 不要优化文风，不要新增无关事实，不要新增新的承诺。
6. old_text 必须是当前小节正文中逐字存在的原文块，建议包含足够前后上下文，确保只出现一次。
7. ${tableAllowed ? '如果修改表格，old_text 必须包含完整表格行或完整表格块，不要只返回单元格碎片。' : '本次配置为不要表格；如果冲突位于表格中，new_text 必须把相关内容改为普通文字或普通列表，不得继续返回 Markdown 表格或 HTML 表格。'}
8. new_text 是替换后的正文块，不要包含章节标题，不要包含行号。
9. ${tableAllowed ? '保留 Markdown 表格、列表、代码块、图片和 Mermaid 块结构。' : '保留普通列表、代码块、图片和 Mermaid 块结构；不得新增或保留 Markdown 表格、HTML 表格。'}
10. start_line/end_line 使用下方带行号正文中的 1-based 行号；如果不确定也必须提供可唯一匹配的 old_text。

返回格式：
{
  "patches": [
    {
      "section_id": "当前小节编号",
      "start_line": 2,
      "end_line": 4,
      "old_text": "当前正文中逐字存在且唯一的原文块，不包含行号",
      "new_text": "替换后的正文块，不包含行号",
      "reason": "修复了哪个事实冲突"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `当前小节：${item.id || 'unknown'} ${item.title || '未命名章节'}\n路径：${formatChapterPath(context)}\n描述：${item.description || ''}` },
    { role: 'user', content: `审计发现的冲突：\n${JSON.stringify(conflicts || [], null, 2)}` },
    { role: 'user', content: `当前小节正文（带行号；patch 的 old_text/new_text 不要包含这些行号）：\n${formatContentWithLineNumbers(currentContent)}` },
    { role: 'user', content: `patches[*].section_id 必须是 ${item.id || 'unknown'}。修复尝试次数：${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
  ];
}

function normalizeConsistencyRepairResponse(value, expectedSectionId) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatches = Array.isArray(source)
    ? source
    : Array.isArray(source.patches)
      ? source.patches
      : Array.isArray(source.operations)
        ? source.operations
        : (source.old_text || source.oldText || source.new_text || source.newText)
          ? [source]
          : [];
  const patches = rawPatches.map((patch) => {
    const rawSectionId = singleLine(patch?.section_id || patch?.sectionId || patch?.id || '');
    const sectionId = rawSectionId && rawSectionId !== '当前小节编号' ? rawSectionId : expectedSectionId;
    return {
      section_id: sectionId,
      start_line: Number(patch?.start_line ?? patch?.startLine ?? patch?.line_start ?? patch?.lineStart ?? 0) || 0,
      end_line: Number(patch?.end_line ?? patch?.endLine ?? patch?.line_end ?? patch?.lineEnd ?? 0) || 0,
      old_text: normalizeConsistencyPatchText(patch?.old_text ?? patch?.oldText ?? patch?.original ?? patch?.before ?? ''),
      new_text: normalizeConsistencyPatchText(patch?.new_text ?? patch?.newText ?? patch?.replacement ?? patch?.after ?? ''),
      reason: String(patch?.reason || patch?.description || '').trim(),
    };
  });
  const invalidSection = patches.find((patch) => expectedSectionId && patch.section_id !== expectedSectionId);
  if (invalidSection) {
    throw new Error(`一致性修复结果 section_id 无效：${invalidSection.section_id || '空'}`);
  }
  return { patches };
}

function validateConsistencyRepairResponse(value) {
  if (!value || !Array.isArray(value.patches)) {
    throw new Error('一致性修复结果缺少 patches 数组');
  }
  value.patches.forEach((patch, index) => {
    if (!patch.section_id) {
      throw new Error(`patches[${index}].section_id 缺失`);
    }
    if (!patch.old_text) {
      throw new Error(`patches[${index}].old_text 缺失`);
    }
    if (!patch.new_text) {
      throw new Error(`patches[${index}].new_text 缺失`);
    }
    if (patch.old_text === patch.new_text) {
      throw new Error(`patches[${index}].old_text 与 new_text 相同`);
    }
  });
}

function buildConsistencyRepairJsonRepairMessages({ invalidContent, issues }, expectedSectionId) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“正文一致性局部修复”JSON。

必须满足：
1. 顶层只能包含 patches 数组。
2. 每条 patch 必须包含 section_id、start_line、end_line、old_text、new_text、reason。
3. section_id 必须是 ${expectedSectionId}。
4. old_text 和 new_text 都不能包含行号，不能相同，不能为空。
5. 不要返回完整正文，不要输出 Markdown 或解释文字。
6. 如果无法修复，返回 {"patches":[]}。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

const ORIGINAL_COVERAGE_STATUSES = new Set(['covered', 'partial', 'missing', 'conflict']);

function normalizeOriginalCoverageStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (ORIGINAL_COVERAGE_STATUSES.has(text)) return text;
  if (['已覆盖', '覆盖', '完整', '保留', '保留完整'].includes(text)) return 'covered';
  if (['部分', '部分覆盖', '部分保留', 'partial_covered'].includes(text)) return 'partial';
  if (['缺失', '未覆盖', '未保留', '遗漏'].includes(text)) return 'missing';
  if (['冲突', '矛盾', '不一致'].includes(text)) return 'conflict';
  return text;
}

function formatOriginalCoverageSources(sources) {
  return (sources || []).map((segment) => `<source id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content || ''}
</source>`).join('\n\n');
}

function buildOriginalCoverageAuditMessages({ target }) {
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是投标技术方案原方案覆盖审计助手。请检查当前小节正文是否保留了原方案来源段中的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 必须对每个 source_id 返回一条 items 记录，covered 也必须返回。
3. 可接受改写、扩写、调序、合并和专业化表达；不要因为不是逐字一致就判为缺失。
4. 重点检查原方案中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法是否仍然保留。
5. status 只能是 covered、partial、missing、conflict。
6. covered 表示核心内容已经保留；partial 表示部分核心信息缺失；missing 表示该来源段核心内容基本没有体现；conflict 表示正文与来源段核心事实明显相反或矛盾。
7. conflict 只报告，不要求修复；partial/missing 请给出 missing_points 和 repair_suggestion。
8. node_id 必须是当前小节编号，source_id 必须来自允许清单。

返回格式：
{
  "items": [
    {
      "source_id": "P001",
      "node_id": "当前小节编号",
      "status": "covered",
      "missing_points": [],
      "repair_suggestion": ""
    }
  ]
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `允许的 source_id：\n${JSON.stringify(allowedSourceIds, null, 2)}` },
    { role: 'user', content: `原方案来源段：\n${formatOriginalCoverageSources(target.sources)}` },
    { role: 'user', content: `当前小节正文：\n${target.content || ''}` },
    { role: 'user', content: '请只返回覆盖审计 JSON。' },
  ];
}

function normalizeOriginalCoverageAuditResponse(value, context = {}) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawItems = Array.isArray(source)
    ? source
    : Array.isArray(source.items)
      ? source.items
      : Array.isArray(source.results)
        ? source.results
        : Array.isArray(source.coverage)
          ? source.coverage
          : [];
  const allowedSourceIds = context.allowedSourceIds instanceof Set ? context.allowedSourceIds : new Set(context.allowedSourceIds || []);
  const expectedNodeId = String(context.expectedNodeId || '').trim();
  const issues = [];
  const items = [];
  const seenSourceIds = new Set();

  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`items[${index}] 必须是对象`);
      return;
    }
    const sourceId = String(item.source_id || item.sourceId || item.id || '').trim();
    if (!sourceId || !allowedSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 无效：${sourceId || '空'}`);
      return;
    }
    if (seenSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 重复：${sourceId}`);
      return;
    }
    const rawNodeId = singleLine(item.node_id || item.nodeId || item.section_id || item.sectionId || '');
    const nodeId = rawNodeId && rawNodeId !== '当前小节编号' ? rawNodeId : expectedNodeId;
    if (!nodeId || (expectedNodeId && nodeId !== expectedNodeId)) {
      issues.push(`items[${index}].node_id 无效：${nodeId || '空'}`);
      return;
    }
    const status = normalizeOriginalCoverageStatus(item.status || item.coverage_status || item.coverageStatus);
    if (!ORIGINAL_COVERAGE_STATUSES.has(status)) {
      issues.push(`items[${index}].status 无效：${status || '空'}`);
      return;
    }
    const rawMissingPoints = Array.isArray(item.missing_points || item.missingPoints)
      ? item.missing_points || item.missingPoints
      : item.missing_point || item.missingPoint || item.reason
        ? [item.missing_point || item.missingPoint || item.reason]
        : [];
    seenSourceIds.add(sourceId);
    items.push({
      source_id: sourceId,
      node_id: nodeId,
      status,
      missing_points: rawMissingPoints.map((point) => String(point || '').trim()).filter(Boolean),
      repair_suggestion: String(item.repair_suggestion || item.repairSuggestion || item.suggestion || '').trim(),
    });
  });

  if (issues.length) {
    throw new Error(`原方案覆盖审计结果格式无效：${issues.join('；')}`);
  }
  return { items };
}

function validateOriginalCoverageAuditResponse(value, allowedSourceIds) {
  if (!value || !Array.isArray(value.items)) {
    throw new Error('原方案覆盖审计结果缺少 items 数组');
  }
  const allowed = allowedSourceIds instanceof Set ? allowedSourceIds : new Set(allowedSourceIds || []);
  const seen = new Set(value.items.map((item) => item.source_id).filter(Boolean));
  const missing = Array.from(allowed).filter((sourceId) => !seen.has(sourceId));
  if (missing.length) {
    throw new Error(`原方案覆盖审计缺少 source_id：${missing.join('、')}`);
  }
}

function buildOriginalCoverageAuditJsonRepairMessages({ invalidContent, issues }, target) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“原方案覆盖审计”JSON。

必须满足：
1. 顶层只能包含 items 数组。
2. 必须为每个 source_id 返回一条 item，不能遗漏，不能重复。
3. 每条 item 必须包含 source_id、node_id、status、missing_points、repair_suggestion。
4. node_id 必须是 ${target.item.id || 'unknown'}。
5. status 只能是 covered、partial、missing、conflict。
6. 禁止输出正文、修复 patch、Markdown 或解释文字。

允许的 source_id：
${JSON.stringify(allowedSourceIds, null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildOriginalCoverageRepairMessages({ target, coverageItems, currentContent, attempt, failures }) {
  const failureBlock = (failures || []).length
    ? `\n上次补写应用失败原因：\n${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回可应用的 insert/replace patch。`
    : '';
  const sourceById = new Map((target.sources || []).map((segment) => [segment.id, segment]));
  const issueSourceIds = [...new Set((coverageItems || []).map((item) => item.source_id).filter(Boolean))];
  const issueSources = issueSourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean);

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文原方案覆盖修复助手。请只针对当前小节返回一次局部补写 patch，用于补回原方案中缺失的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回一次 insert 或 replace 操作。
3. operation 只能是 "insert" 或 "replace"。
4. 优先使用 insert 在合适段落后补充缺失内容；如果正文已有同主题但内容不完整，可使用 replace 扩写该段。
5. anchor 填写建议插入/替换的当前正文段落关键摘录；适合放末尾时写 "end"。
6. content 只写新增或替换后的正文片段，不要包含章节标题。
7. 必须补回审计指出的 partial/missing 核心信息，但不要提到“原方案”“来源段”“用户原文”。
8. 不要新增图片 Markdown、Mermaid、代码块或伪目录标题。
9. 保持与当前小节职责一致，不要写其他章节内容。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "content": "补写后的正文片段"
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `需要补回的原方案来源段：\n${formatOriginalCoverageSources(issueSources)}` },
    { role: 'user', content: `覆盖审计问题：\n${JSON.stringify(coverageItems || [], null, 2)}` },
    { role: 'user', content: `当前小节正文：\n${currentContent || ''}` },
    { role: 'user', content: `补写尝试次数：${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
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

function normalizeReferenceDocumentIds(storedPlan) {
  const raw = storedPlan?.referenceKnowledgeDocumentIds ?? [];
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

async function prepareRenderableMermaidPlan({ aiService, context, projectOverview, selectedFactsText, regenerateRequirement, mermaidPlan }) {
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
          selectedFactsText,
          regenerateRequirement,
          mermaidPlan: currentPlan,
          invalidCode: currentPlan.code,
          errorMessage: compactError(lastError?.message || lastError),
          attempt,
        }),
        temperature: 0.1,
        logTitle: `Mermaid配图修复-${item.id}-${currentPlan.title || item.title || '未命名章节'}`,
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
      if (isPauseLikeError(error)) {
        throw error;
      }
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

async function runContentGenerationTask({ aiService, agentService, workspaceStore, knowledgeBaseService, updateTask, payload, taskControl, previousState }) {
  const resume = Boolean(payload.resume);
  const storedPlan = resume ? (previousState || {}) : (workspaceStore.loadTechnicalPlan() || {});
  let outlineData = storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const globalFacts = Array.isArray(storedPlan.globalFacts) ? storedPlan.globalFacts : [];
  const globalFactsText = formatGlobalFactsForPrompt(globalFacts);
  if (!globalFactsText || storedPlan.globalFactsTask?.status !== 'success') {
    throw new Error('请先完成全局事实设定，再生成正文');
  }
  const globalFactTitlesText = formatGlobalFactTitlesForPrompt(globalFacts);
  const allowedFactTitles = new Set(globalFacts.map((group) => singleLine(group?.title)).filter(Boolean));
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan);
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  let originalPlanSegments = [];
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成正文');
    }
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成正文');
    }
    originalPlanSegments = splitOriginalPlanSegments(originalPlanMarkdown);
    if (!originalPlanSegments.length) {
      throw new Error('原方案正文为空，无法执行已有方案扩写');
    }
  }
  const originalPlanSegmentById = new Map(originalPlanSegments.map((segment) => [segment.id, segment]));

  const projectOverview = outlineData.project_overview || storedPlan.projectOverview || '';
  const techRequirements = storedPlan.techRequirements || '';
  if (resume && storedPlan.contentGenerationTask?.status !== 'paused') {
    throw new Error('没有可继续的已暂停正文生成任务');
  }
  let contentRuntime = normalizeContentGenerationRuntime(resume ? storedPlan.contentGenerationRuntime : {});
  const retryContentCorrection = !resume && Boolean(payload.retryContentCorrection ?? payload.retry_content_correction);
  const regenerate = !resume && !retryContentCorrection && Boolean(payload.regenerate);
  const targetItemId = resume ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  if (retryContentCorrection && targetItemId) {
    throw new Error('单小节重新生成不支持重试内容矫正');
  }
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
  const aiConfig = aiService.getConfig ? aiService.getConfig() : {};
  const contentConcurrency = normalizeContentConcurrency(aiConfig.concurrency_limit);
  const imageConcurrency = normalizeImageConcurrency(aiConfig.image_model?.concurrency_limit);
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const minimumWords = targetItemId ? 0 : normalizeMinimumWords(generationOptions.minimumWords ?? generationOptions.minimum_words);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const imageAvailability = aiService.getImageModelAvailability
    ? aiService.getImageModelAvailability()
    : { available: false, message: '生图模型不可用' };
  const aiImagesEnabled = Boolean(generationOptions.useAiImages ?? generationOptions.use_ai_images ?? imageAvailability.available) && imageAvailability.available;
  const mermaidImagesEnabled = Boolean(generationOptions.useMermaidImages ?? generationOptions.use_mermaid_images ?? Boolean(targetItemId));
  const enableConsistencyAudit = Boolean(generationOptions.enableConsistencyAudit ?? generationOptions.enable_consistency_audit ?? true);
  const requestedConsistencyRepairMode = normalizeConsistencyRepairMode(generationOptions.consistencyRepairMode ?? generationOptions.consistency_repair_mode);
  const consistencyRepairMode = targetItemId ? 'normal' : requestedConsistencyRepairMode;
  const enableOriginalPlanCoverageAudit = isExpansionWorkflow && Boolean(generationOptions.enableOriginalPlanCoverageAudit ?? generationOptions.enable_original_plan_coverage_audit ?? false);
  const requestedOriginalPlanCoverageRepairMode = isExpansionWorkflow
    ? normalizeOriginalPlanCoverageRepairMode(generationOptions.originalPlanCoverageRepairMode ?? generationOptions.original_plan_coverage_repair_mode)
    : 'agent';
  const originalPlanCoverageRepairMode = isExpansionWorkflow && !targetItemId ? requestedOriginalPlanCoverageRepairMode : 'normal';
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
    outline_expansion_step_total: MAX_OUTLINE_EXPANSION_ROUNDS * OUTLINE_EXPANSION_STEPS_PER_ROUND,
    outline_expansion_step_completed: 0,
    outline_expansion_round: 0,
    outline_expansion_round_total: MAX_OUTLINE_EXPANSION_ROUNDS,
    outline_expansion_step_label: '',
    minimum_words: minimumWords,
    current_words: 0,
    audit_group_total: 0,
    audit_group_completed: 0,
    audit_conflict_total: 0,
    audit_fix_total: 0,
    audit_fix_completed: 0,
    audit_fix_failed: 0,
    audit_repair_mode: enableConsistencyAudit ? consistencyRepairMode : '',
    audit_agent_step_total: 0,
    audit_agent_step_completed: 0,
    audit_agent_step_label: '',
    audit_agent_changed_sections: 0,
    audit_agent_failed_sections: 0,
    table_cleanup_total: 0,
    table_cleanup_completed: 0,
    table_cleanup_rewritten: 0,
    table_cleanup_skipped: 0,
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
    const originalState = getOriginalMaterialRuntimeState(item);
    return regenerate || section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair;
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
    if (successfulIds.length !== leaves.length) {
      throw new Error('只有正文全部生成成功后，才能重试内容矫正');
    }
    successfulIds.forEach((itemId) => touchedItemIds.add(itemId));
    tasksToRun = [];
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
  let logs = [retryContentCorrection
    ? `准备重试内容矫正，共 ${leaves.length} 个已生成小节。`
    : resume
      ? `继续已暂停的正文生成任务，共 ${leaves.length} 个小节。`
      : `准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  }
  logs = [...logs, `文本模型并发上限：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  logs = [...logs, aiImagesEnabled
    ? `AI 生图已启用，将在整体编排后择优生成，全文最多 ${configuredMaxAiImages} 张，本轮最多新增 ${runLimits.maxAiImagesForRun} 张。`
    : 'AI 生图未启用或不可用，本次不会调用生图接口。'];
  if (minimumWords > 0) {
    logs = [...logs, `最低字数已启用：${minimumWords} 字，将在采样预估后补目录，并在正文生成后扩写补足。`];
  }
  logs = [...logs, mermaidImagesEnabled
    ? 'Mermaid 图片已启用，适合简单图示的小节会优先使用 Mermaid 图。'
    : 'Mermaid 图片未启用。'];
  logs = [...logs, enableConsistencyAudit
    ? `全文一致性审计已启用，正文扩写完成后将在配图前使用${consistencyRepairMode === 'agent' ? ' Agent 修复' : '普通修复'}检查并修复事实冲突。`
    : '全文一致性审计未启用，本次正文生成将直接进入配图阶段。'];
  if (isExpansionWorkflow) {
    logs = [...logs, `已有方案扩写模式：已读取原方案并拆分为 ${originalPlanSegments.length} 个原文段。`];
    logs = [...logs, enableOriginalPlanCoverageAudit
      ? targetItemId
        ? '原方案覆盖审计已启用，本次将使用普通模式检查并修复当前小节的原文保留情况。'
        : `原方案覆盖审计已启用，本次将使用${originalPlanCoverageRepairMode === 'agent' ? ' Agent' : '普通模式'}检查并补回原文保留情况。`
      : '原方案覆盖审计未启用。'];
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
      leaf_count: leaves.length,
      task_count: tasksToRun.length,
      text_concurrency_limit: contentConcurrency,
      table_requirement: tableRequirement,
      minimum_words: minimumWords,
      ai_images_enabled: aiImagesEnabled,
      mermaid_images_enabled: mermaidImagesEnabled,
      enable_consistency_audit: enableConsistencyAudit,
      requested_consistency_repair_mode: requestedConsistencyRepairMode,
      consistency_repair_mode: consistencyRepairMode,
      enable_original_plan_coverage_audit: enableOriginalPlanCoverageAudit,
      requested_original_plan_coverage_repair_mode: requestedOriginalPlanCoverageRepairMode,
      original_plan_coverage_repair_mode: originalPlanCoverageRepairMode,
      original_plan_segment_count: originalPlanSegments.length,
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
      cause: error?.cause?.message || error?.cause?.code || error?.openCodeCause || '',
      stack: error?.stack || '',
      agent_task_id: error?.agentTaskId || '',
      agent_title: error?.agentTitle || '',
      agent_workspace_dir: error?.agentWorkspaceDir || '',
      agent_runtime_root: error?.agentRuntimeRoot || '',
      agent_output_file: error?.agentOutputFile || '',
      agent_output_path: error?.agentOutputPath || '',
      agent_partial_output_chars: error?.agentPartialOutputChars || String(error?.agentPartialOutput || '').length,
      opencode_route: error?.openCodeRoute || '',
      opencode_method: error?.openCodeMethod || '',
      opencode_status: error?.openCodeStatus || 0,
      opencode_duration_ms: error?.openCodeDurationMs || 0,
      opencode_cause: error?.openCodeCause || '',
      opencode_request_log: Array.isArray(error?.openCodeRequestLog) ? error.openCodeRequestLog : [],
      opencode_stderr_tail: error?.openCodeStderrTail || '',
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
      const result = await agentService.runTask(payload);
      writeDeveloperLog(`${eventPrefix}.opencode.done`, {
        agent_task_id: result?.task_id || '',
        agent_session_id: result?.session_id || '',
        agent_workspace_dir: result?.workspace_dir || '',
        agent_runtime_root: result?.runtime_root || '',
        output_file: result?.output_file || '',
        output_metrics: textMetrics(result?.output_content || ''),
        opencode_request_log: result?.opencode_request_log || [],
        opencode_stderr_tail: result?.opencode_stderr_tail || '',
      });
      return result;
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        throw error;
      }
      const diagnostics = agentErrorDiagnostics(error);
      writeDeveloperLog(`${eventPrefix}.opencode.error`, diagnostics);
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
        task_id: error?.agentTaskId || '',
        title: error?.agentTitle || payload.title || 'Agent 任务',
        workspace_dir: error?.agentWorkspaceDir || '',
        runtime_root: error?.agentRuntimeRoot || '',
        output_file: error?.agentOutputFile || payload.output_file || '',
        output_content: recoveredOutput,
        assistant_text: '',
        diff: [],
        session_id: '',
        opencode_request_log: diagnostics.opencode_request_log,
        opencode_stderr_tail: diagnostics.opencode_stderr_tail,
      };
    }
  }

  writeDeveloperLog('content.task.started', {
    sections: leaves.map(({ item }) => ({ id: item.id, title: item.title || '未命名章节' })),
    tasks_to_run: tasksToRun.map(({ item }) => item.id),
  });

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

  function persistPausedContentGeneration(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    logs = [...logs, message];
    const runtime = syncRuntime();
    const saved = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
      contentGenerationTask: updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }),
    });
    updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, saved);
  }

  function pauseIfRequested(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    if (!isPauseRequested()) {
      return;
    }

    persistPausedContentGeneration(message);
    throw createContentGenerationPausedError();
  }

  async function waitForPromptCacheWarmupBeforeFanout(message) {
    logs = [...logs, message];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    await waitForPromptCacheWarmup();
    pauseIfRequested('正文生成已在提示词缓存预热等待后暂停，可导出当前已完成内容，稍后继续。');
  }

  function rememberTouchedItem(itemId) {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  const initialRuntime = syncRuntime();
  let technicalPlan = workspaceStore.updateTechnicalPlan({
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    contentGenerationRuntime: initialRuntime,
    referenceKnowledgeDocumentIds,
    contentGenerationTask: updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }),
  });
  updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan, {
    contentRuntime: initialRuntime,
    technicalPlanPatch: {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: initialRuntime,
      referenceKnowledgeDocumentIds,
    },
  });

  if (!tasksToRun.length) {
    logs = [...logs, retryContentCorrection
      ? '正文已全部生成，将直接重试内容矫正和后续处理。'
      : '正文已全部生成，将检查最低字数要求。'];
  }

  function saveSection(item, partial, contentForOutline, taskPartial = {}) {
    const prev = workspaceStore.loadTechnicalPlan() || {};
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeLeafContentForSave(nextPartial.content, item);
    }
    sections = withSection(prev.contentGenerationSections || sections, item, nextPartial);
    const currentOutlineData = prev.outlineData || outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeLeafContentForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
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
    const runtime = syncRuntime();
    const saved = workspaceStore.updateTechnicalPlan({
      contentGenerationSections: sections,
      outlineData: nextOutlineData,
      contentGenerationRuntime: runtime,
    });
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    updateTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, saved, {
      outlineData: nextOutlineData,
      contentSection: sections[item.id],
      contentRuntime: runtime,
    });
    return saved;
  }

  function getStoredContentPlan(itemId) {
    return normalizeStoredContentPlan(storedContentPlans[itemId]);
  }

  function applyCurrentTableRequirementToPlan(plan) {
    const normalizedPlan = normalizeContentPlan(plan, allowedKnowledgeItemIds, allowedFactTitles);
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
    const plan = contentPlans.get(itemId) || getReusableStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    contentPlans.set(itemId, plan);
    return plan;
  }

  function saveContentPlanForItem(itemId, plan, illustrationType) {
    const storedContentPlan = getStoredContentPlan(itemId);
    const nextIllustrationType = normalizeIllustrationType(illustrationType || storedContentPlan?.illustration_type || 'none');
    contentPlans.set(itemId, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [itemId]: createStoredContentPlan(plan, nextIllustrationType, tableRequirement),
    }, leaves);
    const saved = workspaceStore.updateTechnicalPlan({ contentGenerationPlans: storedContentPlans, contentGenerationRuntime: syncRuntime() });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved);
    return saved;
  }

  function getOriginalMaterialRuntimeState(itemOrId) {
    const itemId = typeof itemOrId === 'string' ? itemOrId : String(itemOrId?.id || '').trim();
    const item = typeof itemOrId === 'string' ? leaves.find((context) => context.item.id === itemId)?.item : itemOrId;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    const originalMaterial = normalizeOriginalMaterial(plan.original_material);
    const sourceSegments = originalMaterial.source_ids.map((sourceId) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
    const allSourcesValid = Boolean(originalMaterial.source_ids.length) && sourceSegments.length === originalMaterial.source_ids.length;
    const content = sections[itemId]?.content || item?.content || '';
    const hasContent = Boolean(String(content || '').trim());
    const validRestored = Boolean(originalMaterial.restored && allSourcesValid && hasContent);
    const needsRestoreRepair = Boolean(originalMaterial.restored && !validRestored);
    return {
      plan,
      originalMaterial,
      sourceSegments,
      allSourcesValid,
      content,
      hasContent,
      validRestored,
      needsRestoreRepair,
      canRebuildRestoredContent: Boolean(originalMaterial.restored && allSourcesValid && !hasContent),
      needsOptimization: Boolean(validRestored && !originalMaterial.optimized),
    };
  }

  function buildOriginalMaterialFromSegments(segments, previous = {}) {
    const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
    return normalizeOriginalMaterial({
      restored: true,
      optimized: false,
      source_ids: segments.map((segment) => segment.id),
      source_titles: segments.map((segment) => segment.title_path?.join(' > ') || segment.id),
      source_hashes: segments.map((segment) => segment.hash),
      restored_chars: restoredContent.length,
      restored_at: previous.restored_at || now(),
    });
  }

  function saveSectionAndContentPlan(item, partial, contentForOutline, plan, illustrationType, taskPartial = {}) {
    const prev = workspaceStore.loadTechnicalPlan() || {};
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeLeafContentForSave(nextPartial.content, item);
    }
    sections = withSection(prev.contentGenerationSections || sections, item, nextPartial);
    const currentOutlineData = prev.outlineData || outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeLeafContentForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
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
    const storedContentPlan = getStoredContentPlan(item.id);
    const nextIllustrationType = normalizeIllustrationType(illustrationType || storedContentPlan?.illustration_type || 'none');
    contentPlans.set(item.id, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(plan, nextIllustrationType, tableRequirement),
    }, leaves);
    const runtime = syncRuntime();
    const saved = workspaceStore.updateTechnicalPlan({
      contentGenerationSections: sections,
      outlineData: nextOutlineData,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    updateTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, saved, {
      outlineData: nextOutlineData,
      contentSection: sections[item.id],
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
    return saved;
  }

  function getRestoredNodeIds() {
    const restoredIds = new Set();
    for (const { item } of leaves) {
      if (getOriginalMaterialRuntimeState(item).validRestored) {
        restoredIds.add(item.id);
      }
    }
    return restoredIds;
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
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      nextPlans[context.item.id] = createStoredContentPlan(contentPlan, getIllustrationType(context), tableRequirement);
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
          bidAnalysisFactsText,
          globalFactTitlesText,
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
        logTitle: `正文编排-${item.id}-${item.title || '未命名章节'}`,
        progressLabel: '正文编排决策',
        failureMessage: '模型返回的正文编排决策格式无效',
        normalizer: (value) => normalizeContentPlan(value, allowedKnowledgeItemIds, allowedFactTitles),
        validator: validateContentPlan,
      });
    } catch (error) {
      if (isPauseLikeError(error)) {
        throw error;
      }
      contentPlan = normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      logs = [...logs, `编排失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}，将按纯正文生成。`];
    }

    if (tableRequirement === 'none') {
      contentPlan = clearContentPlanTable(contentPlan);
    }

    contentPlans.set(item.id, contentPlan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(contentPlan, 'none', tableRequirement),
    }, leaves);
    workspaceStore.updateTechnicalPlan({ contentGenerationPlans: storedContentPlans, contentGenerationRuntime: syncRuntime() });
    contentStats.planning_completed += 1;
    logs = [...logs, `编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，事实变量：${contentPlan.facts.titles.length} 项，表格：${contentPlan.table.needed ? '需要' : '不需要'}，Mermaid：${contentPlan.mermaid.needed ? '需要' : '不需要'}，AI 图：${contentPlan.image.needed ? '需要' : '不需要'}）`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
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
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    if (planningTargets.length) {
      const [warmupTarget, ...remainingPlanningTargets] = planningTargets;
      logs = [...logs, `开始正文编排预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await planOne(warmupTarget);
      pauseIfRequested('正文生成已在编排预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingPlanningTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`正文编排预热完成，等待 5 秒后开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`);
        logs = [...logs, `开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        await runItemsWithWorkerPool(remainingPlanningTargets, contentConcurrency, planOne, isPauseRequested);
      }
    }
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

  async function restoreOriginalMaterialsIfNeeded(targets) {
    if (!isExpansionWorkflow || !originalPlanSegments.length || !targets?.length) {
      return;
    }

    const targetStates = targets.map((context) => ({ context, state: getOriginalMaterialRuntimeState(context.item) }));
    const rebuildTargets = targetStates.filter(({ state }) => state.canRebuildRestoredContent || (targetItemId && regenerate && state.validRestored));
    const restoreTargets = targetStates
      .filter(({ state }) => !state.validRestored && !state.canRebuildRestoredContent)
      .map(({ context }) => context);
    if (!restoreTargets.length && !rebuildTargets.length) {
      logs = [...logs, '原方案还原：当前待生成小节均已完成还原，跳过还原阶段。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return;
    }

    contentStats.phase = 'restoring';
    workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'restoring' }) });
    logs = [...logs, `开始原方案还原：${originalPlanSegments.length} 个原文段，${restoreTargets.length} 个候选叶子小节，${rebuildTargets.length} 个小节可直接重建原文。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    const assignedSourceIds = new Set();
    let restoredCount = 0;
    for (const { context, state } of rebuildTargets) {
      const segments = state.sourceSegments;
      segments.forEach((segment) => assignedSourceIds.add(segment.id));
      const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
      const originalMaterial = buildOriginalMaterialFromSegments(segments, state.originalMaterial);
      saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
        ...state.plan,
        original_material: originalMaterial,
      }, undefined, { logs });
      restoredCount += 1;
    }

    if (restoreTargets.length) {
      const allowedNodeIds = new Set(restoreTargets.map(({ item }) => item.id).filter(Boolean));
      const allowedSourceIds = new Set(originalPlanSegments.map((segment) => segment.id));
      const result = await aiService.collectJsonResponse({
        messages: buildOriginalMaterialRestoreMessages({
          targets: restoreTargets,
          originalSegments: originalPlanSegments,
          projectOverview,
          bidAnalysisFactsText,
          globalFactTitlesText,
        }),
        temperature: 0.1,
        logTitle: '原方案正文还原映射',
        progressLabel: '原方案还原',
        failureMessage: '模型返回的原方案还原映射格式无效',
        normalizer: (value) => normalizeOriginalRestoreAssignments(value, { allowedNodeIds, allowedSourceIds }),
        validator: validateOriginalRestoreAssignments,
        repairMessagesBuilder: (context) => buildOriginalRestoreRepairMessages(context, restoreTargets, originalPlanSegments),
        progressCallback: (message) => {
          logs = [...logs, message || '原方案还原映射格式校验失败，正在修复'];
          updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        },
      });

      const targetById = new Map(restoreTargets.map((context) => [context.item.id, context]));
      for (const assignment of result.assignments || []) {
        const context = targetById.get(assignment.node_id);
        if (!context) {
          continue;
        }
        const segments = (assignment.source_ids || []).map((sourceId) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
        if (!segments.length) {
          continue;
        }
        segments.forEach((segment) => assignedSourceIds.add(segment.id));
        const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
        const plan = getContentPlanForItem(context.item.id);
        const originalMaterial = buildOriginalMaterialFromSegments(segments);
        saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
          ...plan,
          original_material: originalMaterial,
        }, undefined, { logs });
        restoredCount += 1;
      }
    }

    const unassignedCount = originalPlanSegments.filter((segment) => !assignedSourceIds.has(segment.id)).length;
    logs = [...logs, `原方案还原完成：已还原 ${restoredCount} 个小节，未分配原文段 ${unassignedCount} 个。`];
    contentStats.phase = 'generating';
    workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'generating' }) });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  async function prepareSingleSectionPlan() {
    const context = tasksToRun[0];
    const storedContentPlan = getReusableStoredContentPlan(context.item.id);
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
      logs = [...logs, `未找到可复用历史编排结果，将仅重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      await planOne(context);
      pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
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
    const { item } = context;
    const previousSection = sections[item.id] || {};
    const previousContent = previousSection.content || item.content || '';
    const previousStatus = previousSection.status && previousSection.status !== 'running'
      ? previousSection.status
      : previousContent.trim() ? 'success' : 'idle';
    const isSingleSectionRegeneration = Boolean(targetItemId);
    let contentPlan = getContentPlanForItem(item.id);
    let originalState = getOriginalMaterialRuntimeState(item);
    let originalMaterial = originalState.originalMaterial;
    const needsRestoredOptimization = originalState.needsOptimization;
    let rawContent = needsRestoredOptimization ? previousContent : regenerate || retryItemIds.has(item.id) ? '' : previousContent;
    let content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
    logs = [...logs, needsRestoredOptimization
      ? `开始基于原方案优化扩写：${item.id} ${item.title || '未命名章节'}`
      : `开始生成：${item.id} ${item.title || '未命名章节'}`];
    saveSection(item, {
      status: 'running',
      content: isSingleSectionRegeneration ? previousContent : content,
      error: undefined,
    }, isSingleSectionRegeneration ? previousContent : content, { logs });

    try {
      contentPlan = getContentPlanForItem(item.id);
      originalState = getOriginalMaterialRuntimeState(item);
      originalMaterial = originalState.originalMaterial;
      const knowledgeContents = resolveKnowledgeContents(contentPlan.knowledge?.item_ids, knowledgeContentMap);
      const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);

      const generatedContent = await aiService.chat({
        messages: needsRestoredOptimization
          ? buildRestoredChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent: previousContent })
          : buildChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents }),
        temperature: 0.7,
        logTitle: `${needsRestoredOptimization ? '原方案优化扩写' : '正文生成'}-${item.id}-${item.title || '未命名章节'}`,
      });

      rawContent = needsRestoredOptimization ? generatedContent || '' : rawContent + (generatedContent || '');

      content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
      logs = [...logs, needsRestoredOptimization
        ? `原方案优化扩写完成：${item.id} ${item.title || '未命名章节'}`
        : `生成完成：${item.id} ${item.title || '未命名章节'}`];
      rememberTouchedItem(item.id);
      if (needsRestoredOptimization) {
        saveSectionAndContentPlan(item, { status: 'success', content, error: undefined }, content, {
          ...contentPlan,
          original_material: normalizeOriginalMaterial({
            ...originalMaterial,
            optimized: true,
            optimized_at: now(),
          }),
        }, undefined, { logs });
      } else {
        saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
      }
    } catch (error) {
      if (isPauseLikeError(error)) {
        saveSection(item, {
          status: previousStatus,
          content: previousContent,
          error: previousSection.error,
        }, previousContent, { logs });
        throw error;
      }
      const message = error.message || '正文生成失败';
      logs = [...logs, `生成失败：${item.id} ${item.title || '未命名章节'}，${message}${isSingleSectionRegeneration ? '。已保留原正文。' : ''}`];
      saveSection(item, {
        status: 'error',
        content: isSingleSectionRegeneration ? previousContent : content,
        error: message,
      }, isSingleSectionRegeneration ? previousContent : content, { logs });
    }
  }

  function getContentPromptWarmupKey(context) {
    const originalState = getOriginalMaterialRuntimeState(context.item);
    const contentPlan = getContentPlanForItem(context.item.id);
    const branch = originalState.needsOptimization ? 'restored' : 'normal';
    const tableMode = contentPlan?.table?.needed ? 'table' : 'plain';
    return `${branch}:${tableMode}`;
  }

  function formatContentPromptWarmupLabel(key) {
    if (key === 'restored:table') return '已还原优化扩写/允许表格';
    if (key === 'restored:plain') return '已还原优化扩写/无表格';
    if (key === 'normal:table') return '普通正文/允许表格';
    return '普通正文/无表格';
  }

  async function runContentTargetsWithWarmup(targets, label = '正文生成') {
    if (!targets.length) {
      return;
    }

    const groups = new Map();
    for (const context of targets) {
      const key = getContentPromptWarmupKey(context);
      const group = groups.get(key) || [];
      group.push(context);
      groups.set(key, group);
    }

    const warmupContexts = new Set();
    const warmups = [];
    for (const [key, groupTargets] of groups.entries()) {
      if (groupTargets.length <= 1) {
        continue;
      }
      const context = groupTargets[0];
      warmups.push({ key, context });
      warmupContexts.add(context);
    }

    for (const { key, context } of warmups) {
      logs = [...logs, `开始${label}预热（${formatContentPromptWarmupLabel(key)}）：${context.item.id} ${context.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await runOne(context);
      pauseIfRequested(`正文生成已在${label}预热后暂停，可导出当前已完成内容，稍后继续。`);
    }

    const remainingTargets = targets.filter((context) => !warmupContexts.has(context));

    if (remainingTargets.length) {
      if (warmups.length) {
        await waitForPromptCacheWarmupBeforeFanout(`${label}分组预热完成，等待 5 秒后开始并发生成剩余 ${remainingTargets.length} 个小节。`);
      }
      logs = [...logs, warmups.length
        ? `开始并发生成剩余 ${remainingTargets.length} 个小节。`
        : `${label}无需分组预热，开始并发生成 ${remainingTargets.length} 个小节。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      await runItemsWithWorkerPool(remainingTargets, contentConcurrency, runOne, isPauseRequested);
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
    const runtime = syncRuntime();
    const saved = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved, {
      outlineData,
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationSections: sections,
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
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
      const originalState = getOriginalMaterialRuntimeState(item);
      return section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair;
    });
  }

  function selectEarlyContentProbeTargets(targets) {
    const source = Array.isArray(targets) ? targets : [];
    if (source.length <= EARLY_CONTENT_PROBE_COUNT) {
      return source;
    }

    const indexes = [0, Math.floor((source.length - 1) / 2), source.length - 1];
    const selected = new Map();
    for (const index of indexes) {
      const context = source[index];
      if (context?.item?.id) {
        selected.set(context.item.id, context);
      }
    }
    return Array.from(selected.values());
  }

  function averageGeneratedWords(targets) {
    const words = (Array.isArray(targets) ? targets : [])
      .map(({ item }) => countContentWords(getLeafContentForWords(item)))
      .filter((value) => value > 0);
    if (!words.length) {
      return 0;
    }
    return Math.round(words.reduce((sum, value) => sum + value, 0) / words.length);
  }

  function estimateTotalWords(leafAverageWords) {
    const averageWords = Number(leafAverageWords);
    const fallbackWords = medianLeafWords();
    const wordsPerPendingLeaf = Number.isFinite(averageWords) && averageWords > 0 ? averageWords : fallbackWords;
    return countTotalContentWords() + pendingContentContexts().length * wordsPerPendingLeaf;
  }

  function rememberRetryTargets(targets) {
    for (const { item } of targets || []) {
      if (sections[item.id]?.status === 'error') {
        retryItemIds.add(item.id);
      }
    }
  }

  function updateOutlineExpansionProgress(round, stepCompleted, label, planSnapshot) {
    const normalizedRound = Math.max(1, Math.min(MAX_OUTLINE_EXPANSION_ROUNDS, Math.round(Number(round) || 1)));
    const normalizedStep = Math.max(0, Math.min(OUTLINE_EXPANSION_STEPS_PER_ROUND, Math.round(Number(stepCompleted) || 0)));
    contentStats.phase = 'outline-expanding';
    contentStats.outline_expansion_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_completed = normalizedStep >= OUTLINE_EXPANSION_STEPS_PER_ROUND
      ? normalizedRound
      : normalizedRound - 1;
    contentStats.outline_expansion_step_total = MAX_OUTLINE_EXPANSION_ROUNDS * OUTLINE_EXPANSION_STEPS_PER_ROUND;
    contentStats.outline_expansion_step_completed = ((normalizedRound - 1) * OUTLINE_EXPANSION_STEPS_PER_ROUND) + normalizedStep;
    contentStats.outline_expansion_round = normalizedRound;
    contentStats.outline_expansion_round_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_step_label = label || '';
    return updateTask(
      { status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() },
      planSnapshot || workspaceStore.loadTechnicalPlan(),
    );
  }

  async function runOutlineExpansionRound(round) {
    const nodeMap = createOutlineNodeMap(outlineData.outline || []);
    const restoredNodeIds = getRestoredNodeIds();
    const currentWords = countTotalContentWords();
    contentStats.phase = 'outline-expanding';
    contentStats.outline_expansion_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_completed = round - 1;
    syncRuntime({ phase: 'outline-expanding' });
    logs = [...logs, `最低字数未达标，开始第 ${round}/${MAX_OUTLINE_EXPANSION_ROUNDS} 轮补目录。`];
    const started = workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: contentRuntime });
    updateOutlineExpansionProgress(round, 1, '准备目录上下文和字数统计', started);

    updateOutlineExpansionProgress(round, 2, '正在请求 AI 生成新增目录');

    const patch = await aiService.collectJsonResponse({
      messages: buildOutlineExpansionMessages({
        projectOverview,
        globalFactsText,
        outlineData,
        currentWords,
        minimumWords,
        medianLeafWords: medianLeafWords(),
        round,
        nodeMap,
        restoredNodeIds,
      }),
      temperature: 0.4,
      logTitle: `最低字数补目录第${round}轮`,
      progressLabel: '最低字数补目录',
      failureMessage: '模型返回的补目录数据格式无效',
      normalizer: (value) => normalizeOutlineExpansionResponse(value, { nodeMap, restoredNodeIds }),
      validator: validateOutlineExpansionResponse,
      repairMessagesBuilder: (context) => buildOutlineExpansionRepairMessages(context, outlineData.outline || [], restoredNodeIds),
      progressCallback: (message) => updateOutlineExpansionProgress(round, 2, message || '补目录结果格式校验失败，正在修复'),
    });

    updateOutlineExpansionProgress(round, 3, `补目录结果校验通过，返回 ${patch.additions.length} 条新增目录`);

    if (!patch.additions.length) {
      syncRuntime({ outline_expansion_completed: round });
      logs = [...logs, `第 ${round} 轮补目录未返回可用新增目录。`];
      updateOutlineExpansionProgress(round, 5, '本轮未返回可用新增目录，准备评估字数');
      return 0;
    }

    updateOutlineExpansionProgress(round, 4, '正在应用新增目录并校验完整目录结构');
    const { outline, invalidatedItemIds, addedCount } = applyOutlineExpansionAdditions(outlineData.outline || [], patch);
    syncRuntime({ outline_expansion_completed: round });
    logs = [...logs, `第 ${round} 轮补目录已应用：新增 ${addedCount} 个目录节点，清空 ${invalidatedItemIds.size} 个旧叶子正文并返还其编排额度。`];
    refreshOutlineState(outline, invalidatedItemIds);
    updateOutlineExpansionProgress(round, 5, `已新增 ${addedCount} 个目录节点，正在刷新待生成小节`);
    return addedCount;
  }

  async function runOutlineExpansionIfNeeded(initialEstimatedWords, leafAverageWords) {
    if (minimumWords <= 0) {
      return 0;
    }

    let estimatedWords = Number(initialEstimatedWords);
    if (!Number.isFinite(estimatedWords)) {
      estimatedWords = estimateTotalWords(leafAverageWords);
    }
    if (estimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
      return 0;
    }

    let addedTotal = 0;
    const completedRounds = Math.min(contentRuntime.outline_expansion_completed || 0, MAX_OUTLINE_EXPANSION_ROUNDS);
    for (let round = completedRounds + 1; round <= MAX_OUTLINE_EXPANSION_ROUNDS; round += 1) {
      try {
        addedTotal += await runOutlineExpansionRound(round);
        updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '本轮补目录已完成，正在检查暂停请求');
        pauseIfRequested('正文生成已在补目录阶段暂停，可导出当前已完成内容，稍后继续。');
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `第 ${round} 轮补目录失败：${error.message || '模型返回无效'}。`];
        syncRuntime({ outline_expansion_completed: round });
        updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '本轮补目录失败，准备评估是否继续');
      }

      updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '正在预估补目录后的可达字数');
      estimatedWords = estimateTotalWords(leafAverageWords);
      if (estimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
        logs = [...logs, `补目录预估可达到最低字数的 ${Math.round(OUTLINE_EXPANSION_TARGET_RATIO * 100)}%，准备补充新增小节编排。`];
        updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '预估字数已达标，准备补充新增小节编排');
        break;
      }
    }

    return addedTotal;
  }

  async function runEarlyContentProbeIfNeeded() {
    if (minimumWords <= 0 || targetItemId || !tasksToRun.length) {
      return false;
    }

    const probeTargets = selectEarlyContentProbeTargets(tasksToRun);
    if (!probeTargets.length) {
      return false;
    }

    logs = [...logs, `最低字数预估：先生成 ${probeTargets.length} 个样本小节。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    await runContentTargetsWithWarmup(probeTargets, '最低字数采样');
    pauseIfRequested('正文生成已在最低字数采样阶段暂停，可导出当前已完成内容，稍后继续。');

    const averageWords = averageGeneratedWords(probeTargets);
    tasksToRun = pendingContentContexts();
    rememberRetryTargets(tasksToRun);

    if (averageWords <= 0) {
      logs = [...logs, '最低字数预估：样本正文未成功生成，跳过前置补目录。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return false;
    }

    const estimatedWords = estimateTotalWords(averageWords);
    logs = [...logs, `最低字数预估：样本平均 ${averageWords} 字，预计全文约 ${estimatedWords} 字。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    const addedCount = await runOutlineExpansionIfNeeded(estimatedWords, averageWords);
    tasksToRun = pendingContentContexts();
    rememberRetryTargets(tasksToRun);
    if (addedCount > 0) {
      logs = [...logs, `补目录完成，开始为 ${tasksToRun.length} 个待生成小节补充编排。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      await planAll();
      pauseIfRequested('正文生成已在补目录新增正文编排后暂停，可导出当前已完成内容，稍后继续。');
      tasksToRun = pendingContentContexts();
      rememberRetryTargets(tasksToRun);
      return true;
    }

    const nextEstimatedWords = estimateTotalWords(averageWords);
    logs = [...logs, nextEstimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO
      ? '最低字数预估已达到补目录阈值，继续生成正文。'
      : '补目录未新增可用目录，继续生成正文并由后续扩写兜底。'];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    return false;
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
      const reusableStoredContentPlan = getReusableStoredContentPlan(item.id);
      if (!reusableStoredContentPlan?.plan) {
        return 'none';
      }
      contentPlans.set(item.id, reusableStoredContentPlan.plan);
      const illustrationType = reusableStoredContentPlan.illustration_type || 'none';
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

    function remainingCandidateCount() {
      const statsById = new Map(leafWordStats().map((context) => [context.item.id, context]));
      return cycleIds.filter((itemId) => {
        const context = statsById.get(itemId);
        return !attemptedIds.has(itemId) && context && sections[itemId]?.status === 'success' && String(context.content || '').trim();
      }).length;
    }

    function takeNextExpansionContext() {
      const context = selectNextExpansionContext(cycleIds, attemptedIds);
      if (!context) {
        return null;
      }

      attemptedIds.add(context.item.id);
      persistExpansionAttempted(attemptedIds);
      launchedCount += 1;
      return context;
    }

    if (remainingCandidateCount() > 1 && currentWords < minimumWords && !isPauseRequested()) {
      const warmupContext = takeNextExpansionContext();
      if (warmupContext) {
        logs = [...logs, `开始正文扩写预热：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        appendDeveloperLog(`扩写预热请求发出：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}。`);
        await expandOneSection(warmupContext);
        currentWords = countTotalContentWords();
        appendDeveloperLog(`扩写预热请求完成：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}，当前 ${currentWords}/${minimumWords} 字。`);
        pauseIfRequested('正文生成已在扩写预热后暂停，可导出当前已完成内容，稍后继续。');
        if (currentWords >= minimumWords) {
          appendDeveloperLog('扩写预热后已达最低字数，跳过后续并发扩写。');
          return {
            currentWords,
            completesCycle: cycleIds.length > 0 && cycleIds.every((itemId) => attemptedIds.has(itemId)),
            launchedCount,
          };
        }
        if (remainingCandidateCount() > 0) {
          await waitForPromptCacheWarmupBeforeFanout(`正文扩写预热完成，等待 5 秒后开始并发扩写剩余 ${remainingCandidateCount()} 个候选小节。`);
          logs = [...logs, `开始并发扩写剩余 ${remainingCandidateCount()} 个候选小节。`];
          updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        }
      }
    }

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

        const context = takeNextExpansionContext();
        if (!context) {
          return null;
        }
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
    const storedContentPlan = getReusableStoredContentPlan(item.id);
    const contentPlan = contentPlans.get(item.id) || storedContentPlan?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);
    logs = [...logs, `开始扩写：${item.id} ${item.title || '未命名章节'}（当前 ${words} 字，目标 ${targetWords} 字）。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    try {
      const patch = await aiService.collectJsonResponse({
        messages: buildContentExpansionMessages({
          outlineData,
          context,
          projectOverview,
          selectedFactsText,
          currentContent: contentForPrompt,
          currentWords: words,
          targetWords,
        }),
        temperature: 0.7,
        logTitle: `正文扩写-${item.id}-${item.title || '未命名章节'}`,
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
      if (isPauseLikeError(error)) {
        throw error;
      }
      logs = [...logs, `扩写失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }
  }

  async function ensureMinimumWords() {
    let currentWords = countTotalContentWords();
    logs = [...logs, `最低字数兜底检查：当前总字数 ${currentWords} 字，最低字数 ${minimumWords} 字。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    if (currentWords >= minimumWords) {
      logs = [...logs, '当前总字数已达到最低字数要求。'];
      return;
    }
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

    logs = [...logs, `最低字数已达成：${currentWords}/${minimumWords} 字，准备进入后续阶段。`];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
  }

  function buildOriginalCoverageAuditTargets(auditTargetItemId = '') {
    if (!isExpansionWorkflow || !originalPlanSegments.length) {
      return [];
    }
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    const segmentMap = new Map(originalPlanSegments.map((segment) => [segment.id, segment]));
    return leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const originalState = getOriginalMaterialRuntimeState(context.item);
        const sources = originalState.originalMaterial.source_ids.map((sourceId) => segmentMap.get(sourceId)).filter(Boolean);
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
    return `请只在当前工作目录内工作。

你会看到两个文件：
1. original-coverage-sources.md：每个章节对应需要保留的来源段。
2. technical-plan.md：当前技术方案正文。

任务：
请自行检查并修复 technical-plan.md，使每个章节正文保留 original-coverage-sources.md 中对应来源段的实质内容。

要求：
1. 请自主分析、定位和补写缺失内容。
2. 只修改 technical-plan.md 中 yibiao-section-start 和 yibiao-section-end 标记之间的正文内容。
3. 不要修改章节编号、章节标题、HTML 注释标记或 section id。
4. 不要新增、删除、重排章节。
5. 只补回来源段中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法等内容；不追求逐字一致。
6. 如果来源段与当前正文存在明显冲突，不要强行补写，保留当前正文，后续会由全文一致性审计或人工核对处理。
7. 不要在正文中提到“原方案”“来源段”“用户原文”或类似过程性表述。
8. 不要访问当前工作目录外的文件。
9. 不要联网。
10. 修复完成后，必须把完整修复结果保存回 technical-plan.md。`;
  }

  function updateAgentOriginalCoverageProgress(step, label, extra = {}) {
    contentStats.phase = 'original-auditing';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'original-auditing' });
    const saved = workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: runtime });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved, { contentRuntime: runtime });
    return saved;
  }

  async function repairOriginalCoverageSection({ target, coverageItems }) {
    const { item } = target;
    let currentContent = sections[item.id]?.content || item.content || '';
    let failures = [];
    let appliedTotal = 0;
    writeDeveloperLog('original_coverage.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      issue_count: (coverageItems || []).length,
      coverage_items: coverageItems,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('original_coverage.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('original_coverage.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const patch = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageRepairMessages({
            target,
            coverageItems,
            currentContent,
            attempt,
            failures,
            tableRequirement,
          }),
          temperature: 0.2,
          logTitle: `原方案覆盖修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖修复',
          failureMessage: '模型返回的原方案覆盖修复结果格式无效',
          normalizer: normalizeContentExpansionPatch,
          validator: validateContentExpansionPatch,
          repairMessagesBuilder: buildContentExpansionRepairMessages,
          max_retries: 1,
        });
        writeDeveloperLog('original_coverage.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch,
        });

        const nextContent = applyContentExpansionPatch(currentContent, patch);
        if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
          failures = ['补写 patch 应用后正文没有变化'];
          writeDeveloperLog('original_coverage.repair.no_change', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            patch,
          });
        } else {
          currentContent = nextContent;
          appliedTotal += 1;
          rememberTouchedItem(item.id);
          saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
          writeDeveloperLog('original_coverage.repair.section.saved', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_total: appliedTotal,
            content_metrics: textMetrics(currentContent),
          });
          return { appliedCount: appliedTotal, failed: false, paused: false };
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('original_coverage.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      logs = [...logs, `原方案覆盖修复第 ${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }

    writeDeveloperLog('original_coverage.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runAgentOriginalCoverageRepairIfEnabled() {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'disabled' });
      logs = [...logs, '原方案覆盖审计未启用，跳过 Agent 覆盖修复阶段。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageTargets = buildOriginalCoverageAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(coverageTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'no_targets' });
      logs = [...logs, '原方案覆盖 Agent 修复跳过：没有可检查的已还原成功正文小节。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_group_total = 0;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    logs = [...logs, `开始 Agent 原方案覆盖修复：共 ${sectionIndex.size} 个已还原小节。`];
    writeDeveloperLog('original_coverage.agent.start', {
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
      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `原方案覆盖 Agent 修复无法启动：Agent 服务尚未初始化，${failedCount} 个小节需人工核对。`];
      writeDeveloperLog('original_coverage.agent.unavailable', { failed_count: failedCount });
      updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 不可用', { audit_agent_failed_sections: failedCount });
      return { ran: true, fixedCount: 0, failedCount };
    }

    updateAgentOriginalCoverageProgress(2, 'Agent 正在检查并补回原方案内容');
    const startedAt = Date.now();
    const agentAbortController = new AbortController();
    let heartbeat = null;
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
    heartbeat = setInterval(() => {
      if (isPauseRequested()) {
        abortAgentIfPauseRequested();
        return;
      }
      const elapsedSeconds = Math.max(30, Math.round((Date.now() - startedAt) / 1000));
      logs = [...logs, `Agent 正在检查并补回原方案内容，已运行 ${elapsedSeconds} 秒。`];
      updateAgentOriginalCoverageProgress(2, 'Agent 正在检查并补回原方案内容');
    }, 30000);
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
        signal: agentAbortController.signal,
      }, 'original_coverage.agent');
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
      logs = [...logs, `原方案覆盖 Agent 修复失败：${error.message || '未知错误'}。已保留原正文，${failedCount} 个小节需人工核对，任务将继续进入后续流程。`];
      writeDeveloperLog('original_coverage.agent.failed', {
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      updateAgentOriginalCoverageProgress(contentStats.audit_agent_step_completed || 2, '原方案覆盖 Agent 修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      return { ran: true, fixedCount: 0, failedCount };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  async function runOriginalPlanCoverageAuditIfEnabled(options = {}) {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'disabled' });
      logs = [...logs, '原方案覆盖审计未启用，跳过审计阶段。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildOriginalCoverageAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, '原方案覆盖审计跳过：没有可审计的已还原成功正文小节。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageIssuesBySectionId = new Map();
    let issueCount = 0;
    let conflictCount = 0;
    contentStats.phase = 'original-auditing';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditTargets.length;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_step_total = 0;
    contentStats.audit_agent_step_completed = 0;
    contentStats.audit_agent_step_label = '';
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'original-auditing' }) });
    logs = [...logs, `开始原方案覆盖审计：${auditTargets.length} 个已还原小节，并发 ${contentConcurrency}。`];
    writeDeveloperLog('original_coverage.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      concurrency: contentConcurrency,
      targets: auditTargets.map((target) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    async function auditOriginalCoverageTarget(target) {
      const allowedSourceIds = new Set(target.sources.map((segment) => segment.id).filter(Boolean));
      try {
        writeDeveloperLog('original_coverage.audit.section.start', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          source_ids: [...allowedSourceIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageAuditMessages({ target }),
          temperature: 0.1,
          logTitle: `原方案覆盖审计-${target.item.id}-${target.item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖审计',
          failureMessage: '模型返回的原方案覆盖审计结果格式无效',
          normalizer: (value) => normalizeOriginalCoverageAuditResponse(value, { allowedSourceIds, expectedNodeId: target.item.id }),
          validator: (value) => validateOriginalCoverageAuditResponse(value, allowedSourceIds),
          repairMessagesBuilder: (contextForRepair) => buildOriginalCoverageAuditJsonRepairMessages(contextForRepair, target),
          max_retries: 1,
        });
        const coverageItems = response.items || [];
        const repairItems = coverageItems.filter((item) => ['partial', 'missing'].includes(item.status));
        const conflictItems = coverageItems.filter((item) => item.status === 'conflict');
        if (repairItems.length) {
          coverageIssuesBySectionId.set(target.item.id, { target, coverageItems: repairItems });
        }
        issueCount += repairItems.length + conflictItems.length;
        conflictCount += conflictItems.length;
        contentStats.audit_conflict_total = issueCount;
        logs = [...logs, `原方案覆盖审计完成：${target.item.id} ${target.item.title || '未命名章节'}，需补写 ${repairItems.length} 段，冲突 ${conflictItems.length} 段。`];
        writeDeveloperLog('original_coverage.audit.section.success', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          items: coverageItems,
          repair_count: repairItems.length,
          conflict_count: conflictItems.length,
        });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `原方案覆盖审计失败：${target.item.id} ${target.item.title || '未命名章节'}，${error.message || '模型返回无效'}，已跳过该小节。`];
        writeDeveloperLog('original_coverage.audit.section.error', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      }
    }

    if (auditTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = auditTargets;
      logs = [...logs, `开始原方案覆盖审计预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await auditOriginalCoverageTarget(warmupTarget);
      pauseIfRequested('正文生成已在原方案覆盖审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`原方案覆盖审计预热完成，等待 5 秒后开始并发审计剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发审计剩余 ${remainingTargets.length} 个小节。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在原方案覆盖审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(coverageIssuesBySectionId.values());
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    logs = [...logs, repairTargets.length
      ? `原方案覆盖审计发现 ${repairTargets.length} 个小节需要补写，开始局部修复。${conflictCount ? `另有 ${conflictCount} 个来源段存在冲突，保留给一致性审计或人工核对。` : ''}`
      : `原方案覆盖审计未发现需要自动补写的来源段。${conflictCount ? `发现 ${conflictCount} 个冲突来源段，保留给一致性审计或人工核对。` : ''}`];
    writeDeveloperLog('original_coverage.repair.start', {
      target_count: repairTargets.length,
      conflict_count: conflictCount,
      issue_count: issueCount,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ target, coverageItems }) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        coverage_items: coverageItems,
      })),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    if (!repairTargets.length) {
      writeDeveloperLog('original_coverage.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0, conflict_count: conflictCount });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairOriginalCoverageTarget(target) {
      const item = target.target.item;
      try {
        const result = await repairOriginalCoverageSection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          logs = [...logs, `原方案覆盖修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部补写。`];
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          logs = [...logs, `原方案覆盖修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能应用补写 patch'}。`];
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        logs = [...logs, `原方案覆盖修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      } finally {
        contentStats.audit_fix_completed += 1;
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      logs = [...logs, `开始原方案覆盖修复预热：${warmupTarget.target.item.id} ${warmupTarget.target.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await repairOriginalCoverageTarget(warmupTarget);
      pauseIfRequested('正文生成已在原方案覆盖修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`原方案覆盖修复预热完成，等待 5 秒后开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发修复剩余 ${remainingTargets.length} 个小节。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在原方案覆盖修复阶段暂停，可导出当前已完成内容，稍后继续。');

    logs = [...logs, `原方案覆盖审计完成：发现 ${repairTargets.length} 个需补写小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`];
    writeDeveloperLog('original_coverage.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
      conflict_count: conflictCount,
      issue_count: issueCount,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  function buildConsistencyAuditTargets(auditTargetItemId = '') {
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    return leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const content = sections[context.item.id]?.content || context.item.content || '';
        return {
          ...context,
          content,
          words: countContentWords(content),
        };
      })
      .filter(({ item, content }) => sections[item.id]?.status === 'success' && String(content || '').trim());
  }

  function buildConsistencyAuditGroups(targets) {
    const totalWords = (targets || []).reduce((sum, item) => sum + item.words, 0);
    if (!targets?.length) {
      return [];
    }

    let groupCount = 1;
    if (totalWords > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
      groupCount = 2;
      while (totalWords / groupCount > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
        groupCount += 1;
      }
    }
    const targetWords = Math.max(1, Math.ceil(totalWords / groupCount));
    const groups = [];
    let current = { index: 1, items: [], words: 0, targetWords };

    for (const target of targets) {
      if (current.items.length && current.words + target.words > targetWords && groups.length < groupCount - 1) {
        groups.push(current);
        current = { index: groups.length + 1, items: [], words: 0, targetWords };
      }
      current.items.push(target);
      current.words += target.words;
    }
    if (current.items.length) {
      groups.push(current);
    }
    return groups.map((group, index) => ({ ...group, index: index + 1, total: groups.length, totalWords }));
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
      '# Step02 关键解析结果',
      bidAnalysisFactsText || '未提供',
    ].join('\n\n');
  }

  function buildAgentConsistencyRepairPrompt() {
    return `请只在当前工作目录内工作。

你会看到两个文件：
1. global-facts.md：全局事实变量和关键项目信息。
2. technical-plan.md：当前技术方案正文全文。

任务：
请自行审计并修复 technical-plan.md，使正文不与 global-facts.md 中的全局事实变量冲突，并尽量消除正文前后矛盾。

要求：
1. 请自主分析、定位和修复问题。
2. 只修改 technical-plan.md 中 yibiao-section-start 和 yibiao-section-end 标记之间的正文内容。
3. 不要修改章节编号、章节标题、HTML 注释标记或 section id。
4. 不要新增、删除、重排章节。
5. 不要访问当前工作目录外的文件。
6. 不要联网。
7. 修复完成后，必须把完整修复结果保存回 technical-plan.md。`;
  }

  function updateAgentConsistencyProgress(step, label, extra = {}) {
    contentStats.phase = 'auditing';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'auditing' });
    const saved = workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: runtime });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved, { contentRuntime: runtime });
    return saved;
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
      if (String(section.originalContent || '').trim() && !nextContent) {
        throw new Error(`Agent 输出把非空小节改为空：${id}`);
      }
    }
  }

  function applyAgentConsistencySections(parsedSections, sectionIndex, writableIds) {
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

  async function runAgentConsistencyRepairIfEnabled(options = {}) {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'disabled' });
      logs = [...logs, '全文一致性审计未启用，跳过 Agent 一致性修复阶段。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!agentService?.runTask) {
      throw new Error('Agent 服务尚未初始化，无法执行 Agent 一致性修复');
    }

    const allTargets = buildConsistencyAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(allTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, 'Agent 一致性修复跳过：没有可审计的成功正文小节。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const normalizedTargetId = String(options.targetItemId || targetItemId || '').trim();
    const writableIds = normalizedTargetId ? new Set([normalizedTargetId]) : new Set(sectionIndex.keys());
    if (normalizedTargetId && !sectionIndex.has(normalizedTargetId)) {
      logs = [...logs, `Agent 一致性修复跳过：目标小节 ${normalizedTargetId} 当前没有成功正文。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_group_total = 0;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
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
    const startedAt = Date.now();
    const agentAbortController = new AbortController();
    let heartbeat = null;
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
    heartbeat = setInterval(() => {
      if (isPauseRequested()) {
        abortAgentIfPauseRequested();
        return;
      }
      const elapsedSeconds = Math.max(30, Math.round((Date.now() - startedAt) / 1000));
      logs = [...logs, `Agent 正在审计并修复全文，已运行 ${elapsedSeconds} 秒。`];
      updateAgentConsistencyProgress(2, 'Agent 正在审计并修复全文');
    }, 30000);
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
        signal: agentAbortController.signal,
      }, 'consistency.agent');
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
      logs = [...logs, `Agent 一致性修复失败：${error.message || '未知错误'}。已保留原正文，未回退普通修复。`];
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
      if (heartbeat) clearInterval(heartbeat);
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  async function repairConsistencySection({ context, conflicts }) {
    const { item } = context;
    let currentContent = sections[item.id]?.content || item.content || '';
    let failures = [];
    let appliedTotal = 0;
    writeDeveloperLog('consistency.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      conflict_count: (conflicts || []).length,
      conflicts,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= CONSISTENCY_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('consistency.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('consistency.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: CONSISTENCY_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyRepairMessages({
            context,
            conflicts,
            globalFactsText,
            bidAnalysisFactsText,
            currentContent,
            attempt,
            failures,
            tableRequirement,
          }),
          temperature: 0.1,
          logTitle: `一致性修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文一致性修复',
          failureMessage: '模型返回的正文一致性修复结果格式无效',
          normalizer: (value) => normalizeConsistencyRepairResponse(value, item.id),
          validator: validateConsistencyRepairResponse,
          repairMessagesBuilder: (contextForRepair) => buildConsistencyRepairJsonRepairMessages(contextForRepair, item.id),
          max_retries: 1,
        });
        writeDeveloperLog('consistency.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch_count: response.patches.length,
          patches: response.patches,
        });

        if (!response.patches.length) {
          failures = ['模型未返回可应用的 patches'];
          writeDeveloperLog('consistency.repair.no_patches', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
          });
        } else {
          const result = applyConsistencyRepairPatches(currentContent, response.patches);
          writeDeveloperLog('consistency.repair.apply_result', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_count: result.appliedCount,
            errors: result.errors,
            patch_results: result.patchResults,
          });
          if (result.appliedCount > 0) {
            currentContent = result.content;
            appliedTotal += result.appliedCount;
            rememberTouchedItem(item.id);
            saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
            writeDeveloperLog('consistency.repair.section.saved', {
              section_id: item.id,
              title: item.title || '未命名章节',
              attempt,
              applied_total: appliedTotal,
              content_metrics: textMetrics(currentContent),
            });
          }
          if (!result.errors.length) {
            writeDeveloperLog('consistency.repair.section.done', {
              section_id: item.id,
              title: item.title || '未命名章节',
              applied_count: appliedTotal,
              failed: false,
            });
            return { appliedCount: appliedTotal, failed: false, paused: false };
          }
          failures = result.errors;
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('consistency.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      logs = [...logs, `一致性修复第 ${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    }

    writeDeveloperLog('consistency.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runConsistencyAuditIfEnabled(options = {}) {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'disabled' });
      logs = [...logs, '全文一致性审计未启用，跳过审计阶段。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildConsistencyAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, '全文一致性审计跳过：没有可审计的成功正文小节。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditGroups = buildConsistencyAuditGroups(auditTargets);
    const targetById = new Map(auditTargets.map((context) => [context.item.id, context]));
    const conflictsBySectionId = new Map();

    contentStats.phase = 'auditing';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditGroups.length;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_step_total = 0;
    contentStats.audit_agent_step_completed = 0;
    contentStats.audit_agent_step_label = '';
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'auditing' }) });
    logs = [...logs, `开始全文一致性审计：${auditTargets.length} 个小节，拆分为 ${auditGroups.length} 组，并发 ${contentConcurrency}。`];
    writeDeveloperLog('consistency.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      group_count: auditGroups.length,
      concurrency: contentConcurrency,
      group_word_limit: CONSISTENCY_AUDIT_GROUP_WORD_LIMIT,
      groups: auditGroups.map((group) => ({
        index: group.index,
        total: group.total,
        words: group.words,
        target_words: group.targetWords,
        total_words: group.totalWords,
        sections: group.items.map(({ item, words, content }) => ({
          id: item.id,
          title: item.title || '未命名章节',
          words,
          content_metrics: textMetrics(content),
        })),
      })),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    async function auditConsistencyGroup(group) {
      const allowedIds = new Set(group.items.map(({ item }) => item.id).filter(Boolean));
      try {
        writeDeveloperLog('consistency.audit.group.start', {
          index: group.index,
          total: group.total,
          words: group.words,
          allowed_ids: [...allowedIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyAuditMessages({ group, globalFactsText, bidAnalysisFactsText }),
          temperature: 0.1,
          logTitle: `一致性审计-${group.index}-${group.total}`,
          progressLabel: '全文一致性审计',
          failureMessage: '模型返回的一致性审计结果格式无效',
          normalizer: (value) => normalizeConsistencyAuditResponse(value, allowedIds),
          validator: validateConsistencyAuditResponse,
          repairMessagesBuilder: (contextForRepair) => buildConsistencyAuditRepairMessages(contextForRepair, allowedIds),
          max_retries: 1,
        });

        for (const conflict of response.conflicts) {
          const list = conflictsBySectionId.get(conflict.section_id) || [];
          list.push(conflict);
          conflictsBySectionId.set(conflict.section_id, list);
        }
        contentStats.audit_conflict_total = conflictsBySectionId.size;
        logs = [...logs, `一致性审计完成：第 ${group.index}/${group.total} 组，发现 ${response.conflicts.length} 条冲突，累计 ${conflictsBySectionId.size} 个冲突小节。`];
        writeDeveloperLog('consistency.audit.group.success', {
          index: group.index,
          total: group.total,
          conflict_count: response.conflicts.length,
          conflicts: response.conflicts,
          conflict_section_count: conflictsBySectionId.size,
        });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `一致性审计失败：第 ${group.index}/${group.total} 组，${error.message || '模型返回无效'}，已跳过该组。`];
        writeDeveloperLog('consistency.audit.group.error', {
          index: group.index,
          total: group.total,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      }
    }

    if (auditGroups.length > 1) {
      const [warmupGroup, ...remainingGroups] = auditGroups;
      logs = [...logs, `开始全文一致性审计预热：第 ${warmupGroup.index}/${warmupGroup.total} 组。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await auditConsistencyGroup(warmupGroup);
      pauseIfRequested('正文生成已在一致性审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingGroups.length) {
        await waitForPromptCacheWarmupBeforeFanout(`全文一致性审计预热完成，等待 5 秒后开始并发审计剩余 ${remainingGroups.length} 组。`);
        logs = [...logs, `开始并发审计剩余 ${remainingGroups.length} 组。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        await runItemsWithWorkerPool(remainingGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
    }

    pauseIfRequested('正文生成已在一致性审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(conflictsBySectionId.entries())
      .map(([sectionId, conflicts]) => ({ context: targetById.get(sectionId), conflicts }))
      .filter((target) => target.context);
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    logs = [...logs, repairTargets.length
      ? `一致性审计发现 ${repairTargets.length} 个冲突小节，开始局部修复，并发 ${contentConcurrency}。`
      : '一致性审计未发现需要修复的事实冲突。'];
    writeDeveloperLog('consistency.repair.start', {
      target_count: repairTargets.length,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ context, conflicts }) => ({
        section_id: context.item.id,
        title: context.item.title || '未命名章节',
        conflict_count: conflicts.length,
        conflicts,
      })),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    if (!repairTargets.length) {
      writeDeveloperLog('consistency.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0 });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairConsistencyTarget(target) {
      const item = target.context.item;
      try {
        const result = await repairConsistencySection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          logs = [...logs, `一致性修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部替换。`];
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          logs = [...logs, `一致性修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能唯一定位替换内容'}。`];
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        logs = [...logs, `一致性修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      } finally {
        contentStats.audit_fix_completed += 1;
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      logs = [...logs, `开始一致性修复预热：${warmupTarget.context.item.id} ${warmupTarget.context.item.title || '未命名章节'}。`];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

      await repairConsistencyTarget(warmupTarget);
      pauseIfRequested('正文生成已在一致性修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`一致性修复预热完成，等待 5 秒后开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发修复剩余 ${remainingTargets.length} 个小节。`];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在一致性修复阶段暂停，可导出当前已完成内容，稍后继续。');

    logs = [...logs, `一致性审计完成：发现 ${repairTargets.length} 个冲突小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`];
    writeDeveloperLog('consistency.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  function getCurrentSuccessfulContent(item) {
    const currentPlan = workspaceStore.loadTechnicalPlan() || {};
    const currentSections = currentPlan.contentGenerationSections || sections;
    const section = currentSections[item.id] || {};
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
          temperature: 0.2,
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
          updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
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
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
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
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
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
    const phaseSaved = workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'table-cleaning' }) });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, phaseSaved);

    const targets = buildTableCleanupTargets(options.targetItemId || targetItemId);
    const tableTotal = targets.reduce((sum, target) => sum + target.tables.length, 0);
    contentStats.table_cleanup_total = tableTotal;

    if (!tableTotal) {
      logs = [...logs, '正文去表格检查完成：未发现需要转换的表格。'];
      updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      return { ran: true, rewrittenCount: 0, skippedCount: 0 };
    }

    logs = [...logs, `开始正文去表格：发现 ${targets.length} 个小节、${tableTotal} 个表格，将转换为普通文字描述。`];
    writeDeveloperLog('table_cleanup.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      section_count: targets.length,
      table_count: tableTotal,
      sections: targets.map(({ item, tables }) => ({ id: item.id, title: item.title || '未命名章节', table_count: tables.length })),
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    let rewrittenCount = 0;
    let skippedCount = 0;
    for (const target of targets) {
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const result = await cleanupTablesForSection(target);
      rewrittenCount += result.rewrittenCount;
      skippedCount += result.skippedCount;
      contentStats.table_cleanup_skipped = skippedCount;
    }

    pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    logs = [...logs, `正文去表格完成：成功转换 ${rewrittenCount} 个表格，跳过 ${skippedCount} 个。`];
    writeDeveloperLog('table_cleanup.done', {
      table_count: tableTotal,
      rewritten_count: rewrittenCount,
      skipped_count: skippedCount,
    });
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
    return { ran: true, rewrittenCount, skippedCount };
  }

  async function runAiIllustration(context) {
    const { item } = context;
    const contentPlan = contentPlans.get(item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
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
        logTitle: `AI生图-${item.id}-${contentPlan.image.title || item.title || '未命名章节'}`,
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
    const contentPlan = contentPlans.get(item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
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
      selectedFactsText: resolveSelectedFactsText(contentPlan, globalFacts),
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
      ? `开始配图：AI 生图 ${aiImageTargets.length} 张（并发 ${imageConcurrency}），Mermaid 图 ${mermaidImageTargets.length} 张（并发 ${MERMAID_IMAGE_CONCURRENCY}）。`
      : '本次没有需要执行的配图。'];
    updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());

    if (!illustrationTotal) {
      return;
    }

    await Promise.all([
      runItemsWithWorkerPool(aiImageTargets, imageConcurrency, runAiIllustration, isPauseRequested),
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
        pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        await runItemsWithWorkerPool(tasksToRun, contentConcurrency, runOne, isPauseRequested);
        pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
      } else {
        await planAll();
        pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        await runEarlyContentProbeIfNeeded();
        if (tasksToRun.length) {
          await runContentTargetsWithWarmup(tasksToRun);
          pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
        }
      }
    }

    if (!targetItemId) {
      if (retryContentCorrection) {
        logs = [...logs, '本次为内容矫正重试，跳过正文生成和最低字数扩写，直接进入内容矫正阶段。'];
        updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, workspaceStore.loadTechnicalPlan());
      } else {
        await ensureMinimumWords();
        pauseIfRequested('正文生成已在最低字数检查后暂停，可导出当前已完成内容，稍后继续。');
      }
      if (originalPlanCoverageRepairMode === 'agent') {
        await runAgentOriginalCoverageRepairIfEnabled();
      } else {
        await runOriginalPlanCoverageAuditIfEnabled();
      }
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (consistencyRepairMode === 'agent') {
        await runAgentConsistencyRepairIfEnabled();
      } else {
        await runConsistencyAuditIfEnabled();
      }
      await removeTablesBeforeIllustration();
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      refreshIllustrationTargetsFromStoredPlans(touchedItemIds);
    } else {
      await runOriginalPlanCoverageAuditIfEnabled({ targetItemId });
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      await runConsistencyAuditIfEnabled({ targetItemId });
      await removeTablesBeforeIllustration({ targetItemId });
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      if (!tasksToRun.length) {
        refreshIllustrationTargetsFromStoredPlans(new Set([targetItemId]));
      }
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
    writeDeveloperLog('content.task.completed', {
      status: finalStatus,
      progress: finalProgress,
      failed_count: failedCount,
      stats: statsSnapshot(),
      touched_item_ids: [...touchedItemIds],
    });
    technicalPlan = workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: undefined,
      contentGenerationTask: updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }),
    });
    updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, technicalPlan);
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

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle };
