const crypto = require('node:crypto');
const Ajv = require('ajv');
const fs = require('node:fs');
const path = require('node:path');
const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');
const { createNoopDeveloperLogger } = require('../utils/developerLog.cjs');
const {
  createOriginalSource, readOriginalRange, buildOriginalRestorationFiles,
  buildOriginalRestorationPrompt, validateOriginalRestoration, calculateOriginalRestoration,
  originalImageReferences, validateOriginalImages, ORIGINAL_RESTORATION_JSON_SCHEMA,
} = require('./originalPlanRestoration.cjs');
const { countReadableWords } = require('../utils/wordCount.cjs');
const { CONTENT_PLANNING_AGENT_TASK_KEY } = require('./contentPlanningAgentConfig.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, runContentGenerationAgent, runContentLayoutAgent, readContentGenerationResult } = require('./contentGenerationAgent.cjs');
const { scanGeneratedSections, convertContentSections } = require('./contentGenerationOutput.cjs');
const { createTechnicalPlanExport } = require('./technicalPlanExport.cjs');
const { runContentLayoutCheck, readWordLayout } = require('./contentGenerationLayout.cjs');

const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';
const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';
const CONTENT_PLAN_VERSION = 6;
const ADDED_SECTION_TARGET_WORDS = 3000;
const CONTENT_PLANNING_OUTLINE_FILE = '正文编排目录.json';
const CONTENT_PLANNING_OUTPUT_FILE = '正文编排结果.json';
const CONTENT_PLANNING_KNOWLEDGE_FILE = '参考知识库轻量条目.json';
const CONTENT_PLANNING_BID_INFO_FILE = '招标文件关键信息.md';
const TABLE_REQUIREMENT_LABELS = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

const CONTENT_PLAN_SCHEMA = {
  type: 'object',
  required: ['writing_focus', 'knowledge', 'table', 'image_suitability_score', 'target_words'],
  additionalProperties: false,
  properties: {
    writing_focus: { type: 'string', minLength: 1 },
    target_words: { type: 'integer', minimum: 0 },
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

const CONTENT_PLANNING_JSON_SCHEMA = {
  type: 'object',
  required: ['plans'],
  additionalProperties: false,
  properties: {
    plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'content_plan'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          content_plan: CONTENT_PLAN_SCHEMA,
        },
      },
    },
  },
};
const contentPlanningAjv = new Ajv({ allErrors: true });
const validateContentPlanningResult = contentPlanningAjv.compile(CONTENT_PLANNING_JSON_SCHEMA);

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
  });
}

// 从目录生效配置计算全文写作基准，0 表示未设置全文目标。
function getContentWordTarget({ minimumWords = 0, maximumWords = 0 }) {
  if (minimumWords > 0 && maximumWords > 0) return Math.round((minimumWords + maximumWords) / 2);
  return Math.round(minimumWords > 0 ? minimumWords * 1.2 : maximumWords * 0.8);
}

