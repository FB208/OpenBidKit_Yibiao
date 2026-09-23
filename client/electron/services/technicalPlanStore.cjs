const { numberOutline } = require('./technicalPlanOutline.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getBidAnalysisTasks } = require('./bidAnalysisTask.cjs');
const {
  getTechnicalPlanDir,
  getTechnicalPlanBidTemplatePath,
  getTechnicalPlanBidTemplateSourcePath,
  getTechnicalPlanBidTemplateFieldsPath,
  getTechnicalPlanOriginalPlanMarkdownPath,
  getTechnicalPlanTenderMarkdownPath,
  getTechnicalPlanTenderOriginalsDir,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getWorkspaceTrashDir,
} = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { clearMermaidCache } = require('../utils/mermaidCache.cjs');
const { detectBidSections } = require('../utils/bidSectionDetector.cjs');
const { compactLogError, createDeveloperLogger } = require('../utils/developerLog.cjs');
const { forceRemoveSync, isFileLockError } = require('../utils/forceRemove.cjs');
const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { CONTENT_PLANNING_AGENT_TASK_KEY } = require('./contentPlanningAgentConfig.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { originalImageReferences } = require('./originalPlanRestoration.cjs');

const tenderMarkdownRelativePath = path.join('technical-plan', 'tender.md').replace(/\\/g, '/');
const tenderOriginalMarkdownRelativePath = path.join('technical-plan', 'tender-original.md').replace(/\\/g, '/');
const tenderSourceFilesDirRelativePath = path.join('technical-plan', 'tender-files').replace(/\\/g, '/');
const tenderOriginalsDirRelativePath = path.join('technical-plan', 'tender-originals').replace(/\\/g, '/');
const bidTemplateRelativePath = path.join('technical-plan', 'bid-template.docx').replace(/\\/g, '/');
const bidTemplateSourceRelativePath = path.join('technical-plan', 'bid-template-source.docx').replace(/\\/g, '/');
const bidTemplateFieldsRelativePath = path.join('technical-plan', 'bid-template-fields.json').replace(/\\/g, '/');
const originalPlanMarkdownRelativePath = path.join('technical-plan', 'original-plan.md').replace(/\\/g, '/');
const originalOutlineRuntimeFileName = 'original-outline-runtime.json';
const defaultOutlineWordControlOptions = Object.freeze({
  enabled: false,
  minimumWords: 0,
  maximumWords: 0,
  sectionWords: 0,
});
const defaultHtmlImageTypes = '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';
const defaultExportTemplateId = 'tpl-system-standard-bid';
const defaultContentGenerationOptions = Object.freeze({
  imageQuantity: 'light',
  useAiImages: true,
  useMermaidImages: true,
  useHtmlImages: true,
  htmlImageTypes: defaultHtmlImageTypes,
  tableRequirement: 'heavy',
});

const initialState = {
  step: 'document-analysis',
  tenderFile: null,
  tenderFiles: [],
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisSelectedTaskIds: [],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  bidSectionMode: 'single',
  bidSections: [],
  bidSectionExtractionStatus: 'idle',
  bidSectionExtractionError: undefined,
  outlineMode: 'response-file',
  outlineExpansionMode: 'ai-complement',
  outlineWordControlOptions: { ...defaultOutlineWordControlOptions },
  outlineWordControlSnapshot: undefined,
  referenceKnowledgeDocumentIds: [],
  bidSectionExtractionTask: undefined,
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  globalFactsMode: 'fabricate',
  globalFactsTask: undefined,
  globalFacts: [],
  contentGenerationTask: undefined,
  exportTemplateId: defaultExportTemplateId,
  exportTemplateScope: 'ai-only',
  contentGenerationOptions: { ...defaultContentGenerationOptions },
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentGenerationRuntime: undefined,
  bidTemplateExists: false,
  outlineData: null,
};

const taskFieldTypes = {
  bidSectionExtractionTask: 'bid-section-extraction',
  bidAnalysisTask: 'bid-analysis',
  outlineGenerationTask: 'outline-generation',
  outlineAdjustmentTask: 'outline-adjustment',
  globalFactsTask: 'global-facts-generation',
  globalFactsAdjustmentTask: 'global-facts-adjustment',
  contentGenerationTask: 'content-generation',
};

const taskTypeFields = Object.fromEntries(Object.entries(taskFieldTypes).map(([field, type]) => [type, field]));
function appendImportFailureParts(messageParts, errors) {
  const failed = Array.isArray(errors)
    ? errors.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!failed.length) return;
  messageParts.push(`失败 ${failed.length} 份`);
  messageParts.push(failed.join('；'));
}

function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function isEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function safeFileNamePart(value) {
  return String(value || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'file';
}

/** 生成符合当前文件系统大小写规则的路径比较键。 */
function filePathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createTenderSourceId(fileName, markdown, index) {
  const hash = stableHash(`${fileName}\n${markdown}`).slice(0, 12);
  return `tender-${String(index + 1).padStart(2, '0')}-${hash}`;
}

function combineTenderMarkdown(markdowns) {
  return (Array.isArray(markdowns) ? markdowns : [])
    .map((markdown) => String(markdown || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Number(value) === 1;
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

// 统一目录生成当前设置和目录快照的字段语义。
function normalizeOutlineWordControlOptions(value) {
  const sectionWords = normalizeNonNegativeInteger(value?.sectionWords);
  return {
    minimumWords: normalizeNonNegativeInteger(value?.minimumWords),
    maximumWords: normalizeNonNegativeInteger(value?.maximumWords),
    sectionWords,
  };
}

function isValidStep(value) {
  return ['document-analysis', 'generation-settings', 'bid-analysis', 'outline-generation', 'global-facts', 'content-edit', 'expand'].includes(value);
}

function normalizeGlobalFactId(value, index) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || `fact_${String(index + 1).padStart(3, '0')}`;
}

function isValidBidMode(value) {
  return value === 'key' || value === 'full' || value === 'custom';
}

function normalizeBidSectionMode(value) {
  return value === 'multiple' ? 'multiple' : 'single';
}

function normalizeBidSectionExtractionStatus(value) {
  return normalizeStatus(value, ['idle', 'running', 'success', 'error'], 'idle');
}

function normalizeBidSectionRanges(value) {
  return (Array.isArray(value) ? value : [])
    .map((range) => ({
      startLine: Math.max(1, Math.floor(Number(range?.startLine || range?.start_line || 0))),
      endLine: Math.max(1, Math.floor(Number(range?.endLine || range?.end_line || 0))),
      reason: range?.reason ? String(range.reason) : undefined,
    }))
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine);
}

function normalizeBidSections(value) {
  return (Array.isArray(value) ? value : [])
    .map((section, index) => {
      const normalizedIndex = Number(section?.index || index + 1);
      const title = String(section?.title || '').trim();
      return {
        id: String(section?.id || `section-${normalizedIndex || index + 1}`).trim(),
        index: Number.isFinite(normalizedIndex) && normalizedIndex > 0 ? normalizedIndex : index + 1,
        unit: String(section?.unit || '标段').trim() || '标段',
        title,
        headLine: String(section?.headLine || section?.head_line || ''),
        description: String(section?.description || ''),
        includeRanges: normalizeBidSectionRanges(section?.includeRanges || section?.include_ranges),
        evidence: (Array.isArray(section?.evidence) ? section.evidence : [])
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      };
    })
    .filter((section) => section.id && section.title);
}

function expandLineRanges(ranges, totalLines) {
  const lines = new Set();
  for (const range of normalizeBidSectionRanges(ranges)) {
    const start = Math.max(1, Math.min(totalLines, range.startLine));
    const end = Math.max(start, Math.min(totalLines, range.endLine));
    for (let line = start; line <= end; line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

function buildSelectedSectionMarkdown(markdown, sections, selectedSectionId) {
  const sourceLines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const totalLines = sourceLines.length;
  const selected = sections.find((section) => section.id === selectedSectionId);
  if (!selected) {
    throw new Error('未找到选择的投标范围');
  }
  if (!normalizeBidSectionRanges(selected.includeRanges).length) {
    throw new Error('当前标段缺少有效范围，请重新识别');
  }

  const selectedLines = expandLineRanges(selected.includeRanges, totalLines);
  const otherLines = new Set();
  for (const section of sections) {
    if (section.id === selected.id) continue;
    for (const line of expandLineRanges(section.includeRanges, totalLines)) {
      otherLines.add(line);
    }
  }

  const filtered = sourceLines.filter((_, index) => {
    const lineNumber = index + 1;
    return !otherLines.has(lineNumber) || selectedLines.has(lineNumber);
  }).join('\n').trim();

  if (!filtered) {
    throw new Error('生成投标范围工作副本失败，请重新提取标段');
  }
  return filtered;
}

function getAllBidAnalysisTasks() {
  return getBidAnalysisTasks('full');
}

function getRequiredBidAnalysisTaskIds() {
  return getBidAnalysisTasks('key').map((task) => task.id);
}

function normalizeBidAnalysisTaskIds(taskIds) {
  const requestedIds = new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((taskId) => String(taskId || '').trim())
    .filter(Boolean));
  return getAllBidAnalysisTasks()
    .filter((task) => requestedIds.has(task.id))
    .map((task) => task.id);
}

function normalizeBidAnalysisConfig(mode, selectedTaskIds) {
  const allTaskIds = getAllBidAnalysisTasks().map((task) => task.id);
  const requiredTaskIds = getRequiredBidAnalysisTaskIds();
  const requiredSet = new Set(requiredTaskIds);
  const selectedSet = new Set([...requiredTaskIds, ...normalizeBidAnalysisTaskIds(selectedTaskIds)]);
  const selectedIds = allTaskIds.filter((taskId) => selectedSet.has(taskId));
  const hasOptional = selectedIds.some((taskId) => !requiredSet.has(taskId));
  const hasAll = selectedIds.length === allTaskIds.length;

  if (mode === 'full' || hasAll) {
    return { mode: 'full', selectedTaskIds: allTaskIds };
  }
  if (mode === 'custom' || hasOptional) {
    return { mode: 'custom', selectedTaskIds: selectedIds };
  }
  return { mode: 'key', selectedTaskIds: requiredTaskIds };
}

function getBidAnalysisTaskIdsForConfig(mode, selectedTaskIds) {
  return normalizeBidAnalysisConfig(mode, selectedTaskIds).selectedTaskIds;
}

function isValidOutlineExpansionMode(value) {
  return value === 'original-only' || value === 'ai-complement';
}

function isValidGlobalFactsMode(value) {
  return value === 'fabricate' || value === 'omit' || value === 'placeholder';
}

function normalizeGlobalFactsMode(value) {
  return isValidGlobalFactsMode(value) ? value : 'fabricate';
}

function normalizeGenerationDocumentIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeContentGenerationOptions(options) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    imageQuantity: source.imageQuantity ?? defaultContentGenerationOptions.imageQuantity,
    useAiImages: hasOwn(source, 'useAiImages') ? Boolean(source.useAiImages) : defaultContentGenerationOptions.useAiImages,
    useMermaidImages: hasOwn(source, 'useMermaidImages') ? Boolean(source.useMermaidImages) : defaultContentGenerationOptions.useMermaidImages,
    useHtmlImages: hasOwn(source, 'useHtmlImages') ? Boolean(source.useHtmlImages) : defaultContentGenerationOptions.useHtmlImages,
    htmlImageTypes: String(source.htmlImageTypes || defaultContentGenerationOptions.htmlImageTypes),
    tableRequirement: ['none', 'light', 'moderate', 'heavy'].includes(source.tableRequirement) ? source.tableRequirement : defaultContentGenerationOptions.tableRequirement,
  };
}

function createDefaultGenerationConfig() {
  const bidAnalysis = normalizeBidAnalysisConfig('key', []);
  return {
    bidAnalysisMode: bidAnalysis.mode,
    bidAnalysisSelectedTaskIds: bidAnalysis.selectedTaskIds,
    bidSectionMode: 'single',
    outlineMode: 'response-file',
    outlineExpansionMode: 'ai-complement',
    outlineWordControlOptions: { ...defaultOutlineWordControlOptions },
    referenceKnowledgeDocumentIds: [],
    globalFactsMode: 'fabricate',
    exportTemplateId: defaultExportTemplateId,
    exportTemplateScope: 'ai-only',
    contentGenerationOptions: { ...defaultContentGenerationOptions },
  };
}

function normalizeGenerationConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const defaults = createDefaultGenerationConfig();
  const bidAnalysis = normalizeBidAnalysisConfig(source.bidAnalysisMode, source.bidAnalysisSelectedTaskIds);
  return {
    bidAnalysisMode: bidAnalysis.mode,
    bidAnalysisSelectedTaskIds: bidAnalysis.selectedTaskIds,
    bidSectionMode: normalizeBidSectionMode(source.bidSectionMode),
    outlineMode: ['response-file', 'standalone-technical', 'standalone-business'].includes(source.outlineMode)
      ? source.outlineMode
      : 'response-file',
    outlineExpansionMode: isValidOutlineExpansionMode(source.outlineExpansionMode) ? source.outlineExpansionMode : defaults.outlineExpansionMode,
    outlineWordControlOptions: normalizeOutlineWordControlOptions(source.outlineWordControlOptions),
    referenceKnowledgeDocumentIds: normalizeGenerationDocumentIds(source.referenceKnowledgeDocumentIds),
    globalFactsMode: normalizeGlobalFactsMode(source.globalFactsMode),
    exportTemplateId: String(source.exportTemplateId || '').trim(),
    exportTemplateScope: source.exportTemplateScope ?? defaults.exportTemplateScope,
    contentGenerationOptions: normalizeContentGenerationOptions(source.contentGenerationOptions),
  };
}

function collectLeafItems(items) {
  return (items || []).flatMap((item) => item?.children?.length ? collectLeafItems(item.children) : [item]);
}

function flattenOutlineItems(items, parentNodeId = null, level = 1, rows = []) {
  (items || []).forEach((item, index) => {
    const nodeId = String(item?.id || '').trim();
    if (!nodeId) return;
    rows.push({
      node_id: nodeId,
      parent_node_id: parentNodeId,
      sort_order: index,
      level,
      title: String(item?.title || '未命名章节').trim() || '未命名章节',
      description: String(item?.description || '').trim(),
      content_mode: item?.children?.length ? null : String(item?.content_mode || '').trim() || null,
      content_mode_note: item?.children?.length || item?.content_mode !== 'other' ? null : String(item?.content_mode_note || '').trim() || null,
      source_requirement_id: item?.source_requirement_id ? String(item.source_requirement_id) : null,
      source_requirement_title: item?.source_requirement_title ? String(item.source_requirement_title) : null,
      knowledge_item_ids_json: Array.isArray(item?.knowledge_item_ids) && item.knowledge_item_ids.length ? JSON.stringify(item.knowledge_item_ids) : null,
      content: String(item?.content || ''),
    });
    if (item?.children?.length) {
      flattenOutlineItems(item.children, nodeId, level + 1, rows);
    }
  });
  return rows;
}

function clearOutlineItemContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: '',
    children: item?.children?.length ? clearOutlineItemContent(item.children) : item.children,
  }));
}

