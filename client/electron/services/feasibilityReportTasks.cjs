const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const {
  analysisToMarkdown,
  buildAnalysisMergeSystemPrompt,
  buildAnalysisMergeUserInstruction,
  buildAnalysisSystemPrompt,
  buildAnalysisUserInstruction,
  buildContentSystemPrompt,
  buildContentWritingRules,
  buildHumanWritingSystemPrompt,
  buildParametersSystemPrompt,
  buildParametersUserInstruction,
  formatProjectInfo,
  renderOutlineForPrompt,
} = require('./feasibilityReportPrompts.cjs');
const { loadLightweightKnowledgeItems } = require('./feasibilityOutlineTask.cjs');

const PROTECTED_QUANTITY_PATTERN = /(?:\d+(?:\.\d+)?(?:\s*(?:-|～|~|至)\s*\d+(?:\.\d+)?)?\s*(?:亿元|万元|元|%|％|年|个月|月|日|天|小时|平方米|平方公里|亩|公里|米|千米|吨|千瓦时|千瓦|兆瓦|人|户|家|项|套|台|个|座|栋|层|次))/g;

function collectLeaves(items = [], trail = [], leaves = []) {
  for (const item of items || []) {
    const nextTrail = [...trail, item.title];
    if (item.children?.length) {
      collectLeaves(item.children, nextTrail, leaves);
    } else {
      leaves.push({ ...item, trail: nextTrail });
    }
  }
  return leaves;
}

function hasContent(item) {
  return Boolean(String(item?.content || '').trim());
}