// 新增待生成小节固定目标字数；其他编排按 Agent 提议的篇幅比例分配整数目标。
function allocateContentWordTargets(plans, control, totalSections, isIncremental = false) {
  const entries = [...plans.values()];
  if (!entries.length) return;
  if (isIncremental) {
    entries.forEach(plan => { plan.target_words = ADDED_SECTION_TARGET_WORDS; });
    return;
  }
  const totalTarget = getContentWordTarget(control);
  if (!totalTarget) {
    entries.forEach(plan => { plan.target_words = control.sectionWords || 0; });
    return;
  }
  const budget = Math.round(totalTarget * entries.length / totalSections);
  if (budget < entries.length) throw new Error('正文目标字数不足以为每个小节分配字数，请调整字数配置或目录规模。');
  if (entries.some(plan => !Number.isInteger(plan.target_words) || plan.target_words <= 0)) {
    throw new Error('已设置全文字数要求，正文编排必须为每个目标小节提供正整数 target_words。');
  }
  const proposedTotal = entries.reduce((sum, plan) => sum + plan.target_words, 0);
  if (proposedTotal === budget) return;
  const allocations = entries.map((plan, index) => {
    const exact = 1 + (budget - entries.length) * plan.target_words / proposedTotal;
    return { plan, index, words: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  const remainder = budget - allocations.reduce((sum, item) => sum + item.words, 0);
  allocations.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  allocations.forEach((item, index) => { item.plan.target_words = item.words + (index < remainder ? 1 : 0); });
}

function normalizeContentConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_TEXT_CONCURRENCY_LIMIT);
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
    target_words: source.target_words,
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
  const ratio = imageQuantity === 'heavy' ? 0.6 : imageQuantity === 'light' ? 0.3 : 0;
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
  if (!Number.isInteger(plan.target_words) || plan.target_words < 0) {
    throw new Error('正文编排决策的 target_words 必须是非负整数');
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
      id: item.id,
      number: item.number,
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
          target_words: stored.plan.target_words,
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

// 校验模型输出，只按稳定 ID 提取本轮目标编排，不接受目录结构或非目标结果。
function extractContentPlanningPlans(value, sourceItems, allowedKnowledgeItemIds, targetItemIds) {
  if (!validateContentPlanningResult(value)) {
    throw new Error(`正文编排结果格式错误：${contentPlanningAjv.errorsText(validateContentPlanningResult.errors)}`);
  }
  const aiLeafIds = new Set(collectLeafContexts(sourceItems).filter(({ item }) => item.content_mode === 'ai-generate').map(({ item }) => item.id));
  const expectedIds = targetItemIds || aiLeafIds;
  const plans = new Map();
  for (const { id, content_plan: rawPlan } of value.plans) {
    if (!expectedIds.has(id) || !aiLeafIds.has(id)) {
      throw new Error(`正文编排结果包含非目标 AI 小节：${id}`);
    }
    if (plans.has(id)) throw new Error(`正文编排结果重复提交小节：${id}`);
    if (allowedKnowledgeItemIds instanceof Set
      && rawPlan.knowledge.item_ids.some(itemId => !allowedKnowledgeItemIds.has(itemId))) {
      throw new Error(`正文编排结果引用了不存在的知识库条目：${id}`);
    }
    const plan = normalizeContentPlan(rawPlan, allowedKnowledgeItemIds);
    validateContentPlan(plan);
    if (plan.table.needed && !plan.table.purpose) {
      throw new Error(`正文编排结果缺少表格用途：${id}`);
    }
    if (!plan.table.needed && rawPlan.table.purpose.trim()) {
      throw new Error(`正文编排结果为无表格目录填写了表格用途：${id}`);
    }
    plans.set(id, plan);
  }
  for (const id of expectedIds) {
    if (!plans.has(id)) throw new Error(`正文编排结果缺少目标节点：${id}`);
  }
  // 保持程序分配字数时的目录顺序，不受模型返回数组顺序影响。
  return new Map([...aiLeafIds].filter(id => plans.has(id)).map(id => [id, plans.get(id)]));
}

function formatContentPlanningProgress(value) {
  return Array.from(singleLine(value)).slice(0, 30).join('');
}

function createContentPlanningPrompt({ targetItemIds, regenerateTargetItemIds, regenerateRequirement, tableRequirement, maxTables, totalSections, wordControl, isIncremental = false }) {
  const totalWordTarget = getContentWordTarget(wordControl);
  const wordInstruction = isIncremental
    ? `本次为目录变更后的新增小节编排，每节 target_words 固定填 ${ADDED_SECTION_TARGET_WORDS}，不按全文目标或每小节建议字数重新分配，其他小节的已有目标保持不变。`
    : totalWordTarget > 0
      ? `全文 AI 正文目标基准为 ${totalWordTarget} 字，共 ${totalSections} 个 AI 小节；本次 ${targetItemIds.length} 个目标小节的合计目标为 ${Math.round(totalWordTarget * targetItemIds.length / totalSections)} 字。结合各节重要程度、内容量与写作重点分配正整数 target_words，不必平均分配，不重复承担全文目标。程序会按你提供的比例校正取整后的合计；已有非目标小节的编排保持不变。全文目标优先于每小节建议字数。`
      : `未设置全文字数目标，每节 target_words 填 ${wordControl.sectionWords || 0}；0 表示不设字数目标。`;
  const tableRequirementLabel = TABLE_REQUIREMENT_LABELS[tableRequirement] || TABLE_REQUIREMENT_LABELS.heavy;
  const tableLimitInstruction = tableRequirement === 'heavy'
    ? '表格需求为“大量”，没有数量上限，但仍然只有明显适合表格的小节才将 table.needed 设为 true。'
    : tableRequirement === 'none'
      ? '表格需求为“不要”，table.needed 必须为 false，table.purpose 留空。'
      : `表格需求为“${tableRequirementLabel}”，全文共 ${totalSections || 0} 个 AI 生成小节，表格上限为 ${maxTables || 0} 个；在当前表格数量受限的模式下，table.needed=true 表示本节适合使用表格，属于候选建议。程序会在编排完成后根据全局数量限制确定最终结果，不应将候选标记理解为最终保留决定。`;
  const targetText = targetItemIds.length
    ? targetItemIds.map((id) => `- ${id}`).join('\n')
    : '无。结果输出空 plans 数组。';
  const requirementText = String(regenerateRequirement || '').trim()
    ? `\n程序已确认以下节点需要应用本次重新生成的额外要求：\n${regenerateTargetItemIds.map((id) => `- ${id}`).join('\n')}\n\n额外要求：\n${String(regenerateRequirement).trim()}\n`
    : '';
  return `你是投标技术方案正文编排 Agent。工作区已经提供本次任务的全部材料：
- ${CONTENT_PLANNING_KNOWLEDGE_FILE}：参考知识库轻量条目，只包含 id、标题和简介。
- ${CONTENT_PLANNING_BID_INFO_FILE}：招标文件关键信息。
- ${CONTENT_PLANNING_OUTLINE_FILE}：当前最新的完整目录及已有编排，只读参考。
结果单独写入 ${CONTENT_PLANNING_OUTPUT_FILE}，格式为 {"plans":[{"id":"目标小节稳定 ID","content_plan":{...}}]}。

程序已确定本次需要编排的目录节点：
${targetText}
${requirementText}
请严格完成以下工作：
1. 先读取全部三个文件，结合完整目录中的上下级和同级关系进行整体判断。
2. 完整目录仅供参考，不修改参考文件；plans 只包含程序列出的本次目标 AI 叶子，每个目标恰好一项，不提交非目标节点。
3. 每项只包含 id 和 content_plan；content_plan 必须包含 writing_focus、target_words、knowledge.item_ids、table.needed、table.purpose、image_suitability_score。image_needed 由程序计算，不输出。
字数编排要求：${wordInstruction} 字数只统计正文可读文字，不包含 HTML 标签和配图提示词；目标用于写作，不要求删减必要信息或重复凑字。
4. writing_focus 用 1-2 句话概括本节正文重点，不展开成正文，不编造具体参数、周期、人员、设备、品牌、型号或承诺，并避免与相邻章节重复。
5. knowledge.item_ids 只能从 ${CONTENT_PLANNING_KNOWLEDGE_FILE} 中选择，可以多选或为空数组，不要编造 id。
6. ${tableLimitInstruction}
7. 表格仅在能明显提升职责、步骤、参数、风险、措施或成果等内容的表达清晰度时使用；需要时准确填写用途，不需要时 purpose 留空。
8. image_suitability_score 是本节配图适配性评分，必须为 0-10 的整数：0 表示不适合配图，10 表示非常适合配图。结合本节标题、说明、写作重点和项目背景，判断图片能否帮助读者理解流程、结构、关系或设备、场景示意等内容；图片带来的理解帮助越明显，评分越高，仅起装饰作用时不应给高分。
9. id 原样使用目标节点的稳定 ID，不能用显示编号代替。不复制标题、编号、描述或目录树，程序按 ID 保存本次编排。
10. 用 write 将本次全部目标的编排写入 ${CONTENT_PLANNING_OUTPUT_FILE}；继续任务时可读取已有结果并接着完善，但提交范围始终以本次目标列表为准。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${CONTENT_PLANNING_OUTPUT_FILE}"}；失败后先修改文件再重新校验。`;
}

function formatRestoreTargetsForPrompt(targets) {
  return (targets || []).map(({ item, parentChapters, siblingChapters }) => {
    const parentPath = (parentChapters || []).map((parent) => `${parent.number} ${parent.title || '未命名章节'}`).join(' > ') || '无';
    const siblings = (siblingChapters || [])
      .filter((sibling) => sibling.id !== item.id)
      .map((sibling) => `${sibling.number} ${sibling.title || '未命名章节'}`)
      .join('；') || '无';
    return `- node_id: ${item.id}
  显示编号: ${item.number}
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

  const chapterNumber = String(chapter?.number || '').trim();
  const firstLine = unwrapMarkdownTitle(rawLines[firstContentLine]);
  let comparable = firstLine;

  if (chapterNumber) {
    comparable = comparable.replace(new RegExp(`^${escapeRegExp(chapterNumber)}\\s+`), '').trim();
  }
  comparable = comparable.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '').trim();

  if (comparable !== title && firstLine !== `${chapterNumber} ${title}`.trim()) {
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
    section_words: { ...(source.section_words || {}) },
    phase: String(source.phase || ''),
    touched_item_ids: normalizeStringArray(source.touched_item_ids),
    completed_stages: normalizeStringArray(source.completed_stages),
    developer_stage_gate: String(source.developer_stage_gate || '').trim(),
    target_item_id: String(source.target_item_id || '').trim(),
    regenerate_requirement: String(source.regenerate_requirement || '').trim(),
    html_output: source.html_output,
    updated_at: source.updated_at || now(),
  };
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

// 新任务首次落库和直接启动共用准备逻辑；继续/重试不调用，避免覆盖本轮进度。
function prepareContentGenerationStart(state, payload = {}) {
  const fullRegenerate = Boolean(payload.regenerate && !payload.targetItemId);
  const previous = fullRegenerate ? {} : state.contentGenerationRuntime || {};
  const partial = {
    contentGenerationRuntime: normalizeContentGenerationRuntime({
      generation_started: true, phase: 'planning',
      direct_generation_item_ids: previous.direct_generation_item_ids,
      pending_item_ids: previous.pending_item_ids,
      section_words: previous.section_words,
      html_output: previous.html_output,
      regenerate_requirement: String(payload.requirement || '').trim(),
    }),
  };
  if (fullRegenerate && state.outlineData) {
    partial.outlineData = { ...state.outlineData, outline: clearOutlineContent(state.outlineData.outline) };
    const leaves = collectLeafContexts(partial.outlineData.outline).filter(({ item }) => item?.content_mode === 'ai-generate');
    partial.contentGenerationSections = createInitialSections(leaves, {});
    partial.contentGenerationPlans = {};
  }
  return partial;
}

function progressFor(leaves, sections) {
  if (!leaves.length) {
    return 0;
  }

  const done = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id]?.status)).length;
  return Math.round((done / leaves.length) * 100);
}

const CONTENT_PHASE_LABELS = {
  planning: '正文编排',
  restoring: '原方案还原',
  generating: '正文生成',
  'sections-completed': '小节全部完成',
  'word-converting': '批量转换',
  'word-completed': '转换完成',
  auditing: '全文一致性检查',
  'table-cleaning': '表格清理',
  'layout-checking': '格式自检',
  done: '已完成',
};

const CONTENT_PROGRESS_PROFILES = {
  html: {
    planning: [0, 12], restoring: [12, 18], generating: [18, 70], auditing: [70, 80], 'table-cleaning': [80, 83], 'layout-checking': [83, 88],
    'sections-completed': [88, 88], 'word-converting': [88, 99], 'word-completed': [99, 99],
  },
  'html-single': {
    planning: [0, 15], restoring: [15, 25], generating: [25, 70], auditing: [70, 80], 'table-cleaning': [80, 85],
    'sections-completed': [85, 85], 'word-converting': [85, 90], 'word-completed': [90, 90],
  },
  full: {
    planning: [0, 12],
    restoring: [12, 18],
    generating: [18, 58],
    auditing: [58, 90],
    'table-cleaning': [90, 99],
    done: [100, 100],
  },
  single: {
    planning: [0, 15],
    restoring: [15, 25],
    generating: [25, 65],
    auditing: [65, 90],
    'table-cleaning': [90, 99],
    done: [100, 100],
  },
  correction: {
    auditing: [0, 90],
    'table-cleaning': [90, 99],
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
  } else if (phase === 'generating' || phase === 'sections-completed') {
    completed = stats.generation_completed;
    total = stats.generation_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'word-converting' || phase === 'word-completed') {
    completed = stats.word_conversion_completed;
    total = stats.word_conversion_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'auditing') {
    completed = stats.consistency_status === 'completed' ? 3 : Math.max(0, (stats.consistency_round || 1) - (stats.consistency_status === 'running' ? 1 : 0));
    total = 3;
    phaseProgress = percentageFor(completed, total);
    step = 'agent';
    stepLabel = stats.consistency_status === 'completed' ? '一致性审计及修复完成' : `第 ${stats.consistency_round || 1}/3 轮一致性审计及修复`;
  } else if (phase === 'table-cleaning') {
    completed = stats.table_cleanup_completed;
    total = stats.table_cleanup_total;
    phaseProgress = percentageFor(completed, total);
    step = 'cleaning';
  } else if (phase === 'layout-checking') {
    completed = stats.layout_completed;
    total = stats.layout_total;
    phaseProgress = stats.layout_status === 'completed' ? 100 : stats.layout_status === 'rechecking' ? 90
      : stats.layout_status === 'supplementing' ? 20 + percentageFor(completed, total) * 0.6 : 0;
    step = stats.layout_status || 'checking';
    stepLabel = ({ checking: '正在导出并检测页栏留白', supplementing: '正在并发补写', rechecking: '正在重新导出复查', completed: '格式自检完成' })[step];
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

// 只有生成成功的小节才算完成。
function isUnresolvedContentSection(section) {
  return section?.status !== 'success';
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

async function runContentGenerationTask({ aiService, agentService, workspaceStore, knowledgeBaseService, templateStore, openXmlHelperService, updateTask: updateManagedTask, checkpointTask: checkpointManagedTask, payload, taskControl, previousState, layoutDocument = readWordLayout }) {
  const resume = Boolean(payload.resume);
  const loadedPlan = resume ? (previousState || {}) : (workspaceStore.loadTechnicalPlan() || {});
  const continuing = resume || ['retryContentCorrection', 'retry_content_correction', 'retryFailedSections', 'retry_failed_sections'].some(field => payload[field]);
  const storedPlan = continuing ? loadedPlan : { ...loadedPlan, ...prepareContentGenerationStart(loadedPlan, payload) };
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
  const retryFailedSections = !resume && Boolean(payload.retryFailedSections ?? payload.retry_failed_sections);
  let contentRuntime = normalizeContentGenerationRuntime(storedPlan.contentGenerationRuntime || previousState?.contentGenerationRuntime);
  const continuingConsistency = Boolean((resume || retryFailedSections) && contentRuntime.phase === 'auditing');
  const continuingTableCleanup = Boolean((resume || retryFailedSections) && contentRuntime.phase === 'table-cleaning');
  const continuingLayout = Boolean((resume || retryFailedSections) && contentRuntime.phase === 'layout-checking');
  const continuingBody = Boolean((resume || retryFailedSections) && ['generating', 'auditing', 'table-cleaning'].includes(contentRuntime.phase));
  const continuingConversion = Boolean((resume || retryFailedSections)
    && ['sections-completed', 'word-converting', 'word-completed'].includes(contentRuntime.phase) && contentRuntime.html_output);
  const regenerate = !resume && !retryContentCorrection && !retryFailedSections && Boolean(payload.regenerate);
  const targetItemId = resume || (retryFailedSections && (contentRuntime.html_output || continuingConsistency))
    ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  if (retryContentCorrection && targetItemId) {
    throw new Error('单小节重新生成不支持重试内容矫正');
  }
  const fullRegenerate = regenerate && !targetItemId;
  const directGenerationIds = new Set(contentRuntime.direct_generation_item_ids);
  if (fullRegenerate) {
    workspaceStore.clearMermaidCache?.();
  }

  let leaves = collectLeafContexts(outlineData.outline)
    .filter(({ item }) => item?.content_mode === 'ai-generate');
  if (!leaves.length) {
    throw new Error('当前目录没有标记为“AI生成”的正文小节');
  }
  const regenerateRequirement = resume ? contentRuntime.regenerate_requirement : String(payload.requirement || '').trim();
  const generationOptions = retryFailedSections
    ? storedPlan.contentGenerationOptions || {}
    : payload.generationOptions || payload.generation_options || storedPlan.contentGenerationOptions || {};
  const imageQuantity = storedPlan.contentGenerationOptions.imageQuantity;
  const aiConfig = aiService.getConfig ? aiService.getConfig() : {};
  const contentConcurrency = normalizeContentConcurrency(aiConfig.concurrency_limit);
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const contentStats = {
    phase: continuingLayout ? 'layout-checking' : continuingTableCleanup ? 'table-cleaning' : continuingConsistency ? 'auditing' : 'planning',
    planning_total: 0,
    planning_completed: 0,
    restoration_total: 0,
    restoration_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    preview_ready_section_ids: (resume || retryFailedSections)
      ? storedPlan.contentGenerationTask?.stats?.content?.preview_ready_section_ids || [] : [],
    minimum_words: wordControl.minimumWords,
    maximum_words: wordControl.maximumWords,
    section_words: wordControl.sectionWords,
    current_words: 0,
    consistency_round: continuingConsistency ? previousState?.contentGenerationTask?.stats?.content?.consistency_round || 1 : 0,
    consistency_status: continuingConsistency ? 'running' : '',
    consistency_summary: '',
    consistency_remaining_issues: [],
    table_cleanup_total: 0,
    table_cleanup_completed: 0,
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
  });
  const completedStages = new Set(contentRuntime.completed_stages);
  let contentAgentState = resume ? storedPlan.contentGenerationTask?.stats?.agent : undefined;
  const contentPlans = new Map();
  let storedContentPlans = pruneContentGenerationPlans(storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems = [];
  let allowedKnowledgeItemIds = new Set();
  let sections = createInitialSections(leaves, storedPlan.contentGenerationSections);
  const touchedItemIds = new Set(contentRuntime.touched_item_ids);
  let tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    return regenerate || section?.status !== 'success' || !Object.hasOwn(contentRuntime.section_words, item.id);
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
      throw new Error('只有正文小节全部生成成功后，才能重试内容矫正');
    }
    successfulIds.forEach((itemId) => touchedItemIds.add(itemId));
    tasksToRun = [];
  }

  if (retryFailedSections) {
    tasksToRun = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
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

  if (continuingConsistency || continuingTableCleanup || continuingLayout) tasksToRun = [];

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
  }
  logs = [...logs, `文本模型并发上限：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  if (wordControl.minimumWords > 0 || wordControl.maximumWords > 0 || wordControl.sectionWords > 0) {
    logs = [...logs, `目录生效字数配置：最少 ${wordControl.minimumWords || '不限制'} 字，最多 ${wordControl.maximumWords || '不限制'} 字，每小节建议 ${wordControl.sectionWords || '不控制'} 字。`];
  }
  logs = [...logs, '全文一致性审计为必做阶段，正文扩写完成后将使用 Agent 检查并修复事实冲突。'];
  if (hasOriginalPlan) {
    logs = [...logs, `检测到已上传原方案：已读取完整原方案，交由 Agent 按语义还原。`];
  }

  const htmlWorkflow = !retryContentCorrection
    && (!resume || !contentRuntime.phase || ['planning', 'restoring', 'generating', 'auditing', 'table-cleaning', 'layout-checking', 'sections-completed', 'word-converting', 'word-completed'].includes(contentRuntime.phase));
  const progressMode = resume && storedPlan.contentGenerationTask?.progress_detail?.mode
    ? storedPlan.contentGenerationTask.progress_detail.mode
        : retryContentCorrection
          ? 'correction'
          : targetItemId
            ? (htmlWorkflow ? 'html-single' : 'single')
            : (htmlWorkflow ? 'html' : 'full');
  let lastTaskProgress = resume || (retryFailedSections && (contentRuntime.html_output || continuingConsistency || continuingTableCleanup || continuingLayout))
    ? Math.max(0, Number(previousState?.contentGenerationTask?.progress) || 0) : 0;

  // 所有正文任务更新都在这里补充累计进度和当前阶段明细。
  function buildTaskUpdate(partial = {}) {
    const latestLog = (partial.logs || logs || []).at(-1) || '';
    const progressDetail = buildContentPhaseProgress(contentStats, latestLog, progressMode);
    const calculatedProgress = buildContentOverallProgress(progressMode, progressDetail, partial.status);
    lastTaskProgress = Math.max(lastTaskProgress, calculatedProgress);
    return {
      ...partial,
      progress: lastTaskProgress,
      progress_detail: progressDetail,
      // Task 的独立明细字段不落库；本流程随既有 stats 保存，重开页面仍能显示转换进度。
      ...(['html', 'html-single'].includes(progressMode) && partial.stats?.content ? {
        stats: { ...partial.stats, content: { ...partial.stats.content, output_progress: progressDetail } },
      } : {}),
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
    const isIncremental = targetItemIds.every(id => contentRuntime.pending_item_ids.includes(id));
    const hasSession = agentService.hasPersistentTaskSession(CONTENT_PLANNING_AGENT_TASK_KEY);
    const continuingPlanning = (resume || retryFailedSections) && hasSession
      && storedPlan.contentGenerationTask?.stats?.agent?.phase === 'content-planning';
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
        wordControl,
        isIncremental,
      }),
      output_file: CONTENT_PLANNING_OUTPUT_FILE,
      files: [
        { path: CONTENT_PLANNING_KNOWLEDGE_FILE, content: renderKnowledgeItemsForPrompt(knowledgeItems) },
        { path: CONTENT_PLANNING_BID_INFO_FILE, content: formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText) },
        {
          path: CONTENT_PLANNING_OUTLINE_FILE,
          content: JSON.stringify({ outline: buildContentPlanningOutline(outlineData.outline, storedContentPlans) }, null, 2),
        },
        // 新一轮清空结果；同一轮继续时保留草稿供 Agent 修复。
        ...(!continuingPlanning ? [{ path: CONTENT_PLANNING_OUTPUT_FILE, content: '' }] : []),
      ],
      prepare_output_files: [CONTENT_PLANNING_OUTPUT_FILE],
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
    allocateContentWordTargets(plans, wordControl, leaves.length, isIncremental);
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

  rebuildContentWordCounts();

  function countTotalContentWords() {
    return totalContentWords;
  }

  function statsSnapshot() {
    contentStats.current_words = htmlWorkflow
      ? leaves.reduce((sum, { item }) => sum + (contentRuntime.section_words[item.id] || 0), 0)
      : countTotalContentWords();
    contentStats.minimum_words = wordControl.minimumWords;
    contentStats.maximum_words = wordControl.maximumWords;
    contentStats.section_words = wordControl.sectionWords;
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

  function persistPausedContentGeneration(message = '正文生成已暂停，可点击继续。') {
    logs = [...logs, message];
    const runtime = syncRuntime();
    checkpointTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
  }

  function pauseIfRequested(message = '正文生成已暂停，可点击继续。') {
    if (!isPauseRequested()) {
      return;
    }

    persistPausedContentGeneration(message);
    throw createContentGenerationPausedError();
  }

  function rememberTouchedItem(itemId) {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  const initialRuntime = syncRuntime();
  checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    contentGenerationRuntime: initialRuntime,
    referenceKnowledgeDocumentIds,
  }, {
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
      : '本次没有待生成的 AI 小节。'];
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
    if (targets.length) {
      const targetWords = targets.reduce((sum, { item }) => sum + nextPlans[item.id].plan.target_words, 0);
      logs.push(`本次编排目标字数：${targetWords || '未设置'}；全文基准：${getContentWordTarget(wordControl) || '未设置'} 字。`);
    }
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
    pauseIfRequested('正文生成已在编排阶段暂停，可点击继续。');
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

  // 每十秒统计已保存正文，Agent 完成后由程序逐节转换，不再请求 AI。
  async function runContentGeneration(targets) {
    const controller = new AbortController();
    const abortOnPause = () => {
      if (isPauseRequested() && !controller.signal.aborted) controller.abort(createContentGenerationPausedError());
    };
    const watcher = setInterval(abortOnPause, 500);
    const signal = AbortSignal.any([taskControl.signal, controller.signal]);
    let scanTimer;
    let scanError;
    contentStats.generation_total = targets.length;
    contentStats.generation_completed = 0;
    try {
      abortOnPause();
      signal.throwIfAborted();
      let result;
      if (continuingConversion) {
        result = readContentGenerationResult(contentRuntime.html_output.workspace_dir);
      } else {
        result = continuingLayout
          ? readContentGenerationResult(agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY).paths.workspaceDir)
          : await runContentGenerationAgent({
          agentService, aiService, resume: continuingBody,
          generationOptions: storedPlan.contentGenerationOptions,
          hasKnowledgeBase: referenceKnowledgeDocumentIds.length > 0,
          hasOriginalPlan, resolveOriginalImagePath: workspaceStore.resolveOriginalImagePath,
          signal,
          buildFiles: () => buildContentGenerationFiles({
            outline: outlineData.outline, targets, plans: storedContentPlans, sectionStates: sections,
            checkTotalWords: !targetItemId && targets.length === leaves.length,
            projectOverview, globalFacts, globalFactsMode, wordControl,
            generationOptions: storedPlan.contentGenerationOptions,
            hasOriginalPlan,
            restoredContents: hasOriginalPlan ? Object.fromEntries(targets.flatMap(({ item }) => {
              const state = getOriginalMaterialRuntimeState(item);
              return state.validRestored ? [[item.id, state.content]] : [];
            })) : {},
            // 已生成 HTML 用保存的字数；未生成的小节仍统计还原底稿，避免漏算或重复计算。
            existingTotalWords: hasOriginalPlan ? leaves.reduce((sum, { item }) => sum + (contentRuntime.section_words[item.id] ?? countReadableWords(sections[item.id]?.content || item.content || '')), 0) : 0,
            requirement: regenerateRequirement,
            template: templateStore.getTemplate(storedPlan.exportTemplateId),
            knowledgeBaseService, documentIds: referenceKnowledgeDocumentIds,
          }),
          onWorkspaceReady(workspaceDir) {
            const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
            contentStats.generation_total = decisions.targets.length;
            clearInterval(scanTimer);
            // 非空 HTML 只用于进度和目录预览展示，不提前提交正式成功状态或 Word 转换记录。
            const scan = () => {
              try {
                const readyIds = scanGeneratedSections(workspaceDir, decisions.targets);
                const count = Math.max(contentStats.generation_completed, readyIds.length);
                const previousIds = contentStats.preview_ready_section_ids;
                if (count === contentStats.generation_completed && readyIds.length === previousIds.length
                  && readyIds.every((id, index) => id === previousIds[index])) return;
                contentStats.preview_ready_section_ids = readyIds;
                contentStats.generation_completed = count;
                publishTaskUpdate({ status: 'running', stats: statsSnapshot() });
              } catch (error) {
                scanError = error;
                controller.abort(error);
              }
            };
            scan();
            scanTimer = setInterval(scan, 10000);
          },
          onConsistencyProgress(state) {
            contentStats.phase = 'auditing';
            contentStats.consistency_round = state.round;
            contentStats.consistency_status = state.status;
            contentStats.consistency_summary = state.summary || '';
            contentStats.consistency_remaining_issues = state.remaining_issues;
            if (state.status === 'completed') {
              logs = [...logs, state.remaining_issues.length
                ? `一致性审计已达三轮上限，仍有 ${state.remaining_issues.length} 项未解决：${state.remaining_issues.join('；')}`
                : '本次目标小节一致性审计及修复完成，未发现尚未解决的矛盾。'];
            }
            checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime({ phase: 'auditing' }) });
          },
          onTableCleanupProgress(state) {
            contentStats.phase = 'table-cleaning';
            contentStats.table_cleanup_total = state.section_ids.length;
            contentStats.table_cleanup_completed = state.completed_section_ids.length;
            if (state.status === 'completed') logs = [...logs, `去表格完成，已处理 ${state.completed_section_ids.length} 个小节，图片表格保留。`];
            checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime({ phase: 'table-cleaning' }) });
          },
          onCheckpoint: checkpoint => updateContentAgentState(checkpoint),
          onActivity(event = {}) {
            if (event.visible === false || !event.message) return;
            publishTaskUpdate({ status: 'running', logs: [...logs, `正文生成 Agent：${event.message}`], stats: statsSnapshot() });
          },
          onProgress(result) {
            logs = [...logs, `正文文件已保存：${result.section_id}，${result.words} 字（${result.completed}/${result.total}）。`];
            publishTaskUpdate({ status: 'running', logs, stats: statsSnapshot() });
          },
        });
        clearInterval(scanTimer);
        contentStats.preview_ready_section_ids = result.sections.map(section => section.section_id);
        if (!targetItemId) {
          await runContentLayoutCheck({
            exporter: createTechnicalPlanExport({ technicalPlanStore: workspaceStore, templateStore, agentService, openXmlHelperService }),
            taskKey: CONTENT_GENERATION_AGENT_TASK_KEY, agentService, result, signal, resume: continuingLayout, layoutDocument,
            supplement: layout => runContentLayoutAgent({ agentService, signal, layout,
              onCheckpoint: checkpoint => updateContentAgentState({ ...checkpoint, task_key: CONTENT_GENERATION_AGENT_TASK_KEY }),
              onActivity(event = {}) {
                if (event.visible !== false && event.message) publishTaskUpdate({ status: 'running', logs: [...logs, `格式自检 Agent：${event.message}`], stats: statsSnapshot() });
              },
            }),
            onProgress(state) {
              contentStats.phase = 'layout-checking';
              contentStats.layout_status = state.status;
              contentStats.layout_total = state.jobs.length;
              contentStats.layout_completed = state.completed_section_ids.length;
              if (state.status === 'completed') logs = [...logs, state.remaining_gaps.length
                ? `格式自检补写后仍有 ${state.remaining_gaps.length} 处明显留白，本轮不再补写：${state.remaining_gaps.map(gap => `第${gap.page}页第${gap.column}栏约${gap.gap_cm}cm`).join('；')}`
                : '格式自检完成，未发现本次目标小节中需要补写的明显页栏留白。'];
              checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime({ phase: 'layout-checking' }) });
            },
          });
          // 补写后只刷新实际字数，不再次启动字数调整或一致性审计。
          result = readContentGenerationResult(result.workspaceDir);
        }
        contentRuntime.html_output = {
          workspace_dir: result.workspaceDir,
          word_output_dir: workspaceStore.getContentWordOutputDir(),
          word_sections: (contentRuntime.html_output?.word_sections || []).filter(section => !result.sections.some(target => target.section_id === section.section_id)),
        };
        contentStats.phase = 'sections-completed';
        logs = [...logs, `小节全部完成，共 ${result.sections.length} 节。`];
      }
      contentStats.generation_total = result.sections.length;
      contentStats.generation_completed = result.sections.length;
      contentStats.preview_ready_section_ids = result.sections.map(section => section.section_id);
      contentStats.generated_html_words = result.sections.reduce((sum, section) => sum + section.words, 0);
      for (const section of result.sections) contentRuntime.section_words[section.section_id] = section.words;
      contentStats.generated_html_workspace = result.workspaceDir;
      contentStats.word_conversion_total = result.sections.length;
      const resultIds = new Set(result.sections.map(section => section.section_id));
      contentStats.word_conversion_completed = contentRuntime.html_output.word_sections.filter(section => resultIds.has(section.section_id)).length;
      updateContentAgentState({ task_key: CONTENT_GENERATION_AGENT_TASK_KEY, status: 'success', agent_connection: 'idle' }, false);
      checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime() });
      abortOnPause();
      signal.throwIfAborted();
      contentStats.phase = 'word-converting';
      logs = [...logs, '开始批量转换 Word，每个小节生成一个文件。'];
      checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime() });
      // 转换记录和小节状态一起提交；只更新本轮已完成项，不回写 HTML。
      function saveConvertedSections(wordSections) {
        contentRuntime.html_output.word_sections = [
          ...contentRuntime.html_output.word_sections.filter(section => !resultIds.has(section.section_id)), ...wordSections,
        ];
        const completedIds = new Set(wordSections.map(section => section.section_id));
        for (const id of completedIds) {
          sections[id] = { ...sections[id], status: 'success', error: undefined, updated_at: now() };
        }
        contentRuntime.pending_item_ids = contentRuntime.pending_item_ids.filter(id => !completedIds.has(id));
        contentStats.word_conversion_completed = wordSections.length;
        checkpointTask({ status: 'running', logs, stats: statsSnapshot() }, {
          contentGenerationSections: sections,
          contentGenerationRuntime: syncRuntime(),
        }, { technicalPlanPatch: { contentGenerationSections: sections } });
      }
      const wordSections = await convertContentSections({
        result, outputDir: contentRuntime.html_output.word_output_dir,
        openXmlHelperService, signal, completed: contentRuntime.html_output.word_sections,
        onProgress(wordSections) {
          logs = [...logs, `Word 已保存：${wordSections.at(-1).file}（${wordSections.length}/${result.sections.length}）。`];
          saveConvertedSections(wordSections);
        },
      });
      // 重试时复用的 Word 不触发转换回调，同样恢复其成功状态。
      saveConvertedSections(wordSections);
      abortOnPause();
      signal.throwIfAborted();
      contentStats.phase = 'word-completed';
      logs = [...logs, `转换完成，共 ${result.sections.length} 个 Word 文件。`, `输出目录：${contentRuntime.html_output.word_output_dir}`];
      const runtime = syncRuntime({ developer_stage_gate: '' });
      checkpointTask({ status: 'success', logs, stats: statsSnapshot(), pause_requested: false }, {
        contentGenerationSections: sections,
        contentGenerationRuntime: runtime,
      }, { contentRuntime: runtime });
    } catch (error) {
      error = scanError || error;
      const paused = isPauseRequested() || isPauseLikeError(error);
      if (!['sections-completed', 'word-converting', 'word-completed'].includes(contentStats.phase)) {
        updateContentAgentState({ task_key: CONTENT_GENERATION_AGENT_TASK_KEY, status: paused ? 'paused' : 'error', agent_connection: 'idle' }, false);
      }
      if (paused) {
        if (!['sections-completed', 'word-converting', 'word-completed'].includes(contentStats.phase) && agentService.hasPersistentTaskSession(CONTENT_GENERATION_AGENT_TASK_KEY)) {
          agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'paused', agent_connection: 'idle' });
        }
        persistPausedContentGeneration(['sections-completed', 'word-converting', 'word-completed'].includes(contentStats.phase)
          ? 'Word 转换已暂停，已完成文件保留，继续时只转换剩余小节。'
          : contentStats.phase === 'layout-checking'
            ? '格式自检已暂停，补写进度已保留，继续后只处理未完成任务并复查。'
          : contentStats.phase === 'table-cleaning'
            ? '去表格已暂停，正文和处理进度已保留，继续后在原会话中接着处理。'
          : contentStats.phase === 'auditing'
            ? '一致性审计已暂停，当前轮次及正文已保留，继续后在同一会话接着处理。'
            : '正文生成已暂停，已完成的 HTML 文件和 Agent 会话已保留，继续后接着生成。');
        throw createContentGenerationPausedError();
      }
      checkpointTask({ status: 'error', error: error.message, logs, stats: statsSnapshot() }, { contentGenerationRuntime: syncRuntime() });
      throw error;
    } finally {
      clearInterval(scanTimer);
      clearInterval(watcher);
    }
  }

  try {
    if (continuingConsistency || continuingTableCleanup || continuingLayout) {
      await runContentGeneration([]);
      return;
    }
    // 本轮已交付 HTML 后，暂停继续或失败重试直接续转 Word，不再启动 Agent。
    if (htmlWorkflow && continuingConversion) {
      contentStats.phase = 'word-converting';
      await runContentGeneration([]);
      return;
    }
    if (tasksToRun.length) {
      if (!completedStages.has('planning')) {
        await planAll();
        markStageCompleted('planning');
        pauseIfRequested('正文生成已在正文编排后暂停，可点击继续。');
      }
      if (hasOriginalPlan && !completedStages.has('restoring') && tasksToRun.some(({ item }) => !directGenerationIds.has(item.id))) {
        await restoreOriginalMaterialsIfNeeded(tasksToRun.filter(({ item }) => !directGenerationIds.has(item.id)));
        markStageCompleted('restoring');
        pauseIfRequested('正文生成已在原方案还原阶段暂停，可点击继续。');
      }
      startContentGenerationStage();
      await runContentGeneration(tasksToRun);
      return;
    }

    // HTML 文件产出阶段没有目标时也直接结束，只有显式后处理入口继续走原流程。
    if (!retryContentCorrection && !tasksToRun.length) {
      checkpointTask({ status: 'success', progress: 100, logs, stats: statsSnapshot() });
      return;
    }

    pauseIfRequested('正文生成已在完成前暂停，可点击继续。');

    const statusLeaves = targetItemId ? leaves.filter(({ item }) => item.id === targetItemId) : leaves;
    for (const { item } of statusLeaves) {
      const status = sections[item.id]?.status;
      if (status === 'error') continue;
      const content = getLeafContentForWords(item);
      if (countContentWords(content) > 0) {
        if (status !== 'success') {
          saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
        }
        continue;
      }
      const message = '正文最终结果没有有效可读内容';
      logs = [...logs, `正文有效性检查失败：${item.number} ${item.title || '未命名章节'}，${message}。`];
      saveSection(item, { status: 'error', content, error: message }, content, { logs });
    }
    rebuildContentWordCounts();
    const failedCount = statusLeaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
    const finalProgress = progressFor(leaves, sections);
    const finalStatus = taskStatusFor(statusLeaves, sections);
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
    checkpointTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: {
        generation_started: true,
        direct_generation_item_ids: contentRuntime.direct_generation_item_ids,
        pending_item_ids: contentRuntime.pending_item_ids.filter(id => sections[id]?.status !== 'success'),
      },
    });
  } catch (error) {
    if (isAiQueueScopePausedError(error)) {
      persistPausedContentGeneration('正文生成已暂停，未发起的 AI 请求已从队列丢弃，可点击继续。');
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

module.exports = { runContentGenerationTask, prepareContentGenerationStart, stripRepeatedChapterTitle, __developerContentExpansionPatchRuntime };
