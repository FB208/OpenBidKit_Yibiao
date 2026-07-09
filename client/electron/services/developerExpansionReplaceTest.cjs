const {
  __developerContentExpansionPatchRuntime,
} = require('./contentGenerationTask.cjs');

const {
  normalizeContentExpansionPatch,
  validateContentExpansionPatch,
  buildContentExpansionRepairMessages,
  findContentExpansionTargetTextMatch,
  applyContentExpansionPatch,
} = __developerContentExpansionPatchRuntime;

function developerReplaceTestNormalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function developerReplaceTestCountOccurrences(content, needle) {
  const source = String(content || '');
  const target = String(needle || '');
  if (!target) return 0;

  let count = 0;
  let index = 0;
  while ((index = source.indexOf(target, index)) >= 0) {
    count += 1;
    index += Math.max(1, target.length);
  }
  return count;
}

function developerReplaceTestNormalizeFormalReplacePatch(value) {
  return normalizeContentExpansionPatch(value);
}

function developerReplaceTestValidateFormalReplacePatch(patch) {
  validateContentExpansionPatch(patch);
  if (patch.operation !== 'replace') {
    throw new Error(`正式替换逻辑测试要求 operation 必须为 replace，当前为 ${patch.operation || '空'}`);
  }
}

function developerReplaceTestBuildMessages(payload) {
  const sectionId = String(payload?.sectionId || '').trim() || 'unknown';
  const sectionTitle = String(payload?.sectionTitle || '').trim() || '未命名章节';
  const sectionDescription = String(payload?.sectionDescription || '').trim() || '未提供';
  const currentContent = String(payload?.content || '').trim();
  const selectedText = String(payload?.selectedText || '').trim();

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文扩写替换测试助手。此请求只用于开发者模式局部测试当前正式正文扩写 replace patch 逻辑，不会直接写入真实方案。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. operation 必须是 "replace"，不得返回 insert、append、rewrite_full 或其他操作。
3. target_text 必须逐字复制当前章节完整正文中的完整 Markdown 原文块。
4. target_text 必须覆盖“本次开发者测试指定要替换的目标块”。
5. 如果目标块是 Markdown 列表、表格、引用、加粗引导块或连续多行结构，target_text 必须包含完整结构，不得只返回第一项、表头、关键句或摘要。
6. target_text 不得改写标点、空格、换行、列表符号、表格分隔线或 Markdown 标记。
7. content 写对整个 target_text 替换并扩写后的正文片段，不要包含章节标题，不要输出完整章节正文。
8. 禁止输出图片 Markdown、Mermaid、代码块或其他图表代码。

返回格式：
{
  "operation": "replace",
  "target_text": "逐字复制的完整待替换 Markdown 原文块",
  "content": "替换并扩写后的正文片段"
}`,
    },
    { role: 'user', content: `当前章节：${sectionId} ${sectionTitle}\n章节描述：${sectionDescription}` },
    { role: 'user', content: `当前章节完整正文：\n${currentContent}` },
    { role: 'user', content: `本次开发者测试指定要替换的目标块：\n${selectedText}\n\n请只针对这个完整目标块生成正式 replace JSON。` },
  ];
}

function developerReplaceTestDiagnoseApplication(originalContent, patch, nextContent, applyError) {
  const normalizedOriginal = developerReplaceTestNormalizeNewlines(originalContent).trim();
  const normalizedNext = developerReplaceTestNormalizeNewlines(nextContent).trim();
  const matchResult = findContentExpansionTargetTextMatch(normalizedOriginal, patch.target_text);
  const match = matchResult.match || null;
  const matchedText = match ? normalizedOriginal.slice(match.start, match.end) : '';
  const contentOccurrencesBefore = developerReplaceTestCountOccurrences(normalizedOriginal, patch.content);
  const contentOccurrencesAfter = developerReplaceTestCountOccurrences(normalizedNext, patch.content);

  return {
    status: applyError ? 'blocked' : 'replace-success',
    targetTextMatched: Boolean(matchResult.unique && match),
    targetTextKey: String(patch.target_text || '').trim().replace(/\s+/g, ' ').trim(),
    matchStrategy: matchResult.strategy || '',
    matchStart: match ? match.start : -1,
    matchEnd: match ? match.end : -1,
    matchedText,
    candidateCount: matchResult.count || 0,
    contentOccurrencesBefore,
    contentOccurrencesAfter,
    charsBefore: normalizedOriginal.length,
    charsAfter: normalizedNext.length,
    deltaChars: normalizedNext.length - normalizedOriginal.length,
    error: applyError || matchResult.error || '',
  };
}

function createDeveloperExpansionReplaceTestService({ aiService }) {
  async function run(payload) {
    const originalContent = String(payload?.content || '').trim();
    const selectedText = String(payload?.selectedText || '').trim();
    if (!originalContent || !selectedText) {
      throw new Error('正式替换逻辑测试需要传入当前章节正文和待替换目标块');
    }

    const rawPatch = await aiService.collectJsonResponse({
      messages: developerReplaceTestBuildMessages(payload),
      temperature: 0.7,
      logTitle: `开发者正式扩写替换测试-${payload?.sectionId || 'unknown'}-${payload?.sectionTitle || '未命名章节'}`,
      progressLabel: '开发者正式扩写替换测试',
      failureMessage: '模型返回的正式扩写替换测试 JSON 无效',
      normalizer: developerReplaceTestNormalizeFormalReplacePatch,
      validator: developerReplaceTestValidateFormalReplacePatch,
      repairMessagesBuilder: (contextForRepair) => buildContentExpansionRepairMessages(contextForRepair, originalContent),
      max_retries: 1,
    });

    let nextContent = '';
    let applyError = '';
    try {
      nextContent = applyContentExpansionPatch(originalContent, rawPatch);
    } catch (error) {
      applyError = error?.message || String(error);
    }

    const diagnostics = developerReplaceTestDiagnoseApplication(originalContent, rawPatch, nextContent, applyError);
    return {
      success: !applyError,
      status: diagnostics.status,
      sectionId: String(payload?.sectionId || ''),
      sectionTitle: String(payload?.sectionTitle || ''),
      rawPatch,
      appliedPatch: rawPatch,
      diagnostics,
      applyError: applyError || undefined,
      originalContent,
      selectedText,
      nextContent,
    };
  }

  return { run };
}

module.exports = {
  createDeveloperExpansionReplaceTestService,
};