function countProtectedWritingTokens(content) {
  const source = String(content || '');
  const counts = new Map();
  const quantities = source.match(PROTECTED_QUANTITY_PATTERN) || [];
  const markers = source.match(/【(?:待补充|待确认)】/g) || [];
  for (const token of [...quantities, ...markers]) {
    const normalized = token.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return counts;
}

function findMissingProtectedTokens(original, revised) {
  const originalCounts = countProtectedWritingTokens(original);
  const revisedCounts = countProtectedWritingTokens(revised);
  const missing = [];
  for (const [token, count] of originalCounts) {
    if ((revisedCounts.get(token) || 0) < count) missing.push(token);
  }
  return missing;
}

function protectFacts(original, rewritten) {
  const next = String(rewritten || '').trim();
  if (!next) return String(original || '');
  if (findMissingProtectedTokens(original, next).length) return String(original || '');
  return next;
}

function stripMarkdownFence(value) {
  return String(value || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function loadKnowledgeContentMap(knowledgeBaseService, documentIds) {
  const map = new Map();
  if (!knowledgeBaseService?.readReferences) return map;
  try {
    for (const reference of knowledgeBaseService.readReferences(documentIds || []) || []) {
      if (reference?.document?.status && reference.document.status !== 'success') continue;
      const documentId = String(reference?.document?.id || '').trim();
      for (const item of Array.isArray(reference?.items) ? reference.items : []) {
        const itemId = String(item?.id || '').trim();
        const content = String(item?.content || '').trim();
        if (!documentId || !itemId || !content) continue;
        map.set(`${documentId}::${itemId}`, {
          title: String(item.title || ''),
          resume: String(item.resume || ''),
          content,
        });
      }
    }
  } catch {
    return map;
  }
  return map;
}

function scoreKnowledge(item, chapter) {
  const query = `${chapter.title || ''}${chapter.description || ''}`;
  const target = `${item.title || ''}${item.resume || ''}`;
  const chars = [...new Set(query.replace(/[\s，。；：、（）()《》“”]/g, ''))];
  return chars.reduce((score, char) => score + (target.includes(char) ? 1 : 0), 0);
}

function selectKnowledgeContents(chapter, knowledgeMap) {
  const explicitIds = Array.isArray(chapter.knowledge_item_ids) ? chapter.knowledge_item_ids : [];
  const explicit = explicitIds.map((id) => knowledgeMap.get(id)).filter(Boolean);
  const selected = explicit.length
    ? explicit
    : Array.from(knowledgeMap.values())
      .map((item) => ({ item, score: scoreKnowledge(item, chapter) }))
      .filter((entry) => entry.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((entry) => entry.item);
  let used = 0;
  const blocks = [];
  for (const item of selected) {
    const block = `### ${item.title}\n\n${item.content}`.trim();
    if (used + block.length > 24000) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

async function runFeasibilityAnalysisTask({ aiService, workspaceStore, updateTask, checkpointTask }) {
  const state = workspaceStore.loadFeasibilityReport();
  const sources = String(workspaceStore.readCombinedSourceMarkdown() || '').trim();
  if (!state.projectInfo?.projectName) throw new Error('请先填写项目名称');

  let logs = [sources ? '开始分析项目资料。' : '未导入资料文件，仅根据项目参数分析。'];
  updateTask({ progress: 8, logs });
  const config = typeof aiService.getConfig === 'function' ? aiService.getConfig() : {};
  const segments = splitUserTextByContextLimit(sources, config);
  const system = buildAnalysisSystemPrompt();
  const projectBlock = formatProjectInfo(state.projectInfo);

  async function analyzeSegment(content, index, total) {
    logs = [...logs, total > 1 ? `正在分析第 ${index}/${total} 段资料。` : '正在提取资料事实。'];
    updateTask({ progress: 12 + Math.round((index - 1) / total * 50), logs });
    const sourceBlock = String(content || '').trim() || '未导入资料文件';
    return aiService.requestJson({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `项目基础参数：\n${projectBlock}\n\n当前资料分段：${index}/${total}\n\n${sourceBlock}` },
        { role: 'user', content: buildAnalysisUserInstruction(index, total) },
      ],
      progressLabel: '可研资料分析',
      failureMessage: '资料分析结果不是有效 JSON',
      logTitle: total > 1 ? `可研资料分析-第${index}段` : '可研资料分析',
    });
  }

  let payload;
  if (segments.length <= 1) {
    payload = await analyzeSegment(segments[0] || sources, 1, 1);
  } else {
    const parts = [];
    for (let index = 0; index < segments.length; index += 1) {
      parts.push(await analyzeSegment(segments[index], index + 1, segments.length));
    }
    logs = [...logs, '正在合并分段分析结果。'];
    updateTask({ progress: 72, logs });
    payload = await aiService.requestJson({
      messages: [
        { role: 'system', content: buildAnalysisMergeSystemPrompt() },
        { role: 'user', content: `项目基础参数：\n${projectBlock}\n\n分段分析结果：\n${JSON.stringify(parts, null, 2)}` },
        { role: 'user', content: buildAnalysisMergeUserInstruction() },
      ],
      progressLabel: '可研资料分析合并',
      failureMessage: '合并分析结果不是有效 JSON',
      logTitle: '可研资料分析合并',
    });
  }

  const analysisMarkdown = analysisToMarkdown(payload);
  logs = [...logs, '资料分析完成。'];
  checkpointTask({ status: 'success', progress: 100, logs }, {
    analysisMarkdown,
    outlineData: null,
    keyParametersMarkdown: '',
    outlineTask: null,
    outlineAdjustmentTask: null,
    parametersTask: null,
    contentTask: null,
    humanWritingTask: null,
  });
}

async function runFeasibilityParametersTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, checkpointTask }) {
  const state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
  let logs = ['正在提取可研报告关键参数与统一口径。'];
  updateTask({ progress: 12, logs });
  const knowledgeItems = loadLightweightKnowledgeItems(knowledgeBaseService, state.referenceDocumentIds || []);
  const markdown = await aiService.chat({
    messages: [
      { role: 'system', content: buildParametersSystemPrompt() },
      { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}\n\n项目资料分析：\n${state.analysisMarkdown}` },
      { role: 'user', content: `报告目录：\n${renderOutlineForPrompt(state.outlineData.outline)}` },
      { role: 'user', content: `知识库轻量条目：\n${knowledgeItems.length ? JSON.stringify(knowledgeItems, null, 2) : '未选择知识库'}` },
      { role: 'user', content: buildParametersUserInstruction() },
    ],
    logTitle: '可研关键参数',
  });
  logs = [...logs, '关键参数与编制口径生成完成，请人工核对待补充项。已清空旧正文。'];
  checkpointTask({ status: 'success', progress: 100, logs }, {
    keyParametersMarkdown: String(markdown || '').trim(),
    outlineData: { ...state.outlineData, outline: clearContent(state.outlineData.outline) },
    contentTask: null,
    humanWritingTask: null,
  });
}

async function generateLeafContent({ aiService, state, leaf, knowledge, targetWords }) {
  const chapterPath = (leaf.trail || []).join(' > ');
  const messages = [
    { role: 'system', content: buildContentSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}` },
    { role: 'user', content: `项目资料分析：\n${state.analysisMarkdown}` },
    { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
    {
      role: 'user',
      content: `当前章节路径：${chapterPath}\n章节写作重点：${leaf.description || '围绕章节标题展开充分论证。'}\n参考目标字数：约 ${targetWords} 字。`,
    },
  ];
  if (knowledge) {
    messages.push({
      role: 'user',
      content: `可吸收的知识库素材如下。请改写到本项目语境，不要提及“知识库”“历史文档”或资料来源：\n\n${knowledge}`,
    });
  }
  messages.push({ role: 'user', content: buildContentWritingRules() });
  const response = await aiService.chat({
    messages,
    logTitle: `可研正文-${leaf.title}`,
  });
  return stripMarkdownFence(response);
}

function replaceLeafContent(items, nodeId, content) {
  return (items || []).map((item) => {
    if (item.id === nodeId) return { ...item, content };
    if (!item.children?.length) return item;
    return { ...item, children: replaceLeafContent(item.children, nodeId, content) };
  });
}

function clearContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: '',
    children: item.children?.length ? clearContent(item.children) : item.children,
  }));
}