function clearOutlineDataContent(outlineData) {
  if (!outlineData?.outline?.length) return outlineData;
  return { ...outlineData, outline: clearOutlineItemContent(outlineData.outline) };
}

const outlineSaveReasons = new Set(['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace']);

function normalizeOutlineSaveReason(value) {
  return outlineSaveReasons.has(value) ? value : 'replace';
}

function normalizeStringSet(value) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
}

function mapOutlineItems(items, mapper) {
  return (items || []).map((item) => {
    const nextItem = mapper(item);
    if (item?.children?.length) {
      nextItem.children = mapOutlineItems(item.children, mapper);
    }
    return nextItem;
  });
}

function createTechnicalPlanStore({ app, db, fileService, agentService, taskLogStore, configStore }) {
  function deleteOutlineAgentTask() {
    agentService.deletePersistentTask(OUTLINE_AGENT_TASK_KEY);
    agentService.deletePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
    agentService.deletePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY);
    agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
    agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
  }
  function deleteGlobalFactsAgentTask() {
    agentService.deletePersistentTask(GLOBAL_FACTS_AGENT_TASK_KEY);
  }
  let agentWorkspaceChangeListener = null;
  let lastAgentWorkspaceSignal = null;
  function setAgentWorkspaceChangeListener(listener) {
    agentWorkspaceChangeListener = typeof listener === 'function' ? listener : null;
  }
  function getAgentWorkspaceSignal() {
    const meta = ensureMetaRow();
    const hasOutline = Boolean(db.prepare('SELECT 1 FROM technical_plan_outline_nodes LIMIT 1').get());
    const hasFacts = Boolean(db.prepare('SELECT 1 FROM technical_plan_global_fact_groups LIMIT 1').get());
    const hasContentPlans = Boolean(db.prepare('SELECT 1 FROM technical_plan_content_plans LIMIT 1').get());
    return `${meta.step || ''}|${hasOutline ? 1 : 0}|${hasFacts ? 1 : 0}|${hasContentPlans ? 1 : 0}`;
  }
  function notifyAgentWorkspaceChange(options = {}) {
    const signal = getAgentWorkspaceSignal();
    if (!options.force && signal === lastAgentWorkspaceSignal) return;
    lastAgentWorkspaceSignal = signal;
    if (!agentWorkspaceChangeListener) return;
    try {
      agentWorkspaceChangeListener();
    } catch (error) {
      console.error('[technical-plan] Agent 工作空间变更通知失败:', error);
    }
  }
  const tenderMarkdownPath = getTechnicalPlanTenderMarkdownPath(app);
  const tenderOriginalMarkdownPath = path.join(path.dirname(tenderMarkdownPath), 'tender-original.md');
  const tenderSourceFilesDir = path.join(path.dirname(tenderMarkdownPath), 'tender-files');
  const tenderOriginalsDir = getTechnicalPlanTenderOriginalsDir(app);
  const bidTemplatePath = getTechnicalPlanBidTemplatePath(app);
  const bidTemplateSourcePath = getTechnicalPlanBidTemplateSourcePath(app);
  const bidTemplateFieldsPath = getTechnicalPlanBidTemplateFieldsPath(app);
  const originalPlanMarkdownPath = getTechnicalPlanOriginalPlanMarkdownPath(app);
  const originalOutlineRuntimePath = path.join(path.dirname(originalPlanMarkdownPath), originalOutlineRuntimeFileName);
  const workspaceDir = path.dirname(path.dirname(tenderMarkdownPath));
  const tenderOriginalLogger = createDeveloperLogger({
    app,
    config: configStore?.load?.() || {},
    moduleName: 'technical-plan',
    name: 'tender-original-files',
  });

  const workspaceTrashDir = getWorkspaceTrashDir(app);

  /**
   * 工作区内的强制删除统一带回收目录兜底:强杀外部占用进程;占用者属于本应用进程(如 Agent 在
   * Main 内的句柄)无法自杀时,登记延迟删除并放行,重启后补删,保证重置/导入不被阻断。
   * 投标模版等以“文件存在”判定状态的路径必须传 deferOnFailure: false,残留会被误认为有效数据。
   */
  function removeWorkspacePathSync(targetPath, onEvent, { deferOnFailure = true } = {}) {
    forceRemoveSync(targetPath, { trashDir: workspaceTrashDir, onEvent, deferOnFailure });
  }

  /** 已在受管原件目录中的文件直接复用，不再复制或重命名。 */
  function getManagedTenderOriginalRelativePath(filePath) {
    const resolvedPath = path.resolve(String(filePath || ''));
    if (filePathKey(path.dirname(resolvedPath)) !== filePathKey(tenderOriginalsDir)) return '';
    return path.relative(workspaceDir, resolvedPath).replace(/\\/g, '/');
  }
  function resolvePendingTenderMarkdownPath(filePath) {
    return path.resolve(resolveMarkdownPath(filePath));
  }

  function clearTechnicalPlanMermaidCache() {
    try {
      clearMermaidCache(app);
    } catch (error) {
      console.warn('[technical-plan] clear mermaid cache failed', error);
    }
  }

  function shouldClearMermaidCacheForPartial(partial) {
    if (!partial || typeof partial !== 'object') return false;
    if (hasOwn(partial, 'outlineData') && (!partial.outlineData || !partial.outlineData?.outline?.length)) {
      return true;
    }
    return hasOwn(partial, 'contentGenerationSections')
      && hasOwn(partial, 'contentGenerationPlans')
      && isEmptyObject(partial.contentGenerationSections)
      && isEmptyObject(partial.contentGenerationPlans);
  }

  function isPendingTenderMarkdownPath(filePath) {
    const resolvedPath = resolvePendingTenderMarkdownPath(filePath);
    const expectedDir = path.resolve(path.dirname(tenderMarkdownPath));
    return path.dirname(resolvedPath).toLowerCase() === expectedDir.toLowerCase()
      && /^tender-pending-\d+\.tmp\.md$/.test(path.basename(resolvedPath));
  }

  function clearPendingTenderMeta() {
    updateMeta({
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
    });
  }

  function cleanupOrphanPendingTenderFiles(activeMarkdownPath = '') {
    const targetDir = path.dirname(tenderMarkdownPath);
    if (!fs.existsSync(targetDir)) {
      return;
    }
    const activePath = activeMarkdownPath ? path.resolve(activeMarkdownPath).toLowerCase() : '';
    for (const fileName of fs.readdirSync(targetDir)) {
      if (!/^tender-pending-\d+\.tmp\.md$/.test(fileName)) {
        continue;
      }
      const filePath = path.join(targetDir, fileName);
      if (activePath && path.resolve(filePath).toLowerCase() === activePath) {
        continue;
      }
      try {
        const stats = fs.lstatSync(filePath);
        if (stats.isFile()) fs.rmSync(filePath, { force: true });
      } catch {
        // 清理孤儿临时文件失败不影响主流程
      }
    }
  }

  function removePendingTenderMarkdown(markdownPath) {
    const resolvedPath = markdownPath ? resolvePendingTenderMarkdownPath(markdownPath) : '';
    if (!resolvedPath || !isPendingTenderMarkdownPath(resolvedPath) || !fs.existsSync(resolvedPath)) {
      return;
    }
    try {
      const stats = fs.lstatSync(resolvedPath);
      if (stats.isFile()) fs.rmSync(resolvedPath, { force: true });
    } catch {
      // 清理临时文件失败不影响主流程
    }
  }

  function cleanupPendingTenderSelection() {
    const meta = ensureMetaRow();
    const pendingPath = meta.pending_tender_markdown_path || '';
    const markdownPath = pendingPath ? resolvePendingTenderMarkdownPath(pendingPath) : '';
    clearPendingTenderMeta();
    if (!markdownPath || !isPendingTenderMarkdownPath(markdownPath) || !fs.existsSync(markdownPath)) {
      cleanupOrphanPendingTenderFiles();
      return;
    }
    removePendingTenderMarkdown(markdownPath);
    cleanupOrphanPendingTenderFiles();
  }

  function cleanupLegacyPendingTenderState(meta = ensureMetaRow()) {
    const hasPendingMeta = Boolean(
      meta.pending_tender_markdown_path
      || meta.pending_tender_file_name
      || meta.pending_tender_sections_json
      || meta.pending_tender_created_at,
    );
    if (hasPendingMeta) {
      cleanupPendingTenderSelection();
      return true;
    }
    cleanupOrphanPendingTenderFiles();
    return false;
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_meta (id, step, created_at, updated_at)
      VALUES (1, 'document-analysis', @timestamp, @timestamp)
    `).run({ timestamp });
    return db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
  }

  function readMetaRow() {
    const meta = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (!meta) throw new Error('技术方案数据库尚未初始化');
    return meta;
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE technical_plan_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function ensureGenerationConfigRow() {
    const existing = db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    const defaults = createDefaultGenerationConfig();
    const content = defaults.contentGenerationOptions;
    db.prepare(`
      INSERT INTO technical_plan_generation_config (
        id, bid_analysis_mode, bid_section_mode, outline_mode, outline_expansion_mode,
        minimum_words, maximum_words, section_words, global_facts_mode, export_template_id, export_template_scope,
        use_ai_images, use_mermaid_images,
        use_html_images, html_image_types, table_requirement, image_quantity,
        created_at, updated_at
      ) VALUES (
        1, @bid_analysis_mode, @bid_section_mode, @outline_mode, @outline_expansion_mode,
        @minimum_words, @maximum_words, @section_words, @global_facts_mode, @export_template_id, @export_template_scope,
        @use_ai_images, @use_mermaid_images,
        @use_html_images, @html_image_types, @table_requirement, @image_quantity,
        @created_at, @updated_at
      )
    `).run({
      bid_analysis_mode: defaults.bidAnalysisMode,
      bid_section_mode: defaults.bidSectionMode,
      outline_mode: defaults.outlineMode,
      outline_expansion_mode: defaults.outlineExpansionMode,
      minimum_words: defaults.outlineWordControlOptions.minimumWords,
      maximum_words: defaults.outlineWordControlOptions.maximumWords,
      section_words: defaults.outlineWordControlOptions.sectionWords,
      global_facts_mode: defaults.globalFactsMode,
      export_template_id: defaults.exportTemplateId,
      export_template_scope: defaults.exportTemplateScope,
      use_ai_images: toDbBool(content.useAiImages),
      use_mermaid_images: toDbBool(content.useMermaidImages),
      use_html_images: toDbBool(content.useHtmlImages),
      html_image_types: content.htmlImageTypes,
      table_requirement: content.tableRequirement,
      image_quantity: content.imageQuantity,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get();
  }

  function loadGenerationBidTaskIds() {
    return db.prepare('SELECT task_id FROM technical_plan_generation_bid_tasks ORDER BY sort_order ASC').all().map((row) => row.task_id);
  }

  function loadGenerationReferenceDocumentIds() {
    return db.prepare('SELECT document_id FROM technical_plan_generation_reference_docs ORDER BY sort_order ASC').all().map((row) => row.document_id);
  }

  function replaceGenerationList(tableName, columnName, values) {
    db.prepare(`DELETE FROM ${tableName}`).run();
    const insert = db.prepare(`INSERT INTO ${tableName} (${columnName}, sort_order) VALUES (@value, @sort_order)`);
    normalizeGenerationDocumentIds(values).forEach((value, index) => insert.run({ value, sort_order: index }));
  }

  // 读取并规范化当前项目全部生成配置。
  function loadGenerationConfig() {
    const row = ensureGenerationConfigRow();
    return normalizeGenerationConfig({
      bidAnalysisMode: row.bid_analysis_mode,
      bidAnalysisSelectedTaskIds: loadGenerationBidTaskIds(),
      bidSectionMode: row.bid_section_mode,
      outlineMode: row.outline_mode,
      outlineExpansionMode: row.outline_expansion_mode,
      outlineWordControlOptions: {
        minimumWords: row.minimum_words,
        maximumWords: row.maximum_words,
        sectionWords: row.section_words,
      },
      referenceKnowledgeDocumentIds: loadGenerationReferenceDocumentIds(),
      globalFactsMode: row.global_facts_mode,
      exportTemplateId: row.export_template_id,
      exportTemplateScope: row.export_template_scope,
      contentGenerationOptions: {
        useAiImages: fromDbBool(row.use_ai_images),
        useMermaidImages: fromDbBool(row.use_mermaid_images),
        useHtmlImages: fromDbBool(row.use_html_images),
        htmlImageTypes: row.html_image_types,
        tableRequirement: row.table_requirement,
        imageQuantity: row.image_quantity,
      },
    });
  }

  function writeGenerationConfig(config) {
    ensureGenerationConfigRow();
    const normalized = normalizeGenerationConfig(config);
    const wordControl = normalized.outlineWordControlOptions;
    const content = normalized.contentGenerationOptions;
    db.prepare(`
      UPDATE technical_plan_generation_config SET
        bid_analysis_mode = @bid_analysis_mode,
        bid_section_mode = @bid_section_mode,
        outline_mode = @outline_mode,
        outline_expansion_mode = @outline_expansion_mode,
        minimum_words = @minimum_words,
        maximum_words = @maximum_words,
        section_words = @section_words,
        global_facts_mode = @global_facts_mode,
        export_template_id = @export_template_id,
        export_template_scope = @export_template_scope,
        use_ai_images = @use_ai_images,
        use_mermaid_images = @use_mermaid_images,
        use_html_images = @use_html_images,
        html_image_types = @html_image_types,
        table_requirement = @table_requirement,
        image_quantity = @image_quantity,
        updated_at = @updated_at
      WHERE id = 1
    `).run({
      bid_analysis_mode: normalized.bidAnalysisMode,
      bid_section_mode: normalized.bidSectionMode,
      outline_mode: normalized.outlineMode,
      outline_expansion_mode: normalized.outlineExpansionMode,
      minimum_words: wordControl.minimumWords,
      maximum_words: wordControl.maximumWords,
      section_words: wordControl.sectionWords,
      global_facts_mode: normalized.globalFactsMode,
      export_template_id: normalized.exportTemplateId,
      export_template_scope: normalized.exportTemplateScope,
      use_ai_images: toDbBool(content.useAiImages),
      use_mermaid_images: toDbBool(content.useMermaidImages),
      use_html_images: toDbBool(content.useHtmlImages),
      html_image_types: content.htmlImageTypes,
      table_requirement: content.tableRequirement,
      image_quantity: content.imageQuantity,
      updated_at: now(),
    });
    replaceGenerationList('technical_plan_generation_bid_tasks', 'task_id', normalized.bidAnalysisSelectedTaskIds);
    replaceGenerationList('technical_plan_generation_reference_docs', 'document_id', normalized.referenceKnowledgeDocumentIds);
    return normalized;
  }

  function updateGenerationConfig(partial = {}) {
    const current = loadGenerationConfig();
    const merged = { ...current };
    for (const key of Object.keys(current)) {
      if (hasOwn(partial, key)) merged[key] = partial[key];
    }
    return writeGenerationConfig(merged);
  }

  function resolveMarkdownPath(relativeOrAbsolutePath) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return tenderMarkdownPath;
    return path.isAbsolute(value) ? value : path.join(path.dirname(path.dirname(tenderMarkdownPath)), value);
  }

  function readTenderMarkdown() {
    const meta = readMetaRow();
    const filePath = resolveMarkdownPath(meta.tender_markdown_path || tenderMarkdownRelativePath);
    if (!meta.tender_markdown_path || !fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  // 读取独立保存的小节 Word；缺失与读取失败分别交给展示页处理。
  async function readContentWord(sectionId) {
    const filePath = path.join(getTechnicalPlanDir(app), `${encodeURIComponent(sectionId)}.docx`);
    try {
      return await fs.promises.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function loadTenderSourceFiles(meta = readMetaRow()) {
    const sourceFiles = safeJsonParse(meta.tender_files_json, []);
    if (Array.isArray(sourceFiles) && sourceFiles.length) {
      return sourceFiles.map((file) => ({
        id: String(file.id || ''),
        fileName: String(file.fileName || '招标文件'),
        markdownPath: String(file.markdownPath || ''),
        markdownChars: Number(file.markdownChars || 0),
        contentHash: String(file.contentHash || ''),
        parserLabel: file.parserLabel ? String(file.parserLabel) : undefined,
        sourceDocxPath: file.sourceDocxPath ? String(file.sourceDocxPath) : undefined,
        importedAt: file.importedAt ? String(file.importedAt) : undefined,
        updatedAt: file.updatedAt ? String(file.updatedAt) : meta.updated_at,
      })).filter((file) => file.id && file.markdownPath);
    }
    if (meta.tender_markdown_path) {
      return [{
        id: 'tender-legacy-01',
        fileName: meta.tender_file_name || '技术方案招标文件',
        markdownPath: meta.tender_markdown_path,
        markdownChars: Number(meta.tender_markdown_chars || 0),
        contentHash: meta.tender_markdown_hash || '',
        parserLabel: meta.tender_parser_label || undefined,
        importedAt: meta.tender_imported_at || undefined,
        updatedAt: meta.updated_at,
      }];
    }
    return [];
  }

  function readTenderSourceMarkdown(sourceId) {
    const target = loadTenderSourceFiles().find((file) => file.id === String(sourceId || ''));
    if (!target) return '';
    const filePath = resolveMarkdownPath(target.markdownPath);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  function readOriginalTenderMarkdown() {
    const meta = readMetaRow();
    if (!meta.tender_markdown_path) {
      return '';
    }
    const originalPath = meta.tender_original_markdown_path
      ? resolveMarkdownPath(meta.tender_original_markdown_path)
      : null;
    if (originalPath && fs.existsSync(originalPath)) {
      return fs.readFileSync(originalPath, 'utf-8');
    }
    throw new Error('原始招标文件缺失，请重新上传招标文件');
  }

  function writeMarkdownFile(targetPath, markdown, prefix) {
    const targetDir = path.dirname(targetPath);
    const tempPath = path.join(targetDir, `${prefix}-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${String(markdown || '').trim()}\n`, 'utf-8');
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function checkBidSections() {
    const markdown = readOriginalTenderMarkdown();
    return detectBidSections(markdown);
  }

  function readOriginalPlanMarkdown() {
    const meta = readMetaRow();
    const filePath = resolveMarkdownPath(meta.original_plan_markdown_path || originalPlanMarkdownRelativePath);
    if (!meta.original_plan_markdown_path || !fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  function writeTenderSourceMarkdown(source, index) {
    const markdown = String(source?.file_content || '').trim();
    const fileName = source?.file_name || '招标文件';
    const id = createTenderSourceId(fileName, markdown, index);
    const relativePath = path.join(tenderSourceFilesDirRelativePath, `${id}-${safeFileNamePart(fileName)}.md`).replace(/\\/g, '/');
    const targetPath = resolveMarkdownPath(relativePath);
    writeMarkdownFile(targetPath, markdown, id);
    const sourceDocxPath = persistExistingTenderOriginal(source, id);
    return {
      id,
      fileName,
      markdownPath: relativePath,
      markdownChars: markdown.length,
      contentHash: stableHash(markdown),
      parserLabel: source?.parser_label || undefined,
      sourceDocxPath: sourceDocxPath || undefined,
      importedAt: now(),
      updatedAt: now(),
    };
  }

  /** 把已有或刚落下的招标 Word 原件归到当前源文件编号下。 */
  function persistExistingTenderOriginal(source, id) {
    const destRelative = path.join(tenderOriginalsDirRelativePath, `${id}.docx`).replace(/\\/g, '/');
    const destPath = resolveMarkdownPath(destRelative);
    const incoming = String(source?.source_docx_path || source?.sourceDocxPath || '').trim();
    if (!incoming) return '';
    const sourcePath = path.isAbsolute(incoming) ? incoming : resolveMarkdownPath(incoming);
    if (!fs.existsSync(sourcePath)) return '';
    const managedRelativePath = getManagedTenderOriginalRelativePath(sourcePath);
    if (managedRelativePath) return managedRelativePath;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (filePathKey(sourcePath) !== filePathKey(destPath)) {
      tenderOriginalLogger.write('tender-original.copy.started', { phase: 'state-rebuild', source_path: sourcePath, dest_path: destPath });
      try {
        fs.copyFileSync(sourcePath, destPath);
        tenderOriginalLogger.write('tender-original.copy.completed', { phase: 'state-rebuild', source_path: sourcePath, dest_path: destPath });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.copy.failed', {
          phase: 'state-rebuild',
          source_path: sourcePath,
          dest_path: destPath,
          code: error?.code,
          syscall: error?.syscall,
          error: compactLogError(error),
        });
        throw error;
      }
    }
    return destRelative;
  }

  function pruneTenderOriginals(keptRelativePaths, phase = 'state-rebuild') {
    const keep = new Set((Array.isArray(keptRelativePaths) ? keptRelativePaths : []).map((item) => filePathKey(resolveMarkdownPath(item))));
    if (!fs.existsSync(tenderOriginalsDir)) return;
    for (const name of fs.readdirSync(tenderOriginalsDir)) {
      const filePath = path.join(tenderOriginalsDir, name);
      if (!keep.has(filePathKey(filePath))) {
        tenderOriginalLogger.write('tender-original.delete.started', { phase, file_path: filePath });
        try {
          removeWorkspacePathSync(filePath, (event, payload) => tenderOriginalLogger.write(event, { phase, ...payload }));
          tenderOriginalLogger.write('tender-original.delete.completed', { phase, file_path: filePath });
        } catch (error) {
          tenderOriginalLogger.write('tender-original.delete.failed', {
            phase,
            file_path: filePath,
            code: error?.code,
            syscall: error?.syscall,
            error: compactLogError(error),
          });
          const fileName = path.basename(filePath);
          const message = isFileLockError(error)
            ? `无法删除旧招标 Word 原件“${fileName}”，请关闭可能占用该文件的 Word/WPS，并确认文件可写后重试`
            : `无法清理旧招标 Word 原件“${fileName}”：${error?.message || error}`;
          const cleanupError = new Error(message);
          cleanupError.code = 'TENDER_ORIGINAL_CLEANUP_FAILED';
          cleanupError.cause = error;
          throw cleanupError;
        }
      }
    }
  }

  function clearBidTemplate() {
    const sourcePathParts = path.parse(bidTemplateSourcePath);
    const templateFiles = [
      bidTemplatePath,
      bidTemplateSourcePath,
      path.join(sourcePathParts.dir, `${sourcePathParts.name}.chapters.json`),
      bidTemplateFieldsPath,
    ];
    const templateDir = path.dirname(bidTemplatePath);
    if (fs.existsSync(templateDir)) {
      const tempPrefixes = [
        `${path.basename(bidTemplatePath)}.`,
        `${path.basename(bidTemplateFieldsPath)}.`,
      ];
      for (const name of fs.readdirSync(templateDir)) {
        if (tempPrefixes.some((prefix) => name.startsWith(prefix) && name.includes('.tmp'))) {
          templateFiles.push(path.join(templateDir, name));
        }
      }
    }
    for (const filePath of templateFiles) {
      if (!fs.existsSync(filePath)) continue;
      try {
        removeWorkspacePathSync(
          filePath,
          (event, payload) => tenderOriginalLogger.write(event, { phase: 'bid-template-cleanup', ...payload }),
          { deferOnFailure: false },
        );
      } catch (error) {
        if (isFileLockError(error)) {
          const lockError = new Error('投标模版正在被 Word 使用，请关闭后重试');
          lockError.code = 'BID_TEMPLATE_IN_USE';
          lockError.cause = error;
          throw lockError;
        }
        throw error;
      }
    }
  }

  function clearTenderSourceFiles(phase = 'technical-plan-reset') {
    clearBidTemplate();
    if (fs.existsSync(tenderOriginalsDir)) {
      tenderOriginalLogger.write('tender-original.delete-directory.started', { phase, directory_path: tenderOriginalsDir });
      try {
        removeWorkspacePathSync(tenderOriginalsDir, (event, payload) => tenderOriginalLogger.write(event, { phase, ...payload }));
        tenderOriginalLogger.write('tender-original.delete-directory.completed', { phase, directory_path: tenderOriginalsDir });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.delete-directory.failed', {
          phase,
          directory_path: tenderOriginalsDir,
          code: error?.code,
          syscall: error?.syscall,
          path: error?.path,
          error: compactLogError(error),
        });
        const resetError = new Error('无法清理招标 Word 原件，请关闭可能占用原件的 Word/WPS，并确认文件可写后重试');
        resetError.code = 'TENDER_ORIGINAL_CLEANUP_FAILED';
        resetError.cause = error;
        throw resetError;
      }
    }
    if (fs.existsSync(tenderSourceFilesDir)) {
      removeWorkspacePathSync(tenderSourceFilesDir);
    }
  }

  function clearOriginalOutlineRuntime() {
    if (!fs.existsSync(originalOutlineRuntimePath)) {
      return;
    }
    fs.rmSync(originalOutlineRuntimePath, { force: true });
  }

  function readOriginalOutlineRuntime() {
    if (!fs.existsSync(originalOutlineRuntimePath)) {
      return null;
    }
    try {
      const runtime = safeJsonParse(fs.readFileSync(originalOutlineRuntimePath, 'utf-8'), null);
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
        clearOriginalOutlineRuntime();
        return null;
      }
      return runtime;
    } catch {
      clearOriginalOutlineRuntime();
      return null;
    }
  }

  function saveOriginalOutlineRuntime(runtime) {
    const targetDir = path.dirname(originalOutlineRuntimePath);
    const tempPath = path.join(targetDir, `original-outline-runtime-${Date.now()}.tmp.json`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(runtime || {}, null, 2)}\n`, 'utf-8');
    try {
      fs.renameSync(tempPath, originalOutlineRuntimePath);
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'pausing', 'paused', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: taskLogStore.list('technical-plan', row.type, row.task_id),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
      stats: safeJsonParse(row.stats_json, undefined),
      pause_requested: fromDbBool(row.pause_requested),
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM technical_plan_tasks WHERE type = ?').run(type);
      if (type === 'bid-section-extraction') {
        updateMeta({ bid_section_extraction_status: 'idle', bid_section_extraction_error: null });
      }
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_tasks (type, task_id, status, progress, stats_json, error, pause_requested, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @stats_json, @error, @pause_requested, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        stats_json = excluded.stats_json,
        error = excluded.error,
        pause_requested = excluded.pause_requested,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      pause_requested: toDbBool(task.pause_requested),
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
    taskLogStore.sync('technical-plan', type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
    if (type === 'bid-section-extraction') {
      updateMeta({
        bid_section_extraction_status: normalizeBidSectionExtractionStatus(task.status),
        bid_section_extraction_error: task.error ? String(task.error) : null,
      });
    }
  }

  function loadTasks() {
    const rows = db.prepare('SELECT * FROM technical_plan_tasks').all();
    const tasks = {};
    for (const row of rows) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  function loadTask(type) {
    return taskFromRow(db.prepare('SELECT * FROM technical_plan_tasks WHERE type = ?').get(type));
  }

  function loadBidItems() {
    const rows = db.prepare('SELECT * FROM technical_plan_bid_items ORDER BY sort_order ASC, item_id ASC').all();
    return rows.reduce((acc, row) => {
      acc[row.item_id] = {
        id: row.item_id,
        label: row.label,
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
      };
      return acc;
    }, {});
  }

  function getBidItemSortOrder(itemId) {
    const fullTasks = getAllBidAnalysisTasks();
    const index = fullTasks.findIndex((task) => task.id === itemId);
    return index >= 0 ? index : 9999;
  }

  function getBidItemLabel(itemId, fallbackLabel) {
    const task = getBidAnalysisTasks('full').find((item) => item.id === itemId) || getBidAnalysisTasks('key').find((item) => item.id === itemId);
    return fallbackLabel || task?.label || itemId;
  }

  function saveBidItems(tasks, mode) {
    const entries = Object.entries(tasks || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      return;
    }

    const upsert = db.prepare(`
      INSERT INTO technical_plan_bid_items (item_id, label, status, content, error, sort_order, updated_at)
      VALUES (@item_id, @label, @status, @content, @error, @sort_order, @updated_at)
      ON CONFLICT(item_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        content = excluded.content,
        error = excluded.error,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const [itemId, task] of entries) {
      upsert.run({
        item_id: itemId,
        label: getBidItemLabel(itemId, task?.label),
        status: normalizeStatus(task?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: String(task?.content || ''),
        error: task?.error ? String(task.error) : null,
        sort_order: getBidItemSortOrder(itemId, mode),
        updated_at: task?.updated_at || timestamp,
      });
    }
  }

  function saveBidItem(item, mode) {
    const itemId = String(item?.id || '').trim();
    if (!itemId) return;
    saveBidItems({ [itemId]: item }, mode);
  }

  function upsertDerivedBidItem(itemId, content, mode) {
    const label = getBidItemLabel(itemId);
    const value = String(content || '');
    db.prepare(`
      INSERT INTO technical_plan_bid_items (item_id, label, status, content, error, sort_order, updated_at)
      VALUES (@item_id, @label, @status, @content, NULL, @sort_order, @updated_at)
      ON CONFLICT(item_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        content = excluded.content,
        error = NULL,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run({
      item_id: itemId,
      label,
      status: value.trim() ? 'success' : 'idle',
      content: value,
      sort_order: getBidItemSortOrder(itemId, mode),
      updated_at: now(),
    });
  }

  function calculateBidProgress(mode, bidTasks, selectedTaskIds) {
    const selectedIds = getBidAnalysisTaskIdsForConfig(mode, selectedTaskIds);
    if (!selectedIds.length) return 0;
    const done = selectedIds.filter((taskId) => ['success', 'error'].includes(bidTasks[taskId]?.status)).length;
    return Math.round((done / selectedIds.length) * 100);
  }

  function loadOutlineData(meta) {
    const rows = db.prepare('SELECT * FROM technical_plan_outline_nodes ORDER BY level ASC, parent_node_id ASC, sort_order ASC').all();
    if (!rows.length) return null;

    const map = new Map();
    for (const row of rows) {
      map.set(row.node_id, {
        id: row.node_id,
        title: row.title,
        description: row.description || '',
        content_mode: row.content_mode || undefined,
        content_mode_note: row.content_mode_note || undefined,
        source_requirement_id: row.source_requirement_id || undefined,
        source_requirement_title: row.source_requirement_title || undefined,
        knowledge_item_ids: safeJsonParse(row.knowledge_item_ids_json, undefined),
        content: row.content || '',
        children: [],
      });
    }

    const roots = [];
    for (const row of rows) {
      const item = map.get(row.node_id);
      if (!item) continue;
      if (row.parent_node_id && map.has(row.parent_node_id)) {
        map.get(row.parent_node_id).children.push(item);
      } else {
        roots.push(item);
      }
    }

    function cleanup(item) {
      if (!item.children.length) {
        delete item.children;
      } else {
        item.children.forEach(cleanup);
      }
      if (!item.knowledge_item_ids?.length) delete item.knowledge_item_ids;
      if (!item.content) delete item.content;
      return item;
    }

    return {
      outline: numberOutline(roots.map(cleanup)),
      project_name: meta.outline_project_name || undefined,
      project_overview: meta.outline_project_overview || undefined,
    };
  }

  function saveOutlineData(outlineData) {
    if (!outlineData?.outline?.length) {
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      updateMeta({ outline_project_name: null, outline_project_overview: null });
      return;
    }

    const rows = flattenOutlineItems(outlineData.outline);
    const nextIds = new Set(rows.map((row) => row.node_id));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_outline_nodes (
        node_id, parent_node_id, sort_order, level, title, description, content_mode, content_mode_note, source_requirement_id,
        source_requirement_title, knowledge_item_ids_json, content, created_at, updated_at
      ) VALUES (
        @node_id, @parent_node_id, @sort_order, @level, @title, @description, @content_mode, @content_mode_note, @source_requirement_id,
        @source_requirement_title, @knowledge_item_ids_json, @content, @created_at, @updated_at
      ) ON CONFLICT(node_id) DO UPDATE SET
        parent_node_id = excluded.parent_node_id,
        sort_order = excluded.sort_order,
        level = excluded.level,
        title = excluded.title,
        description = excluded.description,
        content_mode = excluded.content_mode,
        content_mode_note = excluded.content_mode_note,
        source_requirement_id = excluded.source_requirement_id,
        source_requirement_title = excluded.source_requirement_title,
        knowledge_item_ids_json = excluded.knowledge_item_ids_json,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const row of rows) {
      upsert.run({ ...row, created_at: timestamp, updated_at: timestamp });
    }

    const existingIds = db.prepare('SELECT node_id FROM technical_plan_outline_nodes').all().map((row) => row.node_id);
    const deleteNode = db.prepare('DELETE FROM technical_plan_outline_nodes WHERE node_id = ?');
    for (const nodeId of existingIds) {
      if (!nextIds.has(nodeId)) deleteNode.run(nodeId);
    }

    updateMeta({
      outline_project_name: outlineData.project_name || null,
      outline_project_overview: outlineData.project_overview || null,
    });
  }

  function loadContentSections(outlineData) {
    const rows = db.prepare(`
      SELECT s.node_id, s.status, s.error, s.updated_at, n.title, n.content
      FROM technical_plan_content_sections s
      JOIN technical_plan_outline_nodes n ON n.node_id = s.node_id
    `).all();
    const sections = rows.reduce((acc, row) => {
      acc[row.node_id] = {
        id: row.node_id,
        title: row.title || '未命名章节',
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
        updated_at: row.updated_at || undefined,
      };
      return acc;
    }, {});

    for (const item of collectLeafItems(outlineData?.outline || [])) {
      if (!sections[item.id] && item.content?.trim()) {
        sections[item.id] = {
          id: item.id,
          title: item.title || '未命名章节',
          status: 'success',
          content: item.content,
        };
      }
    }

    return sections;
  }

  function saveContentSections(sections) {
    const entries = Object.entries(sections || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_sections').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES (@node_id, @status, @error, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);
    const updateContent = db.prepare('UPDATE technical_plan_outline_nodes SET content = @content, updated_at = @updated_at WHERE node_id = @node_id');
    const timestamp = now();
    for (const [nodeId, section] of entries) {
      upsert.run({
        node_id: nodeId,
        status: normalizeStatus(section?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: section?.error ? String(section.error) : null,
        updated_at: section?.updated_at || timestamp,
      });
      if (hasOwn(section, 'content')) {
        updateContent.run({ node_id: nodeId, content: String(section.content || ''), updated_at: timestamp });
      }
    }

    const deleteSection = db.prepare('DELETE FROM technical_plan_content_sections WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_sections').all()) {
      if (!nextIds.has(row.node_id)) deleteSection.run(row.node_id);
    }
  }

  function loadContentPlans() {
    return db.prepare('SELECT * FROM technical_plan_content_plans').all().reduce((acc, row) => {
      const storedPlan = safeJsonParse(row.plan_json, null);
      if (storedPlan?.plan && Number(storedPlan.plan_version) > 0) {
        acc[row.node_id] = {
          plan_version: Number(storedPlan.plan_version),
          plan: storedPlan.plan,
          ...(storedPlan.table_requirement ? { table_requirement: storedPlan.table_requirement } : {}),
          updated_at: row.updated_at || undefined,
        };
      }
      return acc;
    }, {});
  }

  function normalizeGlobalFactGroups(groups) {
    const seen = new Set();
    return (Array.isArray(groups) ? groups : []).map((group, index) => {
      const title = String(group?.title || '').trim();
      const content = String(group?.content || '').trim();
      if (!title || !content) return null;
      let id = normalizeGlobalFactId(group?.id || group?.group_id || title, index);
      let suffix = 2;
      while (seen.has(id)) {
        id = `${id}_${suffix}`;
        suffix += 1;
      }
      seen.add(id);
      return {
        id,
        title,
        content,
        updated_at: group?.updated_at || group?.updatedAt || now(),
      };
    }).filter(Boolean);
  }

  function loadGlobalFacts() {
    return db.prepare('SELECT * FROM technical_plan_global_fact_groups ORDER BY sort_order ASC, group_id ASC').all().map((row) => ({
      id: row.group_id,
      title: row.title,
      content: row.content || '',
      updated_at: row.updated_at || undefined,
    }));
  }

  function replaceGlobalFacts(groups) {
    const normalized = normalizeGlobalFactGroups(groups);
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    if (!normalized.length) return;

    const insert = db.prepare(`
      INSERT INTO technical_plan_global_fact_groups (group_id, title, content, sort_order, created_at, updated_at)
      VALUES (@group_id, @title, @content, @sort_order, @created_at, @updated_at)
    `);
    const timestamp = now();
    normalized.forEach((group, index) => insert.run({
      group_id: group.id,
      title: group.title,
      content: group.content,
      sort_order: index,
      created_at: timestamp,
      updated_at: group.updated_at || timestamp,
    }));
  }

  function saveContentPlans(plans) {
    const entries = Object.entries(plans || {}).filter(([, value]) => value?.plan && Number(value.plan_version) > 0);
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_plans').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, updated_at)
      VALUES (@node_id, @plan_json, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        plan_json = excluded.plan_json,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const [nodeId, value] of entries) {
      if (!value?.plan) continue;
      upsert.run({
        node_id: nodeId,
        plan_json: JSON.stringify({
          plan_version: Number(value.plan_version),
          plan: value.plan,
          ...(value.table_requirement ? { table_requirement: value.table_requirement } : {}),
        }),
        updated_at: value.updated_at || timestamp,
      });
    }

    const deletePlan = db.prepare('DELETE FROM technical_plan_content_plans WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_plans').all()) {
      if (!nextIds.has(row.node_id)) deletePlan.run(row.node_id);
    }
  }

  const updateGeneratedContent = db.prepare('UPDATE technical_plan_outline_nodes SET content = ?, updated_at = ? WHERE node_id = ?');
  const upsertGeneratedSection = db.prepare(`
    INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
    VALUES (@node_id, @status, @error, @updated_at)
    ON CONFLICT(node_id) DO UPDATE SET
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);
  const upsertGeneratedPlan = db.prepare(`
    INSERT INTO technical_plan_content_plans (node_id, plan_json, updated_at)
    VALUES (@node_id, @plan_json, @updated_at)
    ON CONFLICT(node_id) DO UPDATE SET
      plan_json = excluded.plan_json,
      updated_at = excluded.updated_at
  `);
  function saveContentGenerationItemFields({ nodeId, section, storedPlan, runtime }) {
    const timestamp = now();
    if (section) {
      updateGeneratedContent.run(String(section.content || ''), timestamp, nodeId);
      upsertGeneratedSection.run({
        node_id: nodeId,
        status: normalizeStatus(section.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: section.error ? String(section.error) : null,
        updated_at: section.updated_at || timestamp,
      });
    }
    if (storedPlan) {
      upsertGeneratedPlan.run({
        node_id: nodeId,
        plan_json: JSON.stringify({
          plan_version: Number(storedPlan.plan_version),
          plan: storedPlan.plan,
          ...(storedPlan.table_requirement ? { table_requirement: storedPlan.table_requirement } : {}),
        }),
        updated_at: storedPlan.updated_at || timestamp,
      });
    }
    if (runtime !== undefined) {
      updateMeta({ content_generation_runtime_json: jsonOrNull(runtime) });
    }
  }

  function clearDownstreamFromTender(wordChanges) {
    stageContentWordRemoval(wordChanges);
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    writeGenerationConfig(createDefaultGenerationConfig());
    updateMeta({
      step: 'document-analysis',
      outline_word_control_snapshot_json: null,
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_runtime_json: null,
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
      bid_sections_json: null,
      bid_section_extraction_status: 'idle',
      bid_section_extraction_error: null,
      selected_section_id: null,
      selected_section_title: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearDownstreamFromBidSectionChange(wordChanges) {
    stageContentWordRemoval(wordChanges);
    clearBidTemplate();
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    updateGenerationConfig({
      referenceKnowledgeDocumentIds: [],
      contentGenerationOptions: createDefaultGenerationConfig().contentGenerationOptions,
    });
    updateMeta({
      step: 'bid-analysis',
      content_generation_runtime_json: null,
      outline_word_control_snapshot_json: null,
      outline_project_name: null,
      outline_project_overview: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearContentGenerationState(wordChanges) {
    stageContentWordRemoval(wordChanges);
    agentService.deletePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY);
    agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
    agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
    db.prepare("UPDATE technical_plan_outline_nodes SET content = '', updated_at = ?").run(now());
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'content-generation'").run();
    clearTechnicalPlanMermaidCache();
    updateMeta({ content_generation_runtime_json: null });
  }

  // 正文任务活动或暂停期间禁止手工保存，避免清空待恢复的图片计划。
  function assertContentEditingAllowed() {
    const row = db.prepare("SELECT status FROM technical_plan_tasks WHERE type = 'content-generation' AND status IN ('running', 'pausing', 'paused') LIMIT 1").get();
    if (row) {
      throw new Error('当前正文生成任务正在运行或已暂停，请先完成任务再编辑正文');
    }
  }

  function loadOutlinePersistenceSnapshot() {
    return {
      nodes: db.prepare('SELECT node_id, parent_node_id, content FROM technical_plan_outline_nodes').all().reduce((acc, row) => {
        acc[row.node_id] = { content: row.content || '', parentId: row.parent_node_id };
        return acc;
      }, {}),
      sections: db.prepare('SELECT node_id, status, error, updated_at FROM technical_plan_content_sections').all(),
      plans: db.prepare('SELECT node_id, plan_json, updated_at FROM technical_plan_content_plans').all(),
    };
  }

  function assertOutlineMutationAllowed() {
    const task = db.prepare("SELECT status FROM technical_plan_tasks WHERE type = 'content-generation'").get();
    if (['running', 'pausing', 'paused'].includes(task?.status)) {
      throw new Error('正文生成任务正在运行或暂停中，请结束后再调整目录');
    }
  }

  function shouldClearSavedNode({ clearAll, id, affectedIds }) {
    return clearAll || affectedIds.has(id);
  }

  function buildOutlineWithPersistedContent(outlineData, { snapshot, affectedIds, clearAll }) {
    if (!outlineData?.outline?.length) return outlineData;
    return {
      ...outlineData,
      outline: mapOutlineItems(outlineData.outline, (item) => {
        const id = item.id;
        const clearContent = shouldClearSavedNode({ clearAll, id, affectedIds });
        const oldContent = snapshot.nodes[id]?.content;
        return {
          ...item,
          content: clearContent ? '' : String(oldContent ?? item?.content ?? ''),
        };
      }),
    };
  }

  function restoreRetainedContentRows({ snapshot, affectedIds, nextIds, clearAll }) {
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();

    if (clearAll || !nextIds.size) return;

    const insertSection = db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES (@node_id, @status, @error, @updated_at)
    `);
    const seenSections = new Set();
    for (const row of snapshot.sections) {
      const id = row.node_id;
      if (!id || !nextIds.has(id) || seenSections.has(id)) continue;
      if (shouldClearSavedNode({ clearAll, id, affectedIds })) continue;
      seenSections.add(id);
      insertSection.run({
        node_id: id,
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: row.error || null,
        updated_at: row.updated_at || now(),
      });
    }

    const insertPlan = db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, updated_at)
      VALUES (@node_id, @plan_json, @updated_at)
    `);
    const seenPlans = new Set();
    for (const row of snapshot.plans) {
      const id = row.node_id;
      if (!id || !nextIds.has(id) || seenPlans.has(id)) continue;
      if (shouldClearSavedNode({ clearAll, id, affectedIds })) continue;
      if (!row.plan_json) continue;
      seenPlans.add(id);
      insertPlan.run({
        node_id: id,
        plan_json: row.plan_json,
        updated_at: row.updated_at || now(),
      });
    }
  }

  // 将正文文件移动与数据库修改放在同一业务操作中，提交失败时逆序恢复文件。
  function createContentWordTransaction(callback) {
    const transaction = db.transaction(callback);
    return (...args) => {
      const changes = { moves: [], removed: [] };
      let result;
      try {
        result = transaction(changes, ...args);
      } catch (error) {
        const restoreErrors = [];
        for (const [source, target] of changes.moves.reverse()) {
          try {
            if (fs.existsSync(source)) throw new Error(`恢复正文文件时原位置被占用：${source}`);
            fs.renameSync(target, source);
          } catch (restoreError) {
            restoreErrors.push(restoreError);
          }
        }
        if (restoreErrors.length) throw new AggregateError([error, ...restoreErrors], '正文变更失败，部分正文文件未能恢复，请保留目录中的临时文件。');
        throw error;
      }
      // 到此数据库已提交，暂存文件已失效且不能再按小节 ID 读取。
      for (const temporary of changes.removed) fs.unlinkSync(temporary);
      return result;
    };
  }

  // 先移出正式文件名；复用事务的回滚和提交后清理，HTML 与 Word 一致失效。
  function stageContentFileRemoval(changes, source) {
    if (!fs.existsSync(source)) return;
    const temporary = path.join(path.dirname(source), `__content_word_${crypto.randomUUID()}.tmp`);
    fs.renameSync(source, temporary);
    changes.moves.push([source, temporary]);
    changes.removed.push(temporary);
  }

  // 只暂存小节 Word，绝不按 *.docx 清空业务目录中的投标模板或原件。
  function stageContentWordRemoval(changes, sectionIds) {
    const directory = getTechnicalPlanDir(app);
    let files;
    if (sectionIds) {
      files = [...sectionIds].map(id => `${encodeURIComponent(id)}.docx`);
    } else {
      files = db.prepare('SELECT node_id FROM technical_plan_outline_nodes').all()
        .map(row => `${encodeURIComponent(row.node_id)}.docx`);
    }
    for (const file of files) {
      stageContentFileRemoval(changes, path.join(directory, file));
    }
  }

  // 与目录正文使用同一失效范围，稳定 ID 无需给有效文件换名。
  function reconcileContentWords(changes, { snapshot, affectedIds, nextIds, clearAll }) {
    if (clearAll) {
      stageContentWordRemoval(changes);
      return;
    }
    // 被删节点的文件允许留存；仍在目录中的身份变化节点才需要清空。
    const removed = Object.keys(snapshot.nodes).filter(id => nextIds.has(id) && affectedIds.has(id));
    stageContentWordRemoval(changes, removed);
    if (removed.length) {
      const workspaceDir = agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY)?.paths.workspaceDir;
      if (workspaceDir) {
        for (const id of removed) stageContentFileRemoval(changes, path.join(workspaceDir, '正文', `${encodeURIComponent(id)}.html`));
      }
    }
  }

  // 排序只更新位置，不修改节点身份、正文及任务中的引用。
  function saveSortedOutline(outlineData) {
    const updateNode = db.prepare(`
      UPDATE technical_plan_outline_nodes
      SET parent_node_id = @parent_node_id, sort_order = @sort_order, level = @level, updated_at = @updated_at
      WHERE node_id = @node_id
    `);
    const timestamp = now();
    flattenOutlineItems(outlineData.outline).forEach(row => updateNode.run({ ...row, updated_at: timestamp }));
    updateMeta({
      outline_project_name: outlineData.project_name || null,
      outline_project_overview: outlineData.project_overview || null,
    });
  }

  function applyPartial(partial, wordChanges) {
    ensureMetaRow();
    const metaUpdates = {};
    const generationConfigPatch = {};
    const invalidatesContentGeneration = partial.invalidateContentGeneration === true;

    if (hasOwn(partial, 'step') && isValidStep(partial.step)) metaUpdates.step = partial.step;
    if (hasOwn(partial, 'bidAnalysisMode')) generationConfigPatch.bidAnalysisMode = partial.bidAnalysisMode;
    if (hasOwn(partial, 'bidAnalysisSelectedTaskIds')) generationConfigPatch.bidAnalysisSelectedTaskIds = partial.bidAnalysisSelectedTaskIds;
    if (hasOwn(partial, 'bidSectionMode')) generationConfigPatch.bidSectionMode = partial.bidSectionMode;
    if (hasOwn(partial, 'bidSections')) metaUpdates.bid_sections_json = jsonOrNull(normalizeBidSections(partial.bidSections));
    if (hasOwn(partial, 'bidSectionExtractionStatus')) metaUpdates.bid_section_extraction_status = normalizeBidSectionExtractionStatus(partial.bidSectionExtractionStatus);
    if (hasOwn(partial, 'bidSectionExtractionError')) metaUpdates.bid_section_extraction_error = partial.bidSectionExtractionError ? String(partial.bidSectionExtractionError) : null;
    if (hasOwn(partial, 'outlineMode')) generationConfigPatch.outlineMode = partial.outlineMode;
    if (hasOwn(partial, 'outlineExpansionMode')) generationConfigPatch.outlineExpansionMode = partial.outlineExpansionMode;
    if (hasOwn(partial, 'globalFactsMode')) generationConfigPatch.globalFactsMode = partial.globalFactsMode;
    if (hasOwn(partial, 'outlineWordControlOptions')) generationConfigPatch.outlineWordControlOptions = partial.outlineWordControlOptions;
    if (hasOwn(partial, 'referenceKnowledgeDocumentIds')) generationConfigPatch.referenceKnowledgeDocumentIds = partial.referenceKnowledgeDocumentIds;
    if (hasOwn(partial, 'exportTemplateScope')) generationConfigPatch.exportTemplateScope = partial.exportTemplateScope;
    if (hasOwn(partial, 'contentGenerationOptions')) generationConfigPatch.contentGenerationOptions = partial.contentGenerationOptions;
    if (hasOwn(partial, 'outlineWordControlSnapshot')) {
      metaUpdates.outline_word_control_snapshot_json = partial.outlineWordControlSnapshot === undefined || partial.outlineWordControlSnapshot === null
        ? null
        : JSON.stringify(normalizeOutlineWordControlOptions(partial.outlineWordControlSnapshot));
    }
    if (!invalidatesContentGeneration && hasOwn(partial, 'contentGenerationRuntime')) metaUpdates.content_generation_runtime_json = jsonOrNull(partial.contentGenerationRuntime);

    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    const generationConfig = Object.keys(generationConfigPatch).length
      ? updateGenerationConfig(generationConfigPatch)
      : loadGenerationConfig();
    const nextBidMode = generationConfig.bidAnalysisMode;
    if (hasOwn(partial, 'bidAnalysisTasks')) saveBidItems(partial.bidAnalysisTasks, nextBidMode);
    if (hasOwn(partial, 'bidAnalysisItem')) saveBidItem(partial.bidAnalysisItem, nextBidMode);
    if (hasOwn(partial, 'projectOverview')) upsertDerivedBidItem('projectOverview', partial.projectOverview, nextBidMode);
    if (hasOwn(partial, 'techRequirements')) upsertDerivedBidItem('techRequirements', partial.techRequirements, nextBidMode);
    if (hasOwn(partial, 'globalFacts')) {
      replaceGlobalFacts(partial.globalFacts);
    }

    if (invalidatesContentGeneration) clearContentGenerationState(wordChanges);

    for (const [field, type] of Object.entries(taskFieldTypes)) {
      if (invalidatesContentGeneration && field === 'contentGenerationTask') continue;
      if (hasOwn(partial, field)) saveTask(type, partial[field]);
    }

    if (hasOwn(partial, 'outlineData')) {
      if (!partial.outlineData?.outline?.length) stageContentWordRemoval(wordChanges);
      if (partial.outlineData === null) {
        db.prepare('DELETE FROM technical_plan_outline_nodes').run();
        updateMeta({
          outline_project_name: null,
          outline_project_overview: null,
          outline_word_control_snapshot_json: null,
        });
      } else {
        saveOutlineData(partial.outlineData);
        if (!partial.outlineData?.outline?.length) {
          updateMeta({ outline_word_control_snapshot_json: null });
        }
      }
    }

    if (!invalidatesContentGeneration && hasOwn(partial, 'contentGenerationSections')) saveContentSections(partial.contentGenerationSections);
    if (!invalidatesContentGeneration && hasOwn(partial, 'contentGenerationPlans')) saveContentPlans(partial.contentGenerationPlans);
    if (hasOwn(partial, 'contentGenerationItem')) saveContentGenerationItemFields(partial.contentGenerationItem);
  }

  function loadTechnicalPlan() {
    const meta = readMetaRow();
    const generationConfig = loadGenerationConfig();
    const bidAnalysisMode = generationConfig.bidAnalysisMode;
    const bidAnalysisSelectedTaskIds = generationConfig.bidAnalysisSelectedTaskIds;
    const bidAnalysisTasks = loadBidItems();
    const outlineData = loadOutlineData(meta);
    const tasks = loadTasks();
    const bidSections = normalizeBidSections(safeJsonParse(meta.bid_sections_json, []));
    const bidSectionExtractionTask = tasks.bidSectionExtractionTask;
    const tenderFiles = loadTenderSourceFiles(meta);
    const tenderFile = meta.tender_markdown_path ? {
      fileName: meta.tender_file_name || '技术方案招标文件',
      markdownPath: meta.tender_markdown_path,
      markdownChars: Number(meta.tender_markdown_chars || 0),
      contentHash: meta.tender_markdown_hash || '',
      originalMarkdownPath: meta.tender_original_markdown_path || meta.tender_markdown_path,
      originalMarkdownChars: Number(meta.tender_original_markdown_chars || meta.tender_markdown_chars || 0),
      originalContentHash: meta.tender_original_markdown_hash || meta.tender_markdown_hash || '',
      parserLabel: meta.tender_parser_label || undefined,
      importedAt: meta.tender_imported_at || undefined,
      selectedSectionId: meta.selected_section_id || undefined,
      selectedSectionTitle: meta.selected_section_title || undefined,
      updatedAt: meta.updated_at,
    } : null;
    const originalPlanFile = meta.original_plan_markdown_path ? {
      fileName: meta.original_plan_file_name || '原方案',
      markdownPath: meta.original_plan_markdown_path,
      markdownChars: Number(meta.original_plan_markdown_chars || 0),
      contentHash: meta.original_plan_markdown_hash || '',
      parserLabel: meta.original_plan_parser_label || undefined,
      importedAt: meta.original_plan_imported_at || undefined,
      updatedAt: meta.updated_at,
    } : null;

    return {
      ...initialState,
      step: isValidStep(meta.step) ? meta.step : 'document-analysis',
      tenderFile,
      tenderFiles,
      originalPlanFile,
      projectOverview: bidAnalysisTasks.projectOverview?.status === 'success' ? bidAnalysisTasks.projectOverview.content : '',
      techRequirements: bidAnalysisTasks.techRequirements?.status === 'success' ? bidAnalysisTasks.techRequirements.content : '',
      bidAnalysisMode,
      bidAnalysisSelectedTaskIds,
      bidAnalysisTasks,
      bidAnalysisProgress: calculateBidProgress(bidAnalysisMode, bidAnalysisTasks, bidAnalysisSelectedTaskIds),
      bidSectionMode: generationConfig.bidSectionMode,
      bidSections,
      bidSectionExtractionStatus: bidSectionExtractionTask?.status
        ? normalizeBidSectionExtractionStatus(bidSectionExtractionTask.status)
        : normalizeBidSectionExtractionStatus(meta.bid_section_extraction_status),
      bidSectionExtractionError: bidSectionExtractionTask?.error || meta.bid_section_extraction_error || undefined,
      outlineMode: generationConfig.outlineMode,
      outlineExpansionMode: generationConfig.outlineExpansionMode,
      globalFactsMode: generationConfig.globalFactsMode,
      outlineWordControlOptions: generationConfig.outlineWordControlOptions,
      outlineWordControlSnapshot: meta.outline_word_control_snapshot_json
        ? normalizeOutlineWordControlOptions(safeJsonParse(meta.outline_word_control_snapshot_json, defaultOutlineWordControlOptions))
        : undefined,
      referenceKnowledgeDocumentIds: generationConfig.referenceKnowledgeDocumentIds,
      ...tasks,
      globalFacts: loadGlobalFacts(),
      exportTemplateId: generationConfig.exportTemplateId,
      exportTemplateScope: generationConfig.exportTemplateScope,
      contentGenerationOptions: generationConfig.contentGenerationOptions,
      contentGenerationRuntime: safeJsonParse(meta.content_generation_runtime_json, undefined),
      bidTemplateExists: fs.existsSync(bidTemplatePath) && fs.existsSync(bidTemplateFieldsPath),
      contentGenerationSections: loadContentSections(outlineData),
      contentGenerationPlans: loadContentPlans(),
      outlineData,
    };
  }

  const updateTechnicalPlanTransaction = createContentWordTransaction((wordChanges, partial) => {
    applyPartial(partial || {}, wordChanges);
  });

  // 应用技术方案局部更新，但不重新加载完整工作区状态。
  function updateTechnicalPlanWithoutReload(partial) {
    const shouldClearMermaidCache = shouldClearMermaidCacheForPartial(partial);
    updateTechnicalPlanTransaction(partial || {});
    // 正文与任务状态提交后再回收；普通进度和编排更新不扫描图片目录。
    const contentChanged = hasOwn(partial, 'outlineData') || partial.invalidateContentGeneration === true
      || Boolean(partial.contentGenerationItem?.section)
      || Object.values(partial.contentGenerationSections || {}).some(section => hasOwn(section, 'content'));
    const taskSettled = Object.keys(taskFieldTypes).some(field => hasOwn(partial, field)
      && (!partial[field] || ['success', 'error', 'idle'].includes(partial[field].status)));
    if (contentChanged || taskSettled) cleanupOriginalImageBatches();
    const deletedAgentSessions = hasOwn(partial, 'outlineData') && partial.outlineData === null;
    const contentPlanningChanged = hasOwn(partial, 'contentGenerationPlans') || partial.invalidateContentGeneration === true;
    if (deletedAgentSessions) {
      deleteOutlineAgentTask();
      deleteGlobalFactsAgentTask();
    }
    if (shouldClearMermaidCache) {
      clearTechnicalPlanMermaidCache();
    }
    if (deletedAgentSessions || contentPlanningChanged || hasOwn(partial, 'step') || hasOwn(partial, 'outlineData') || hasOwn(partial, 'globalFacts')) {
      notifyAgentWorkspaceChange({ force: deletedAgentSessions || contentPlanningChanged });
    }
  }

  function updateTechnicalPlan(partial) {
    updateTechnicalPlanWithoutReload(partial);
  }

  function updateStep(step) {
    return updateTechnicalPlan({ step });
  }

  // 局部保存统一生成配置；普通配置只更新存储，标段变化继续沿用现有下游清理规则。
  function saveGenerationConfig(partial = {}) {
    let saved;
    let sectionModeChanged = false;
    const transaction = createContentWordTransaction((wordChanges) => {
      const current = loadGenerationConfig();
      const nextSectionMode = hasOwn(partial, 'bidSectionMode')
        ? normalizeBidSectionMode(partial.bidSectionMode)
        : current.bidSectionMode;
      sectionModeChanged = nextSectionMode !== current.bidSectionMode;

      if (sectionModeChanged) {
        clearDownstreamFromBidSectionChange(wordChanges);
        resetTenderWorkingCopyToOriginal();
        updateMeta({
          bid_sections_json: null,
          bid_section_extraction_status: 'idle',
          bid_section_extraction_error: null,
          selected_section_id: null,
          selected_section_title: null,
        });
      }

      saved = updateGenerationConfig(partial);
    });
    transaction();
    if (sectionModeChanged) cleanupOriginalImageBatches();
    return saved;
  }

  // 保存用户确认后的一级目录待扩展选择，不写入正式目录树。
  function saveOutlineSelection({ taskId, items, selectedIds } = {}) {
    const task = loadTask('outline-generation');
    if (!task || task.task_id !== taskId || task.status !== 'success') {
      throw new Error('一级目录生成结果已变化，请重新打开后再选择');
    }

    updateTechnicalPlan({
      outlineGenerationTask: {
        ...task,
        updated_at: now(),
        stats: {
          ...(task.stats || {}),
          outline_selection: {
            items,
            selected_ids: selectedIds,
            confirmed: true,
          },
        },
      },
    });
  }

  function resetTenderWorkingCopyToOriginal() {
    const originalMarkdown = readOriginalTenderMarkdown().trim();
    if (!originalMarkdown) {
      return;
    }
    writeMarkdownFile(tenderMarkdownPath, originalMarkdown, 'tender');
    updateMeta({
      tender_markdown_path: tenderMarkdownRelativePath,
      tender_markdown_hash: stableHash(originalMarkdown),
      tender_markdown_chars: originalMarkdown.length,
    });
  }

  function saveBidAnalysisConfig({ mode, selectedTaskIds, bidSectionMode } = {}) {
    const config = normalizeBidAnalysisConfig(mode, selectedTaskIds);
    saveGenerationConfig({
      bidAnalysisMode: config.mode,
      bidAnalysisSelectedTaskIds: config.selectedTaskIds,
      ...(bidSectionMode === undefined ? {} : { bidSectionMode }),
    });
  }

  function prepareBidSectionExtraction() {
    const transaction = createContentWordTransaction((wordChanges) => {
      clearDownstreamFromBidSectionChange(wordChanges);
      resetTenderWorkingCopyToOriginal();
      updateGenerationConfig({ bidSectionMode: 'multiple' });
      updateMeta({
        bid_sections_json: null,
        bid_section_extraction_status: 'running',
        bid_section_extraction_error: null,
        selected_section_id: null,
        selected_section_title: null,
      });
    });
    transaction();
    cleanupOriginalImageBatches();
  }

  function saveOutline(payload) {
    const request = payload?.outlineData ? payload : { outlineData: payload, reason: 'replace' };
    const outlineData = request?.outlineData;
    const reason = normalizeOutlineSaveReason(request?.reason);
    const affectedIds = normalizeStringSet(request?.affectedNodeIds);
    const clearAll = reason === 'replace';
    const preservesContentTask = reason === 'sort' || reason === 'edit';
    const invalidatesContentTask = !preservesContentTask;

    let savedOutlineData = outlineData;
    const transaction = createContentWordTransaction((wordChanges) => {
      assertOutlineMutationAllowed();
      if (preservesContentTask) {
        if (reason === 'edit') {
          // 改名只写标题，不更新正文、说明、处理模式或编排。
          const updateTitle = db.prepare('UPDATE technical_plan_outline_nodes SET title = ?, updated_at = ? WHERE node_id = ? AND title <> ?');
          const timestamp = now();
          for (const row of flattenOutlineItems(outlineData?.outline || [])) updateTitle.run(row.title, timestamp, row.node_id, row.title);
        } else {
          saveSortedOutline(outlineData);
        }
        savedOutlineData = loadOutlineData(readMetaRow());
        return;
      }
      const snapshot = loadOutlinePersistenceSnapshot();
      const previousRuntime = safeJsonParse(readMetaRow().content_generation_runtime_json, {}) || {};
      const generationStarted = Boolean(previousRuntime.generation_started || loadTask('content-generation'));
      const rowsBeforeSave = flattenOutlineItems(outlineData?.outline || []);
      const previousParents = new Set(Object.values(snapshot.nodes).map(node => node.parentId).filter(Boolean));
      const nextParents = new Set(rowsBeforeSave.map(row => row.parent_node_id).filter(Boolean));
      const newLeafIds = [];
      for (const row of rowsBeforeSave) {
        const id = row.node_id;
        const wasBranch = previousParents.has(id);
        const isBranch = nextParents.has(row.node_id);
        if (wasBranch !== isBranch && snapshot.nodes[id]) affectedIds.add(id);
        if (!isBranch && row.content_mode === 'ai-generate' && (!snapshot.nodes[id] || wasBranch)) newLeafIds.push(row.node_id);
      }
      const outlineToSave = buildOutlineWithPersistedContent(outlineData, { snapshot, affectedIds, clearAll });
      const nextIds = new Set(flattenOutlineItems(outlineToSave?.outline || []).map(row => row.node_id));
      reconcileContentWords(wordChanges, { snapshot, affectedIds, nextIds, clearAll });
      savedOutlineData = outlineToSave ? { ...outlineToSave, outline: numberOutline(outlineToSave.outline) } : outlineToSave;
      saveOutlineData(outlineToSave);
      if (!outlineToSave?.outline?.length) {
        updateMeta({ outline_word_control_snapshot_json: null });
      }
      restoreRetainedContentRows({ snapshot, affectedIds, nextIds, clearAll });
      if (invalidatesContentTask) {
        db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'content-generation'").run();
        clearTechnicalPlanMermaidCache();
        // 结构变化清除本轮进度，保留锁定及局部生成范围；完整替换则重置。
        const survivingIds = ids => (ids || []).filter(id => nextIds.has(id) && !affectedIds.has(id));
        const retainedRuntime = {
          direct_generation_item_ids: survivingIds(previousRuntime.direct_generation_item_ids),
          pending_item_ids: survivingIds(previousRuntime.pending_item_ids),
        };
        const leafIds = new Set(rowsBeforeSave.filter(row => !nextParents.has(row.node_id) && row.content_mode === 'ai-generate').map(row => row.node_id));
        const keepLeafIds = ids => [...new Set(ids)].filter(id => leafIds.has(id));
        const keepResult = id => leafIds.has(id) && !affectedIds.has(id);
        updateMeta({ content_generation_runtime_json: clearAll ? null : JSON.stringify({
          generation_started: generationStarted,
          section_words: Object.fromEntries(Object.entries(previousRuntime.section_words || {}).filter(([id]) => keepResult(id))),
          ...(previousRuntime.html_output ? { html_output: {
            ...previousRuntime.html_output,
            word_sections: previousRuntime.html_output.word_sections.filter(section => keepResult(section.section_id)),
          } } : {}),
          phase: 'planning',
          direct_generation_item_ids: keepLeafIds([...(retainedRuntime.direct_generation_item_ids || []), ...newLeafIds]),
          pending_item_ids: keepLeafIds([...(retainedRuntime.pending_item_ids || []), ...(generationStarted ? newLeafIds : [])]),
        }) });
      }
    });
    transaction();
    if (invalidatesContentTask) {
      agentService.deletePersistentTask(CONTENT_PLANNING_AGENT_TASK_KEY);
      agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
      if (clearAll) agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
      cleanupOriginalImageBatches();
    }
    const savedContentRuntime = safeJsonParse(readMetaRow().content_generation_runtime_json, undefined);
    const savedContentTask = preservesContentTask ? loadTask('content-generation') : undefined;
    return {
      outlineData: savedOutlineData,
      contentGenerationTask: savedContentTask,
      contentGenerationRuntime: savedContentRuntime,
      contentGenerationSections: loadContentSections(savedOutlineData),
      contentGenerationPlans: loadContentPlans(),
    };
  }

  function saveGlobalFacts(globalFacts) {
    const normalizedGlobalFacts = normalizeGlobalFactGroups(globalFacts);
    let savedTask;
    const transaction = createContentWordTransaction((wordChanges) => {
      replaceGlobalFacts(normalizedGlobalFacts);
      clearContentGenerationState(wordChanges);
      const timestamp = now();
      savedTask = {
        task_id: `manual-global-facts-${Date.now()}`,
        type: 'global-facts-generation',
        status: 'success',
        progress: 100,
        logs: ['全局事实已保存。'],
        started_at: timestamp,
        updated_at: timestamp,
      };
      saveTask('global-facts-generation', savedTask);
    });
    transaction();
    cleanupOriginalImageBatches();
    return {
      globalFacts: normalizedGlobalFacts,
      globalFactsTask: savedTask,
      contentGenerationTask: undefined,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentGenerationRuntime: undefined,
    };
  }

  function saveContentGenerationOptions(contentGenerationOptions) {
    const saved = saveGenerationConfig({ contentGenerationOptions });
    return { contentGenerationOptions: saved.contentGenerationOptions };
  }

  function saveChapterContent({ nodeId, content }) {
    const transaction = db.transaction(() => {
      assertContentEditingAllowed();
      const timestamp = now();
      const node = db.prepare('SELECT node_id, title FROM technical_plan_outline_nodes WHERE node_id = ?').get(nodeId);
      if (!node) throw new Error('当前目录中未找到该章节');
      const nextContent = String(content || '');
      db.prepare('UPDATE technical_plan_outline_nodes SET content = ?, updated_at = ? WHERE node_id = ?').run(nextContent, timestamp, nodeId);
      db.prepare(`
        INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
        VALUES (?, ?, NULL, ?)
        ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, error = NULL, updated_at = excluded.updated_at
      `).run(nodeId, nextContent.trim() ? 'success' : 'idle', timestamp);
    });
    transaction();
    cleanupOriginalImageBatches();
    return {};
  }

  async function runBeforeCommit(beforeCommit) {
    if (typeof beforeCommit === 'function') {
      await beforeCommit();
    }
  }

  async function importTenderDocument(filePaths, options = {}) {
    if (!fileService?.importDocument) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = await fileService.importDocument({ multiple: true, filePaths });
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        markdown: '',
      };
    }

    const importedDocuments = Array.isArray(result.documents) && result.documents.length ? result.documents : [result];
    const existingSourceDocuments = loadTenderSourceFiles().map((file) => {
      const markdown = String(readTenderSourceMarkdown(file.id) || '').trim();
      return markdown ? {
        file_content: markdown,
        file_name: file.fileName,
        parser_label: file.parserLabel,
        content_hash: file.contentHash || stableHash(markdown),
        source_docx_path: file.sourceDocxPath,
      } : null;
    }).filter(Boolean);
    const existingKeys = new Set(existingSourceDocuments.map((item) => `${item.file_name}\u0000${item.content_hash}`));
    const existingOriginalPaths = new Set(existingSourceDocuments
      .map((item) => String(item.source_docx_path || '').trim())
      .filter(Boolean)
      .map((item) => filePathKey(resolveMarkdownPath(item))));
    const addedDocuments = [];
    let skippedCount = 0;
    importedDocuments.forEach((item) => {
      const markdown = String(item.file_content || '').trim();
      if (!markdown) return;
      const fileName = item.file_name || '未命名文件';
      const key = `${fileName}\u0000${stableHash(markdown)}`;
      const sourcePath = String(item.source_path || '').trim();
      if (existingKeys.has(key) || (sourcePath && existingOriginalPaths.has(filePathKey(sourcePath)))) {
        skippedCount += 1;
        return;
      }
      existingKeys.add(key);
      addedDocuments.push(item);
    });

    if (!addedDocuments.length) {
      const messageParts = [];
      if (skippedCount > 0) messageParts.push(`已跳过 ${skippedCount} 份重复文件`);
      appendImportFailureParts(messageParts, result.errors);
      return {
        success: false,
        message: messageParts.join('，') || result.message || '未导入文件',
        markdown: '',
      };
    }

    await runBeforeCommit(options.beforeCommit);
    clearBidTemplate();
    cleanupPendingTenderSelection();

    const mergedDocuments = [...existingSourceDocuments, ...addedDocuments];
    pruneTenderOriginals([
      ...existingSourceDocuments.map((item) => item.source_docx_path),
      ...addedDocuments.map((item) => item.source_path),
    ].filter(Boolean), 'import-preflight');
    for (let index = 0; index < mergedDocuments.length; index += 1) {
      const item = mergedDocuments[index];
      const sourcePath = String(item.source_path || '').trim();
      if (!sourcePath || item.source_docx_path || !fileService?.persistTenderSourceDocx) continue;
      const sourceId = createTenderSourceId(item.file_name || '未命名文件', String(item.file_content || '').trim(), index);
      const relativePath = path.join(tenderOriginalsDirRelativePath, `${sourceId}.docx`).replace(/\\/g, '/');
      const destPath = resolveMarkdownPath(relativePath);
      const managedRelativePath = getManagedTenderOriginalRelativePath(sourcePath);
      if (managedRelativePath) {
        item.source_docx_path = managedRelativePath;
        tenderOriginalLogger.write('tender-original.persist.reused', { phase: 'import', source_path: sourcePath });
        continue;
      }
      tenderOriginalLogger.write('tender-original.persist.started', { phase: 'import', source_path: sourcePath, dest_path: destPath });
      try {
        const persisted = filePathKey(sourcePath) === filePathKey(destPath)
          ? true
          : await fileService.persistTenderSourceDocx(sourcePath, destPath);
        if (persisted) item.source_docx_path = relativePath;
        tenderOriginalLogger.write('tender-original.persist.completed', { phase: 'import', source_path: sourcePath, dest_path: destPath, persisted: Boolean(persisted) });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.persist.failed', {
          phase: 'import',
          source_path: sourcePath,
          dest_path: destPath,
          code: error?.code,
          syscall: error?.syscall,
          error: compactLogError(error),
        });
        throw new Error(`${item.file_name || '招标文件'}：无法保存 Word 原件，${error.message || error}`);
      }
    }
    const markdown = combineTenderMarkdown(mergedDocuments.map((item) => item.file_content));
    const fileName = mergedDocuments.length > 1 ? `${mergedDocuments.length} 份招标文件` : mergedDocuments[0].file_name || '未命名文件';
    const parserLabel = mergedDocuments.length > 1 ? null : mergedDocuments[0].parser_label || null;
    const messageParts = [`已解析 ${addedDocuments.length} 份招标文件`];
    if (result.fallbackToLocal === true || mergedDocuments.some((item) => item.fallback_to_local)) {
      messageParts.push('当前格式已自动使用本地解析');
    }
    if (skippedCount > 0) messageParts.push(`跳过 ${skippedCount} 份重复文件`);
    appendImportFailureParts(messageParts, result.errors);

    return saveTenderMarkdownAndState(markdown, {
      fileName,
      parserLabel,
      message: messageParts.join('，'),
      fallbackToLocal: result.fallbackToLocal === true,
      resetOriginal: true,
      sourceFiles: mergedDocuments,
    });
  }

  async function removeTenderDocument(sourceId, options = {}) {
    const targetId = String(sourceId || '');
    const existingFiles = loadTenderSourceFiles();
    const remainingFiles = existingFiles.filter((file) => file.id !== targetId);
    if (!targetId || remainingFiles.length === existingFiles.length) {
      return { success: false, message: '未找到要删除的招标文件', markdown: '' };
    }

    await runBeforeCommit(options.beforeCommit);
    clearBidTemplate();
    if (!remainingFiles.length) {
      clearTenderSourceFiles('remove-last-tender');
      removeWorkspacePathSync(tenderMarkdownPath);
      removeWorkspacePathSync(tenderOriginalMarkdownPath);
      const transaction = createContentWordTransaction((wordChanges) => {
        clearDownstreamFromTender(wordChanges);
        updateMeta({
          tender_file_name: null,
          tender_markdown_path: null,
          tender_markdown_hash: null,
          tender_markdown_chars: 0,
          tender_original_markdown_path: null,
          tender_original_markdown_hash: null,
          tender_original_markdown_chars: 0,
          tender_parser_label: null,
          tender_imported_at: null,
          tender_files_json: null,
          selected_section_id: null,
          selected_section_title: null,
        });
      });
      transaction();
      cleanupOriginalImageBatches();
      return { success: true, message: '已移除招标文件', markdown: '' };
    }

    const sourceFiles = remainingFiles.map((file) => ({
      file_content: String(readTenderSourceMarkdown(file.id) || '').trim(),
      file_name: file.fileName,
      parser_label: file.parserLabel,
      source_docx_path: file.sourceDocxPath,
    })).filter((item) => item.file_content);
    const markdown = combineTenderMarkdown(sourceFiles.map((item) => item.file_content));
    const fileName = sourceFiles.length > 1 ? `${sourceFiles.length} 份招标文件` : sourceFiles[0]?.file_name || '未命名文件';
    const parserLabel = sourceFiles.length > 1 ? null : sourceFiles[0]?.parser_label || null;
    return saveTenderMarkdownAndState(markdown, {
      fileName,
      parserLabel,
      message: '已移除招标文件',
      resetOriginal: true,
      sourceFiles,
    });
  }

  // 定位已导入的原图，供正文 Agent 复制资源及原方案存在性检查复用。
  function resolveOriginalImagePath(reference) {
    const root = path.resolve(getImportedImagesDir(app));
    const url = new URL(reference);
    const filePath = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) {
      throw new Error(`原方案图片资源缺失，请重新导入原 Word：${reference}`);
    }
    return filePath;
  }

  // 校验原图资源实际存在，不触发图片下载或生成。
  function assertOriginalImageFiles(markdown) {
    for (const reference of new Set(originalImageReferences(markdown))) resolveOriginalImagePath(reference);
  }

  // 原方案或正文变化、任务结束后回收未引用批次；活动/暂停任务退出后由状态提交再次触发。
  function cleanupOriginalImageBatches() {
    if (db.prepare("SELECT 1 FROM technical_plan_tasks WHERE status IN ('running', 'pausing', 'paused') LIMIT 1").get()) return;
    const root = path.resolve(getImportedImagesDir(app));
    if (!fs.existsSync(root)) return;
    const batches = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('technical-plan-original-'));
    if (!batches.length) return;
    const retained = new Set();
    const contents = [readOriginalPlanMarkdown(), ...db.prepare('SELECT content FROM technical_plan_outline_nodes').all().map(row => row.content)];
    for (const content of contents) {
      for (const reference of originalImageReferences(content)) retained.add(decodeURIComponent(new URL(reference).pathname.split('/')[1]));
    }
    for (const entry of batches) {
      if (retained.has(entry.name)) continue;
      const target = path.resolve(root, entry.name);
      const relative = path.relative(root, target);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(target, { recursive: true, force: true });
    }
  }

  async function importOriginalPlanDocument(filePaths) {
    const importer = fileService?.importTechnicalPlanDocument || fileService?.importDocument;
    if (!importer) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = fileService.importTechnicalPlanDocument
      ? await fileService.importTechnicalPlanDocument('原方案', { filePaths, preserveImages: true, assetScopePrefix: 'technical-plan-original' })
      : await importer({ filePaths });
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        markdown: '',
      };
    }

    const markdown = String(result.file_content || '').trim();
    assertOriginalImageFiles(markdown);
    const fileName = result.file_name || '未命名文件';
    const parserLabel = result.parser_label || null;
    const targetDir = path.dirname(originalPlanMarkdownPath);
    const tempPath = path.join(targetDir, `original-plan-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${markdown}\n`, 'utf-8');

    try {
      fs.renameSync(tempPath, originalPlanMarkdownPath);
      const timestamp = now();
      const transaction = db.transaction(() => {
        updateMeta({
          original_plan_file_name: fileName,
          original_plan_markdown_path: originalPlanMarkdownRelativePath,
          original_plan_markdown_hash: stableHash(markdown),
          original_plan_markdown_chars: markdown.length,
          original_plan_parser_label: parserLabel || null,
          original_plan_imported_at: timestamp,
        });
      });
      transaction();
      agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
      agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
      cleanupOriginalImageBatches();
      return {
        success: true,
        message: result.message || '原方案已导入',
        markdown,
      };
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  async function removeOriginalPlanDocument() {
    const meta = ensureMetaRow();
    if (!meta.original_plan_markdown_path) {
      return { success: true, message: '当前没有已上传的原方案' };
    }

    const filePath = resolveMarkdownPath(meta.original_plan_markdown_path);
    const transaction = db.transaction(() => {
      updateMeta({
        original_plan_file_name: null,
        original_plan_markdown_path: null,
        original_plan_markdown_hash: null,
        original_plan_markdown_chars: 0,
        original_plan_parser_label: null,
        original_plan_imported_at: null,
      });
      updateGenerationConfig({ outlineExpansionMode: 'ai-complement' });
    });
    transaction();
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    agentService.deletePersistentTask(ORIGINAL_RESTORATION_AGENT_TASK_KEY);
    agentService.deletePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
    cleanupOriginalImageBatches();
    return { success: true, message: '已移除原方案' };
  }

  function saveTenderMarkdownAndState(markdown, { fileName, parserLabel, message, selectedSection, fallbackToLocal, resetOriginal, sourceFiles }) {
    const nextMarkdown = String(markdown || '').trim();
    if (Array.isArray(sourceFiles)) {
      clearBidTemplate();
      if (fs.existsSync(tenderSourceFilesDir)) {
        removeWorkspacePathSync(tenderSourceFilesDir);
      }
    }
    const tenderSourceFiles = Array.isArray(sourceFiles)
      ? sourceFiles.map(writeTenderSourceMarkdown)
      : undefined;
    if (tenderSourceFiles) {
      pruneTenderOriginals(tenderSourceFiles.map((file) => file.sourceDocxPath).filter(Boolean));
    }
    writeMarkdownFile(tenderMarkdownPath, nextMarkdown, 'tender');
    if (resetOriginal) {
      writeMarkdownFile(tenderOriginalMarkdownPath, nextMarkdown, 'tender-original');
    }

    const timestamp = now();
    const transaction = createContentWordTransaction((wordChanges) => {
      clearDownstreamFromTender(wordChanges);
      updateMeta({
        tender_file_name: fileName || '未命名文件',
        tender_markdown_path: tenderMarkdownRelativePath,
        tender_markdown_hash: stableHash(nextMarkdown),
        tender_markdown_chars: nextMarkdown.length,
        tender_original_markdown_path: resetOriginal ? tenderOriginalMarkdownRelativePath : undefined,
        tender_original_markdown_hash: resetOriginal ? stableHash(nextMarkdown) : undefined,
        tender_original_markdown_chars: resetOriginal ? nextMarkdown.length : undefined,
        tender_parser_label: parserLabel || null,
        tender_imported_at: timestamp,
        tender_files_json: tenderSourceFiles ? JSON.stringify(tenderSourceFiles) : undefined,
        selected_section_id: selectedSection?.id || null,
        selected_section_title: selectedSection?.title || null,
      });
    });
    transaction();
    cleanupOriginalImageBatches();
    return {
      success: true,
      message: message || (fallbackToLocal ? '文件解析完成，当前格式已自动使用本地解析' : '招标文件已导入'),
      markdown: nextMarkdown,
    };
  }

  function selectBidSection(selectedSection) {
    const selected = selectedSection || {};
    const meta = ensureMetaRow();
    const aiSections = normalizeBidSections(safeJsonParse(meta.bid_sections_json, []));

    if (aiSections.length >= 2) {
      const matched = aiSections.find((section) => section.id === selected.id) || selected;
      const originalMarkdown = readOriginalTenderMarkdown().trim();
      if (!originalMarkdown) {
        throw new Error('原始招标文件内容为空，请重新上传');
      }
      const workingMarkdown = buildSelectedSectionMarkdown(originalMarkdown, aiSections, matched.id);
      clearBidTemplate();
      writeMarkdownFile(tenderMarkdownPath, workingMarkdown, 'tender');
      const transaction = createContentWordTransaction((wordChanges) => {
        clearDownstreamFromBidSectionChange(wordChanges);
        updateGenerationConfig({ bidSectionMode: 'multiple' });
        updateMeta({
          tender_markdown_path: tenderMarkdownRelativePath,
          tender_markdown_hash: stableHash(workingMarkdown),
          tender_markdown_chars: workingMarkdown.length,
          selected_section_id: matched.id || null,
          selected_section_title: matched.title || null,
        });
      });
      transaction();
      cleanupOriginalImageBatches();
      return {
        success: true,
        message: `已选择【${matched.title || '投标范围'}】，招标文件解析将仅使用当前投标范围`,
        markdown: workingMarkdown,
      };
    }

    throw new Error('请先完成多标段识别，再选择投标范围');
  }

  // 全流程重置按业务目录与表整体清空，包含没有节点记录的 Word 和暂存文件。
  function clearTechnicalPlan() {
    removeWorkspacePathSync(getTechnicalPlanDir(app), undefined, { deferOnFailure: false });
    removeWorkspacePathSync(path.join(getGeneratedImagesDir(app), 'technical-plan'), undefined, { deferOnFailure: false });
    clearTechnicalPlanMermaidCache();
    deleteImportedImageBatches(app, 'technical-plan');
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_tasks').run();
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      db.prepare('DELETE FROM technical_plan_generation_bid_tasks').run();
      db.prepare('DELETE FROM technical_plan_generation_reference_docs').run();
      db.prepare('DELETE FROM technical_plan_generation_config').run();
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
      db.prepare('DELETE FROM technical_plan_meta').run();
      ensureMetaRow();
      ensureGenerationConfigRow();
    });
    transaction();
    notifyAgentWorkspaceChange({ force: true });
    return { success: true, message: '技术方案已重置' };
  }

  ensureGenerationConfigRow();
  cleanupLegacyPendingTenderState(ensureMetaRow());

  return {
    loadTechnicalPlan,
    loadGenerationConfig,
    saveGenerationConfig,
    updateTechnicalPlan,
    updateTechnicalPlanWithoutReload,
    clearMermaidCache: clearTechnicalPlanMermaidCache,
    clearTechnicalPlan,
    importTenderDocument,
    removeTenderDocument,
    importOriginalPlanDocument,
    removeOriginalPlanDocument,
    checkBidSections,
    prepareBidSectionExtraction,
    selectBidSection,
    readTenderMarkdown,
    readContentWord,
    readTenderSourceMarkdown,
    readOriginalTenderMarkdown,
    readOriginalPlanMarkdown,
    assertOriginalImageFiles,
    resolveOriginalImagePath,
    readOriginalOutlineRuntime,
    saveOriginalOutlineRuntime,
    clearOriginalOutlineRuntime,
    updateStep,
    setAgentWorkspaceChangeListener,
    saveBidAnalysisConfig,
    saveOutlineSelection,
    saveOutline,
    saveGlobalFacts,
    saveContentGenerationOptions,
    saveChapterContent,
    clearBidTemplate,
    // 正文 Word 直接保存到技术方案业务目录，独立于 Agent 会话。
    getContentWordOutputDir() {
      return getTechnicalPlanDir(app);
    },
    listTenderSourceDocxRelativePaths() {
      return loadTenderSourceFiles()
        .map((file) => String(file.sourceDocxPath || '').trim())
        .filter((item) => item && fs.existsSync(resolveMarkdownPath(item)));
    },
    getBidTemplateRelativePath() {
      return bidTemplateRelativePath;
    },
    getBidTemplateSourceRelativePath() {
      return bidTemplateSourceRelativePath;
    },
    getBidTemplateFieldsRelativePath() {
      return bidTemplateFieldsRelativePath;
    },
    hasBidTemplate() {
      return fs.existsSync(bidTemplatePath) && fs.existsSync(bidTemplateFieldsPath);
    },
    getBidTemplatePath() {
      return bidTemplatePath;
    },
    getBidTemplateSourcePath() {
      return bidTemplateSourcePath;
    },
    getBidTemplateFieldsPath() {
      return bidTemplateFieldsPath;
    },
    copyTenderOriginalsToDirectory(destDir) {
      const targetDir = String(destDir || '').trim();
      if (!targetDir) return [];
      fs.mkdirSync(targetDir, { recursive: true });
      return loadTenderSourceFiles()
        .map((file) => String(file.sourceDocxPath || '').trim())
        .filter((item) => item && fs.existsSync(resolveMarkdownPath(item)))
        .map((relativePath) => {
          const fileName = path.basename(relativePath);
          fs.copyFileSync(resolveMarkdownPath(relativePath), path.join(targetDir, fileName));
          return fileName;
        });
    },
    resolveTenderSourceDocxPath(sourceHint) {
      const hint = String(sourceHint || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const sources = loadTenderSourceFiles()
        .map((file) => String(file.sourceDocxPath || '').trim())
        .filter((item) => item && fs.existsSync(resolveMarkdownPath(item)));
      if (!hint || hint === '招标原件') return sources;
      const fileName = path.posix.basename(hint);
      if (!fileName || fileName === '招标原件') return sources;
      const matched = sources.find((item) => path.posix.basename(item) === fileName || item === hint);
      return matched ? [matched] : [];
    },
  };
}

module.exports = {
  createTechnicalPlanStore,
};
