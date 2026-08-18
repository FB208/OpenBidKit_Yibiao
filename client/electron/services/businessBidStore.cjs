const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function collectLeafItems(items) {
  return (items || []).flatMap((item) => item?.children?.length ? collectLeafItems(item.children) : [item]);
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

function formatOutlineForPrompt(items, level = 1, lines = []) {
  for (const item of items || []) {
    const id = String(item?.id || 'unknown');
    const title = String(item?.title || '未命名章节');
    const description = String(item?.description || '');
    lines.push(`${'  '.repeat(Math.max(0, level - 1))}- ${id} ${title}${description ? `：${description}` : ''}`);
    if (item?.children?.length) formatOutlineForPrompt(item.children, level + 1, lines);
  }
  return lines.join('\n');
}

const initialState = {
  step: 'document-analysis',
  tenderFile: null,
  referenceTechnicalPlan: false,
  referenceTechnicalPlanSummary: null,
  referenceKnowledgeDocumentIds: [],
  referenceKnowledgeSnippetIds: [],
  hasExplicitContentList: undefined,
  requiredBusinessContents: undefined,
  selectedTemplateItemIds: undefined,
  templateApplied: undefined,
  clauseAnalysisTasks: {},
  clauseAnalysisProgress: 0,
  clauseItems: [],
  outlineData: null,
  outlineGenerationTask: null,
  globalFacts: [],
  globalFactsTask: null,
  contentGenerationOptions: null,
  contentGenerationSections: {},
  contentGenerationTask: null,
};

const VALID_STEPS = ['document-analysis', 'bid-analysis', 'outline-generation', 'global-facts', 'content-edit', 'expand'];

function isValidStep(value) {
  return VALID_STEPS.includes(value);
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeClauseStatus(responseStatus) {
  if (responseStatus === '已响应') return 'success';
  if (responseStatus === '不满足') return 'error';
  return 'idle';
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function createBusinessBidStore({ app, fileService, technicalPlanStore, knowledgeBaseService }) {
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  const businessBidDir = path.join(workspaceDir, 'business-bid');
  const tenderMarkdownPath = path.join(businessBidDir, 'tender.md');
  const statePath = path.join(workspaceDir, 'business_bid.json');

  function ensureDirs() {
    fs.mkdirSync(businessBidDir, { recursive: true });
  }

  function readState() {
    if (!fs.existsSync(statePath)) return { ...initialState };
    const parsed = safeJsonParse(fs.readFileSync(statePath, 'utf-8'), null);
    if (!parsed || typeof parsed !== 'object') return { ...initialState };
    return { ...initialState, ...parsed };
  }

  function writeState(state) {
    ensureDirs();
    const next = { ...state, updatedAt: now() };
    const tempPath = `${statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, statePath);
    return next;
  }

  function readTenderMarkdown() {
    if (!fs.existsSync(tenderMarkdownPath)) return '';
    return fs.readFileSync(tenderMarkdownPath, 'utf-8');
  }

  function writeTenderMarkdown(markdown) {
    ensureDirs();
    const tempPath = `${tenderMarkdownPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${String(markdown || '').trim()}\n`, 'utf-8');
    fs.renameSync(tempPath, tenderMarkdownPath);
  }

  function isImportantCategory(category) {
    const value = String(category || '').trim();
    return value.includes('资格性审查') || value.includes('无效标') || value.includes('废标');
  }

  function getClauseItems(state) {
    const raw = Array.isArray(state.clauseItems) ? state.clauseItems : [];
    return raw.map((item) => ({
      id: String(item?.id || '').trim(),
      category: String(item?.category || '商务条款').trim() || '商务条款',
      title: String(item?.title || '').trim(),
      requirement: String(item?.requirement || '').trim(),
      response_status: (['已响应', '待确认', '需复核', '不满足'].includes(item?.response_status) ? item.response_status : '待确认'),
      response_detail: String(item?.response_detail || '').trim(),
      deviation: String(item?.deviation || '').trim(),
      // isImportant 已持久化时使用保存值，未持久化时按分类自动标红
      isImportant: item && 'isImportant' in item ? item.isImportant === true : isImportantCategory(item?.category),
    })).filter((item) => item.id && item.title);
  }

  function buildClauseAnalysisTaskFromItems(clauseItems) {
    const tasks = {};
    for (const item of clauseItems) {
      tasks[item.id] = {
        id: item.id,
        label: `${item.category} / ${item.title}`,
        status: normalizeClauseStatus(item.response_status),
        content: [
          `招标要求：${item.requirement}`,
          `响应内容：${item.response_detail}`,
          `偏离说明：${item.deviation}`,
        ].filter(Boolean).join('\n'),
      };
    }
    return tasks;
  }

  function buildContentSectionsFromOutline(outlineData, previousSections = {}) {
    const sections = {};
    for (const item of collectLeafItems(outlineData?.outline || [])) {
      const previous = previousSections[item.id];
      const content = item.content?.trim() ? item.content : '';
      sections[item.id] = {
        id: item.id,
        title: item.title || '未命名章节',
        status: previous?.status === 'running' ? 'idle' : (content ? 'success' : 'idle'),
        content,
        updated_at: previous?.updated_at,
      };
    }
    return sections;
  }

  function loadBusinessBid() {
    const state = readState();
    const clauseItems = getClauseItems(state);
    const clauseAnalysisTasks = Object.keys(state.clauseAnalysisTasks || {}).length
      ? state.clauseAnalysisTasks
      : buildClauseAnalysisTaskFromItems(clauseItems);
    return {
      ...state,
      clauseItems,
      clauseAnalysisTasks,
      outlineData: state.outlineData?.outline?.length ? state.outlineData : null,
      contentGenerationSections: state.contentGenerationSections || {},
    };
  }

  function updateBusinessBid(partial) {
    const state = readState();
    const next = { ...state, ...(partial || {}) };
    writeState(next);
    return loadBusinessBid();
  }

  function updateStep(step) {
    return updateBusinessBid({ step: isValidStep(step) ? step : 'document-analysis' });
  }

  async function importTenderDocument() {
    if (!fileService?.importDocument) {
      throw new Error('文件导入服务尚未初始化');
    }
    const result = await fileService.importDocument({ multiple: true });
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        state: loadBusinessBid(),
        markdown: '',
      };
    }
    const importedDocuments = Array.isArray(result.documents) && result.documents.length ? result.documents : [result];
    const markdown = (importedDocuments.map((item) => String(item.file_content || '').trim()).filter(Boolean).join('\n\n'));
    const fileName = importedDocuments.length > 1 ? `${importedDocuments.length} 份招标文件` : (result.file_name || '未命名文件');
    const parserLabel = importedDocuments.length > 1 ? null : (result.parser_label || null);
    writeTenderMarkdown(markdown);
    const state = readState();
    const nextState = {
      ...state,
      step: 'document-analysis',
      tenderFile: {
        fileName,
        markdownPath: 'business-bid/tender.md',
        markdownChars: markdown.length,
        contentHash: crypto.createHash('sha256').update(markdown, 'utf8').digest('hex'),
        parserLabel,
        importedAt: now(),
        updatedAt: now(),
      },
      // 重新导入招标文件清空下游
      clauseAnalysisTasks: {},
      clauseAnalysisProgress: 0,
      clauseItems: [],
      hasExplicitContentList: undefined,
      requiredBusinessContents: undefined,
      selectedTemplateItemIds: undefined,
      templateApplied: undefined,
      outlineData: null,
      outlineGenerationTask: null,
      globalFacts: [],
      globalFactsTask: null,
      contentGenerationOptions: null,
      contentGenerationSections: {},
      contentGenerationTask: null,
    };
    writeState(nextState);
    return {
      success: true,
      message: result.message || '招标文件已导入',
      state: loadBusinessBid(),
      markdown,
    };
  }

  function buildTechnicalPlanContext() {
    if (!technicalPlanStore?.loadTechnicalPlan) return '';
    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const outlineText = technicalPlan.outlineData?.outline?.length
      ? formatOutlineForPrompt(technicalPlan.outlineData.outline)
      : '';
    const factsText = (Array.isArray(technicalPlan.globalFacts) ? technicalPlan.globalFacts : [])
      .map((group) => `## ${String(group?.title || '')}\n${String(group?.content || '')}`)
      .join('\n\n');
    const parts = [];
    if (outlineText) parts.push(`### 已生成技术方案目录\n${outlineText}`);
    if (factsText) parts.push(`### 已生成技术方案全局事实\n${factsText}`);
    return parts.join('\n\n');
  }

  function associateTechnicalPlan() {
    const summary = buildTechnicalPlanContext();
    if (!summary.trim()) {
      throw new Error('当前没有已生成的技术方案，请先在技术方案工作台生成后再关联。');
    }
    return updateBusinessBid({ referenceTechnicalPlan: true, referenceTechnicalPlanSummary: summary });
  }

  function disassociateTechnicalPlan() {
    return updateBusinessBid({ referenceTechnicalPlan: false, referenceTechnicalPlanSummary: null });
  }

  function hasTechnicalPlan() {
    const plan = technicalPlanStore.loadTechnicalPlan();
    return Boolean(plan?.outlineData?.outline?.length);
  }


  function normalizeOutlineWordControlOptions(value) {
    const sectionWords = normalizeNonNegativeInteger(value?.sectionWords);
    return {
      minimumWords: normalizeNonNegativeInteger(value?.minimumWords),
      maximumWords: normalizeNonNegativeInteger(value?.maximumWords),
      sectionWords,
      strictSectionWords: sectionWords > 0 && Boolean(value?.strictSectionWords),
    };
  }

  function saveOutlineConfig({ referenceKnowledgeDocumentIds, outlineMode, referenceKnowledgeSnippetIds, referenceKnowledgeItemIds, outlineExpansionMode, wordControlOptions } = {}) {
    return updateBusinessBid({
      outlineMode: ['aligned', 'response-file'].includes(outlineMode) ? outlineMode : 'response-file',
      outlineExpansionMode: ['ai-complement', 'aligned'].includes(outlineExpansionMode) ? outlineExpansionMode : 'ai-complement',
      outlineWordControlOptions: normalizeOutlineWordControlOptions(wordControlOptions),
      referenceKnowledgeDocumentIds: Array.isArray(referenceKnowledgeDocumentIds) ? referenceKnowledgeDocumentIds : [],
      referenceKnowledgeSnippetIds: Array.isArray(referenceKnowledgeSnippetIds) ? referenceKnowledgeSnippetIds : [],
      referenceKnowledgeItemIds: Array.isArray(referenceKnowledgeItemIds) ? referenceKnowledgeItemIds : [],
    });
  }

  // 保存用户确认后的一级目录待扩展选择，不写入正式目录树。
  function saveOutlineSelection({ taskId, items, selectedIds } = {}) {
    const task = readState().outlineGenerationTask;
    if (!task || task.task_id !== taskId || task.status !== 'success') {
      throw new Error('一级目录生成结果已变化，请重新打开后再选择');
    }
    return updateBusinessBid({
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

  function saveOutline(payload) {
    const outlineData = payload?.outlineData || payload;
    if (!outlineData?.outline?.length) {
      return updateBusinessBid({ outlineData: null, contentGenerationSections: {}, contentGenerationTask: null });
    }
    const previous = readState();
    const previousSections = previous.contentGenerationSections || {};
    const persistedContent = {};
    for (const item of collectLeafItems(previous.outlineData?.outline || [])) {
      if (item.content?.trim()) persistedContent[item.id] = item.content;
    }
    const mergedOutline = mapOutlineItems(outlineData.outline, (item) => {
      const restored = persistedContent[item.id];
      return restored ? { ...item, content: restored } : { ...item };
    });
    const nextOutlineData = { ...outlineData, outline: mergedOutline };
    const contentGenerationSections = buildContentSectionsFromOutline(nextOutlineData, previousSections);
    return updateBusinessBid({
      outlineData: nextOutlineData,
      contentGenerationSections,
      contentGenerationTask: null,
    });
  }

  function saveGlobalFacts(globalFacts) {
    const normalized = (Array.isArray(globalFacts) ? globalFacts : [])
      .filter((group) => String(group?.title || '').trim() && String(group?.content || '').trim())
      .map((group, index) => ({
        id: String(group?.id || `fact_${String(index + 1).padStart(3, '0')}`),
        title: String(group.title).trim(),
        content: String(group.content).trim(),
        updated_at: group?.updated_at || now(),
      }));
    const state = updateBusinessBid({
      globalFacts: normalized,
      contentGenerationTask: null,
      contentGenerationSections: {},
    });
    return state;
  }

  function saveContentGenerationOptions(options) {
    return updateBusinessBid({ contentGenerationOptions: options || null });
  }

  function normalizeClauseResponseStatus(value) {
    return ['已响应', '待确认', '需复核', '不满足'].includes(value) ? value : '待确认';
  }

  function saveClauseItems(clauseItems) {
    const normalized = (Array.isArray(clauseItems) ? clauseItems : [])
      .filter((item) => String(item?.id || '').trim() && String(item?.title || '').trim())
      .map((item, index) => ({
        id: String(item.id || `clause_${String(index + 1).padStart(2, '0')}`),
        category: String(item.category || '商务条款').trim(),
        title: String(item.title).trim(),
        requirement: String(item.requirement || '').trim(),
        response_status: normalizeClauseResponseStatus(item.response_status),
        response_detail: String(item.response_detail || '').trim(),
        deviation: String(item.deviation || '').trim(),
        isImportant: item?.isImportant === true,
      }));
    const clauseAnalysisTasks = {};
    normalized.forEach((item) => {
      clauseAnalysisTasks[item.id] = {
        id: item.id,
        label: `${item.category} / ${item.title}`,
        status: item.response_status === '已响应'
          ? 'success'
          : item.response_status === '不满足' ? 'error' : 'idle',
        content: [`招标要求：${item.requirement}`, `响应内容：${item.response_detail}`, `偏离说明：${item.deviation}`].filter(Boolean).join('\n'),
      };
    });
    const state = updateBusinessBid({
      clauseItems: normalized,
      clauseAnalysisTasks,
    });
    return state;
  }

  function saveChapterContent({ nodeId, content } = {}) {
    const state = readState();
    if (!state.outlineData?.outline?.length) {
      throw new Error('当前没有可保存的目录');
    }
    const nextContent = String(content || '');
    const updatedOutline = mapOutlineItems(state.outlineData.outline, (item) => (
      item.id === nodeId ? { ...item, content: nextContent } : { ...item }
    ));
    const outlineData = { ...state.outlineData, outline: updatedOutline };
    const section = state.contentGenerationSections?.[nodeId] || { id: nodeId, title: '' };
    const contentGenerationSections = {
      ...(state.contentGenerationSections || {}),
      [nodeId]: {
        ...section,
        id: nodeId,
        title: section.title || collectLeafItems(updatedOutline).find((item) => item.id === nodeId)?.title || '未命名章节',
        status: nextContent.trim() ? 'success' : 'idle',
        content: nextContent,
        updated_at: now(),
      },
    };
    const nextState = { ...state, outlineData, contentGenerationSections };
    writeState(nextState);
    return loadBusinessBid();
  }

  function clearBusinessBid() {
    if (fs.existsSync(tenderMarkdownPath)) {
      fs.rmSync(tenderMarkdownPath, { force: true });
    }
    if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true });
    }
    return { success: true, message: '商务标缓存已清空', state: loadBusinessBid() };
  }

  return {
    loadBusinessBid,
    readState,
    writeState,
    readTenderMarkdown,
    importTenderDocument,
    associateTechnicalPlan,
    disassociateTechnicalPlan,
    hasTechnicalPlan,
    updateStep,
    saveOutlineConfig,
    saveOutlineSelection,
    saveOutline,
    saveGlobalFacts,
    saveContentGenerationOptions,
    saveClauseItems,
    saveChapterContent,
    updateBusinessBid,
    clearBusinessBid,
  };
}

module.exports = {
  createBusinessBidStore,
};