function isAiQueueScopePausedError(error) {
  return error?.code === 'AI_QUEUE_SCOPE_PAUSED';
}

function normalizeReviewedNodeIds(value) {
  return Array.isArray(value) ? value.map((id) => String(id || '').trim()).filter(Boolean) : [];
}

function contentProgress(phase, completed, total) {
  if (phase === 'done') return 100;
  const safeTotal = Math.max(total, 1);
  if (phase === 'human-writing') return Math.min(99, 70 + Math.round((completed / safeTotal) * 29));
  return Math.min(70, 5 + Math.round((completed / safeTotal) * 65));
}

async function rewriteLeafContent({ aiService, state, leaf }) {
  const chapterPath = (leaf.trail || []).join(' > ');
  const rewritten = await aiService.chat({
    messages: [
      { role: 'system', content: buildHumanWritingSystemPrompt() },
      { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}` },
      { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
      {
        role: 'user',
        content: `当前章节路径：${chapterPath}\n\n请只审校下面的已有正文。不得输出章节标题，不得补写资料中不存在的事实。\n\n${leaf.content}`,
      },
    ],
    logTitle: `可研审校-${leaf.title}`,
  });
  return protectFacts(leaf.content, stripMarkdownFence(rewritten));
}

async function runFeasibilityContentTask({
  aiService,
  workspaceStore,
  knowledgeBaseService,
  updateTask,
  checkpointTask,
  payload,
  taskControl,
  previousState,
}) {
  const resume = Boolean(payload?.onlyMissing || payload?.resume);
  const state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
  if (!String(state.keyParametersMarkdown || '').trim()) throw new Error('请先生成关键参数');
  const previousStats = resume ? (previousState?.contentTask?.stats || {}) : {};
  let phase = previousStats.phase === 'human-writing' && resume ? 'human-writing' : 'generating';
  let reviewedNodeIds = resume ? normalizeReviewedNodeIds(previousStats.reviewedNodeIds) : [];
  let outline = state.outlineData.outline;
  let logs = Array.isArray(previousState?.contentTask?.logs) && resume
    ? [...previousState.contentTask.logs]
    : [];
  let lastProgress = Math.max(0, Number(previousState?.contentTask?.progress || 0) || 0);
  const knowledgeMap = loadKnowledgeContentMap(knowledgeBaseService, state.referenceDocumentIds || []);
  const perLeafWords = Math.max(600, Math.round((state.targetWords || 30000) / Math.max(collectLeaves(outline).length, 1)));
  const leaves = () => collectLeaves(outline);
  const statsSnapshot = () => ({ phase, reviewedNodeIds: [...reviewedNodeIds] });
  const workspacePatch = () => ({ outlineData: { ...state.outlineData, outline } });

  const persistPaused = (message) => {
    logs = [...logs, message];
    checkpointTask({
      status: 'paused',
      progress: lastProgress || contentProgress(phase, 0, 1),
      logs,
      stats: statsSnapshot(),
      pause_requested: false,
    }, workspacePatch());
  };

  const shouldPause = () => Boolean(taskControl?.isPauseRequested?.());
  const throwIfAborted = () => {
    if (taskControl?.signal?.aborted) throw taskControl.signal.reason || new Error('正文生成已取消');
  };

  try {
    if (phase !== 'human-writing') {
      const targets = resume ? leaves().filter((item) => !hasContent(item)) : leaves();
      if (!logs.length) {
        logs = [resume && targets.length
          ? `补充生成 ${targets.length} 个未完成章节。`
          : targets.length
            ? `开始生成 ${targets.length} 个章节正文。`
            : '没有需要生成的章节，进入自然化审校。'];
      } else if (targets.length) {
        logs = [...logs, resume ? `继续生成 ${targets.length} 个未完成章节。` : `开始生成 ${targets.length} 个章节正文。`];
      }
      lastProgress = contentProgress('generating', 0, targets.length || 1);
      updateTask({ progress: lastProgress, logs, stats: statsSnapshot() });
      if (shouldPause()) {
        persistPaused('正文生成已暂停，可稍后继续。');
        return;
      }

      for (let index = 0; index < targets.length; index += 1) {
        throwIfAborted();
        if (shouldPause()) {
          persistPaused('正文生成已暂停，可稍后继续。');
          return;
        }
        const leaf = targets[index];
        logs = [...logs, `正在撰写：${leaf.title}`];
        lastProgress = contentProgress('generating', index, targets.length);
        updateTask({
          progress: lastProgress,
          logs,
          stats: statsSnapshot(),
        });
        const content = String(await generateLeafContent({
          aiService,
          state,
          leaf,
          knowledge: selectKnowledgeContents(leaf, knowledgeMap),
          targetWords: perLeafWords,
        }) || '').trim();
        outline = replaceLeafContent(outline, leaf.id, content);
        lastProgress = contentProgress('generating', index + 1, targets.length);
        checkpointTask({
          progress: lastProgress,
          logs,
          stats: statsSnapshot(),
        }, workspacePatch());
        if (shouldPause()) {
          persistPaused('正文生成已暂停，可稍后继续。');
          return;
        }
      }

      logs = [...logs, targets.length ? '正文生成完成，开始自然化审校。' : '开始自然化审校。'];
      phase = 'human-writing';
      lastProgress = contentProgress('human-writing', 0, Math.max(leaves().filter(hasContent).length, 1));
      checkpointTask({
        progress: lastProgress,
        logs,
        stats: statsSnapshot(),
      }, workspacePatch());
    } else {
      logs = [...logs, '继续自然化审校。'];
    }

    const reviewTargets = leaves().filter(hasContent).filter((item) => !reviewedNodeIds.includes(item.id));
    lastProgress = contentProgress('human-writing', reviewedNodeIds.length, Math.max(reviewTargets.length + reviewedNodeIds.length, 1));
    updateTask({
      progress: lastProgress,
      logs,
      stats: statsSnapshot(),
    });
    if (shouldPause()) {
      persistPaused('自然化审校已暂停，可稍后继续。');
      return;
    }

    const reviewTotal = reviewTargets.length + reviewedNodeIds.length;
    for (let index = 0; index < reviewTargets.length; index += 1) {
      throwIfAborted();
      if (shouldPause()) {
        persistPaused('自然化审校已暂停，可稍后继续。');
        return;
      }
      const leaf = reviewTargets[index];
      logs = [...logs, `正在审校：${leaf.title}`];
      lastProgress = contentProgress('human-writing', reviewedNodeIds.length, Math.max(reviewTotal, 1));
      updateTask({
        progress: lastProgress,
        logs,
        stats: statsSnapshot(),
      });
      const currentLeaf = collectLeaves(outline).find((item) => item.id === leaf.id) || leaf;
      outline = replaceLeafContent(outline, leaf.id, await rewriteLeafContent({ aiService, state, leaf: currentLeaf }));
      reviewedNodeIds = [...reviewedNodeIds, leaf.id];
      lastProgress = contentProgress('human-writing', reviewedNodeIds.length, Math.max(reviewTotal, 1));
      checkpointTask({
        progress: lastProgress,
        logs,
        stats: statsSnapshot(),
      }, workspacePatch());
      if (shouldPause()) {
        persistPaused('自然化审校已暂停，可稍后继续。');
        return;
      }
    }

    phase = 'done';
    logs = [...logs, reviewTargets.length || reviewedNodeIds.length ? '自然化审校完成。' : '没有需要审校的章节。'];
    checkpointTask({
      status: 'success',
      progress: 100,
      logs,
      stats: statsSnapshot(),
      pause_requested: false,
    }, workspacePatch());
  } catch (error) {
    if (isAiQueueScopePausedError(error)) {
      persistPaused(phase === 'human-writing'
        ? '自然化审校已暂停，未发起的 AI 请求已从队列丢弃，可稍后继续。'
        : '正文生成已暂停，未发起的 AI 请求已从队列丢弃，可稍后继续。');
      return;
    }
    throw error;
  }
}

async function runFeasibilityHumanWritingTask({ aiService, workspaceStore, updateTask, checkpointTask, taskControl }) {
  const state = workspaceStore.loadFeasibilityReport();
  const leaves = collectLeaves(state.outlineData?.outline || []).filter(hasContent);
  if (!leaves.length) throw new Error('请先生成正文，再进行自然化审校');
  let outline = state.outlineData.outline;
  let logs = [`开始审校 ${leaves.length} 个已生成章节。`];
  updateTask({ progress: 6, logs });
  for (let index = 0; index < leaves.length; index += 1) {
    if (taskControl?.signal?.aborted) throw taskControl.signal.reason || new Error('自然化审校已取消');
    const leaf = leaves[index];
    logs = [...logs, `正在审校：${leaf.title}`];
    updateTask({ progress: Math.round((index / leaves.length) * 90), logs });
    const rewritten = await rewriteLeafContent({ aiService, state, leaf });
    outline = replaceLeafContent(outline, leaf.id, rewritten);
    checkpointTask({ progress: Math.round(((index + 1) / leaves.length) * 90), logs }, {
      outlineData: { ...state.outlineData, outline },
    });
  }
  logs = [...logs, '自然化审校完成。'];
  checkpointTask({ status: 'success', progress: 100, logs }, {
    outlineData: { ...state.outlineData, outline },
  });
}

module.exports = {
  clearContent,
  runFeasibilityAnalysisTask,
  runFeasibilityParametersTask,
  runFeasibilityContentTask,
  runFeasibilityHumanWritingTask,
};
