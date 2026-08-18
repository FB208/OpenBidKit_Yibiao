const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const {
  analysisToMarkdown,
  buildAnalysisMergeSystemPrompt,
  buildAnalysisSystemPrompt,
  buildContentSystemPrompt,
  buildHumanWritingSystemPrompt,
  buildParametersSystemPrompt,
  formatProjectInfo,
} = require('./feasibilityReportPrompts.cjs');

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

function protectFacts(original, rewritten) {
  const source = String(original || '');
  const next = String(rewritten || '').trim();
  if (!next) return source;
  const markers = source.match(/【待补充】|【待确认】/g) || [];
  const nextMarkers = next.match(/【待补充】|【待确认】/g) || [];
  if (markers.length && nextMarkers.length < markers.length) return source;
  const quantities = source.match(/\d+(?:\.\d+)?\s*(?:万|亿|元|万元|亿元|%|％|年|个月|公里|千米|米|平方米|亩|吨|千瓦|兆瓦)?/g) || [];
  const missing = quantities.filter((token) => token && !next.includes(token.trim()));
  if (missing.length) return source;
  return next;
}

function buildKnowledgeBrief(items = []) {
  return (items || []).slice(0, 24).map((item) => `- ${item.title}：${item.resume}`).join('\n');
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
        { role: 'user', content: `项目参数：\n${projectBlock}\n\n资料：\n${sourceBlock}` },
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
        { role: 'user', content: JSON.stringify(parts) },
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

async function runFeasibilityParametersTask({ aiService, workspaceStore, updateTask, checkpointTask }) {
  const state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
  let logs = ['开始生成关键参数。'];
  updateTask({ progress: 12, logs });
  const titles = collectLeaves(state.outlineData.outline).map((item) => item.trail.join(' / ')).join('\n');
  const markdown = await aiService.chat({
    messages: [
      { role: 'system', content: buildParametersSystemPrompt() },
      {
        role: 'user',
        content: [
          `项目参数：\n${formatProjectInfo(state.projectInfo)}`,
          `资料分析：\n${state.analysisMarkdown}`,
          `目录叶子章节：\n${titles}`,
        ].join('\n\n'),
      },
    ],
    logTitle: '可研关键参数',
  });
  logs = [...logs, '关键参数已生成，已清空旧正文。'];
  checkpointTask({ status: 'success', progress: 100, logs }, {
    keyParametersMarkdown: String(markdown || '').trim(),
    outlineData: { ...state.outlineData, outline: clearContent(state.outlineData.outline) },
    contentTask: null,
    humanWritingTask: null,
  });
}

async function generateLeafContent({ aiService, state, leaf, knowledgeBrief, targetWords }) {
  return aiService.chat({
    messages: [
      { role: 'system', content: buildContentSystemPrompt() },
      {
        role: 'user',
        content: [
          `当前章节：${leaf.trail.join(' / ')}`,
          `写作重点：${leaf.description || '无'}`,
          `建议字数：约 ${targetWords} 字`,
          `项目参数：\n${formatProjectInfo(state.projectInfo)}`,
          `关键参数：\n${state.keyParametersMarkdown || '无'}`,
          `资料分析摘要：\n${String(state.analysisMarkdown || '').slice(0, 6000)}`,
          knowledgeBrief ? `知识库素材：\n${knowledgeBrief}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    logTitle: `可研正文-${leaf.title}`,
  });
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

async function rewriteLeafContent({ aiService, leaf }) {
  const rewritten = await aiService.chat({
    messages: [
      { role: 'system', content: buildHumanWritingSystemPrompt() },
      { role: 'user', content: leaf.content },
    ],
    logTitle: `可研审校-${leaf.title}`,
  });
  return protectFacts(leaf.content, rewritten);
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
  const references = knowledgeBaseService?.getOutlineReferences?.(state.referenceDocumentIds || []) || { items: [] };
  const knowledgeBrief = buildKnowledgeBrief(references.items);
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
          knowledgeBrief,
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
      outline = replaceLeafContent(outline, leaf.id, await rewriteLeafContent({ aiService, leaf: currentLeaf }));
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
    const rewritten = await aiService.chat({
      messages: [
        { role: 'system', content: buildHumanWritingSystemPrompt() },
        { role: 'user', content: leaf.content },
      ],
      logTitle: `可研审校-${leaf.title}`,
    });
    outline = replaceLeafContent(outline, leaf.id, protectFacts(leaf.content, rewritten));
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
