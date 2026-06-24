const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');

function pushLog(logs, message) {
  logs.push(message);
  return logs.slice(-80);
}

function numberMarkdownLines(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line, index) => `L${String(index + 1).padStart(6, '0')} | ${line}`)
    .join('\n');
}

function normalizeLineRange(range, totalLines) {
  const startLine = Math.floor(Number(range?.startLine ?? range?.start_line ?? 0));
  const endLine = Math.floor(Number(range?.endLine ?? range?.end_line ?? 0));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine || startLine > totalLines || endLine > totalLines) {
    return null;
  }
  return {
    startLine,
    endLine,
    reason: range?.reason ? String(range.reason).trim() : undefined,
  };
}

function normalizeSectionTitle(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^第([一二三四五六七八九十壹贰叁肆伍\d]+)(标段|标包|分包|包)$/, '$1$2')
    .toLowerCase();
}

function getSectionMergeKey(section) {
  const titleKey = normalizeSectionTitle(section.title);
  if (titleKey) {
    return `${section.unit || '标段'}:${titleKey}`;
  }
  return `${section.unit || '标段'}:${section.index}`;
}

function mergeRanges(ranges) {
  const seen = new Set();
  return (ranges || [])
    .filter((range) => {
      const key = `${range.startLine}-${range.endLine}-${range.reason || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function getFirstRangeStart(section) {
  const ranges = mergeRanges(section.includeRanges || []);
  return ranges[0]?.startLine || Number.MAX_SAFE_INTEGER;
}

function normalizeSection(section, index, totalLines) {
  const title = String(section?.title || '').trim();
  if (!title) return null;
  const sectionIndex = Math.floor(Number(section?.index || index + 1));
  const ranges = (Array.isArray(section?.includeRanges) ? section.includeRanges : section?.include_ranges)
    || [];
  const includeRanges = ranges
    .map((range) => normalizeLineRange(range, totalLines))
    .filter(Boolean);
  return {
    id: String(section?.id || `section-${sectionIndex || index + 1}`).trim(),
    index: Number.isFinite(sectionIndex) && sectionIndex > 0 ? sectionIndex : index + 1,
    unit: String(section?.unit || '标段').trim() || '标段',
    title,
    headLine: String(section?.headLine || section?.head_line || '').trim(),
    description: String(section?.description || '').trim(),
    includeRanges,
    evidence: (Array.isArray(section?.evidence) ? section.evidence : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  };
}

function dedupeSections(sections) {
  const map = new Map();
  for (const section of sections) {
    const key = getSectionMergeKey(section);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...section });
      continue;
    }
    existing.includeRanges = mergeRanges([...(existing.includeRanges || []), ...(section.includeRanges || [])]);
    existing.evidence = [...new Set([...(existing.evidence || []), ...(section.evidence || [])])];
    if (!existing.headLine && section.headLine) existing.headLine = section.headLine;
    if (!existing.description && section.description) existing.description = section.description;
  }
  return Array.from(map.values())
    .map((section) => ({ ...section, includeRanges: mergeRanges(section.includeRanges) }))
    .filter((section) => section.includeRanges.length > 0)
    .sort((a, b) => getFirstRangeStart(a) - getFirstRangeStart(b) || a.index - b.index)
    .map((section, index) => ({ ...section, id: `section-${index + 1}` }));
}

function normalizeSectionsResponse(value, totalLines) {
  const sourceSections = Array.isArray(value?.sections) ? value.sections : [];
  const sections = dedupeSections(sourceSections
    .map((section, index) => normalizeSection(section, index, totalLines))
    .filter(Boolean));
  return {
    sections,
  };
}

function validateSectionsResponse(value) {
  if (!Array.isArray(value?.sections) || value.sections.length < 2) {
    throw new Error('未识别到至少两个有效标段');
  }
}

function buildExtractMessages(segment, segmentIndex, totalSegments) {
  return [
    {
      role: 'system',
      content: `你是严谨的招标文件多标段识别专家。你只能基于用户提供的带行号文本识别标段、标包、分包、采购包、包件或标的。`,
    },
    {
      role: 'user',
      content: `当前是招标文件第 ${segmentIndex}/${totalSegments} 段。每行格式为“L000001 | 原文”。

任务：识别本段中明确属于某个标段/标包/分包/采购包/包件/标的的内容，并返回结构化 JSON。

要求：
1. 只识别明确属于某个标段的内容范围。
2. 通用条款不要归入某个标段；不确定归属的内容不要输出范围。
3. includeRanges 必须使用输入中的真实行号，startLine 和 endLine 都是不带 L 前缀的数字。
4. 不要编造标段，不要补写原文没有的范围。
5. 无法提供有效 includeRanges 的候选不要输出到 sections。
6. 如果本段没有明确标段内容，返回 {"sections":[]}。
7. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

返回格式：
{
  "sections": [
    {
      "id": "section-1",
      "index": 1,
      "unit": "标段",
      "title": "一标段",
      "headLine": "一标段：设备采购及安装",
      "description": "设备采购、安装、调试及售后服务。",
      "includeRanges": [
        { "startLine": 120, "endLine": 180, "reason": "一标段采购清单" }
      ],
      "evidence": ["一标段：设备采购及安装"]
    }
  ]
}

带行号文本：
${segment}`,
    },
  ];
}

function buildMergeMessages(segmentResults) {
  return [
    {
      role: 'system',
      content: '你是严谨的招标文件多标段识别结果合并专家。你只能合并用户提供的分段识别结果，不得编造新标段或新行号。',
    },
    {
      role: 'user',
      content: `以下是同一份招标文件各分段识别出的标段候选。请合并重复标段，保留所有明确属于各标段的 includeRanges 和 evidence。

要求：
1. 同一标段跨多个分段出现时合并为一个 sections 项。
2. 不要把通用条款合并到任何标段。
3. 不要新增分段结果中没有的行号范围。
4. 如果最终少于两个标段，返回已有结果。
5. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

分段结果：
${JSON.stringify(segmentResults, null, 2)}`,
    },
  ];
}

async function collectJson(aiService, options) {
  if (aiService?.collectJsonResponse) {
    return aiService.collectJsonResponse(options);
  }
  if (aiService?.requestJson) {
    return aiService.requestJson(options);
  }
  throw new Error('AI 服务尚未初始化');
}

async function runBidSectionExtractionTask({ aiService, workspaceStore, updateTask }) {
  const originalMarkdown = workspaceStore.readOriginalTenderMarkdown?.() || workspaceStore.readTenderMarkdown();
  const cleanMarkdown = String(originalMarkdown || '').trim();
  if (!cleanMarkdown) {
    throw new Error('请先上传招标文件，再进行多标段识别');
  }

  if (typeof workspaceStore.prepareBidSectionExtraction === 'function') {
    workspaceStore.prepareBidSectionExtraction();
  }

  const logs = [];
  const log = (message, progress) => {
    const nextLogs = pushLog(logs, message);
    const state = workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSectionExtractionStatus: 'running',
      bidSectionExtractionError: undefined,
    });
    updateTask({ status: 'running', progress, logs: nextLogs }, state);
  };

  try {
    log('开始识别招标文件中的标段范围。', 5);
    const totalLines = cleanMarkdown.split(/\r?\n/).length;
    const numberedMarkdown = numberMarkdownLines(cleanMarkdown);
    const segments = splitUserTextByContextLimit(numberedMarkdown, typeof aiService.getConfig === 'function' ? aiService.getConfig() : {});
    const sourceSegments = segments.length ? segments : [numberedMarkdown];
    log(`招标文件已按上下文拆分为 ${sourceSegments.length} 段，正在提取标段候选。`, 12);

    const segmentResults = [];
    for (let index = 0; index < sourceSegments.length; index += 1) {
      const raw = await collectJson(aiService, {
        messages: buildExtractMessages(sourceSegments[index], index + 1, sourceSegments.length),
        temperature: 0.1,
        response_format: { type: 'json_object' },
        logTitle: `多标段识别-第${index + 1}段`,
        progressLabel: `多标段识别第${index + 1}段`,
      });
      segmentResults.push(normalizeSectionsResponse(raw, totalLines));
      log(`已完成第 ${index + 1}/${sourceSegments.length} 段标段候选提取。`, Math.min(80, 12 + Math.round(((index + 1) / sourceSegments.length) * 60)));
    }

    const mergedRaw = sourceSegments.length > 1
      ? await collectJson(aiService, {
        messages: buildMergeMessages(segmentResults),
        temperature: 0.1,
        response_format: { type: 'json_object' },
        logTitle: '多标段识别-候选合并',
        progressLabel: '多标段识别候选合并',
      })
      : segmentResults[0];
    const merged = normalizeSectionsResponse(mergedRaw, totalLines);
    validateSectionsResponse(merged);

    const finalState = workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSections: merged.sections,
      bidSectionExtractionStatus: 'success',
      bidSectionExtractionError: undefined,
    });
    const finalLogs = pushLog(logs, `已识别 ${merged.sections.length} 个标段，请选择本次投标范围。`);
    updateTask({ status: 'success', progress: 100, logs: finalLogs }, finalState);
  } catch (error) {
    const message = error instanceof Error ? error.message : '多标段识别失败';
    const failedState = workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    });
    updateTask({ status: 'error', progress: 100, error: message, logs: pushLog(logs, message) }, failedState);
    throw error;
  }
}

module.exports = {
  runBidSectionExtractionTask,
};
