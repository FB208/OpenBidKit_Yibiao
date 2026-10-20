const { buildExtractedProfile, buildExtractionMessages, findOmissions, locateFormatExcerpts, normalizeExtraction } = require('./blindCheckPresetExtraction.cjs');

function now() {
  return new Date().toISOString();
}

/**
 * 从招标文件生成暗标格式预设：读取招标文件（技术方案中已解析的正文，或现选文件按解析配置转换），
 * 本地定位格式条款片段后调用一次 AI，校验并核对原文，生成一份新的"我的预设"并选中。已有预设不覆盖。
 */
async function runBlindCheckPresetExtractionTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, taskControl }) {
  const fromFile = payload?.source === 'file';
  const logs = [fromFile ? '开始从所选招标文件提取格式要求。' : '开始从技术方案中的招标文件提取格式要求。'];
  const step = (progress, message) => {
    logs.push(message);
    updateTask({ status: 'running', progress, logs: [...logs] });
  };
  checkpointTask({ status: 'running', progress: 1, logs: [...logs] });

  step(5, fromFile ? '正在解析招标文件' : '正在读取技术方案中的招标文件');
  const tender = fromFile ? await workspaceStore.parseTenderFile(payload?.filePath) : workspaceStore.readTechnicalPlanTender();
  if (!tender.content.trim()) throw new Error('招标文件中没有可读取的文字');

  step(30, '正在定位格式条款');
  const located = locateFormatExcerpts(tender.content);
  if (!located.text) {
    throw new Error('未在招标文件中找到技术标排版要求（字体、字号、行距、页边距等）。如果是扫描版 PDF，请在设置中改用 MinerU 解析后重试');
  }

  step(40, `AI 正在提取格式要求（${located.excerpts.length} 个片段，${located.text.length} 字），通常需要 30 秒到 1 分钟`);
  const parsed = await aiService.collectJsonResponse({
    messages: buildExtractionMessages(located.text),
    response_format: { type: 'json_object' },
    logTitle: '暗标格式要求提取',
    progressLabel: '暗标格式要求提取',
    failureMessage: '从招标文件提取格式要求失败',
    max_retries: 2,
    signal: taskControl.signal,
  });

  step(85, '正在核对原文并生成预设');
  const extraction = normalizeExtraction(parsed, tender.content);
  const fieldCount = Object.keys(extraction.fields).length;
  if (!fieldCount) throw new Error('AI 未从招标文件片段中提取到可检查的格式要求，请核对招标文件是否包含技术标排版要求');
  const { profile, unspecified } = buildExtractedProfile(extraction);
  const unverified = Object.values(extraction.fields).filter((item) => !item.verified).length;
  // 只在发给 AI 的格式条款片段里找漏提，招标文件其他章节（商务标等）的同类字眼不算。
  const omissions = findOmissions(located.text, extraction);
  const preset = workspaceStore.createExtractedPreset({
    tenderName: tender.fileName,
    tenderContent: tender.content,
    profile,
    source: {
      version: 1,
      tenderName: tender.fileName,
      extractedAt: now(),
      fields: extraction.fields,
      unspecified,
      manual: extraction.manual,
      manualFields: extraction.manualFields,
      omissions,
      dropped: extraction.dropped,
      notes: extraction.notes,
    },
  });

  const summary = `已生成预设「${preset.name}」：提取 ${fieldCount} 项${unverified ? `，其中 ${unverified} 项未通过核对` : ''}${omissions.length ? `，另有 ${omissions.length} 条原文要求没有对应设置` : ''}，请逐项核对。`;
  checkpointTask({
    status: 'success',
    progress: 100,
    logs: [...logs, summary],
    error: undefined,
    stats: { presetId: preset.id, presetName: preset.name, fieldCount, unverified, omissions: omissions.length, fewFields: fieldCount < 3 },
  });
}

module.exports = {
  runBlindCheckPresetExtractionTask,
};
