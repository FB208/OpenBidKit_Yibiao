const crypto = require('node:crypto');
const { compactLogError, createNoopDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const { runInvalidBidAndRejectionItemsExtraction } = require('./bidAnalysisTask.cjs');

const checkRunStatus = ['idle', 'running', 'success', 'error'];
const typoExcerptRadius = 8;
const fullPromptLimitRatio = 0.6;
const rollingSegmentLimitRatio = 0.55;
const typoSegmentLimitRatio = 0.7;
const rollingSummaryEvidenceLimit = 60;
const rollingSummaryResolvedLimit = 40;
const rollingSummaryConfirmedLimit = 60;
const finalCandidateBatchSize = 20;

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function stripTripleQuoteWrapper(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function getBidDocumentIdFromItem(item, bidDocumentIds) {
  const candidates = [item.bidDocumentId, item.bid_document_id, item.documentId, item.document_id, item.fileId, item.file_id, item.sourceFile, item.source_file]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  for (const candidate of candidates) {
    if (bidDocumentIds.has(candidate)) return candidate;
  }
  return bidDocumentIds.size === 1 ? Array.from(bidDocumentIds)[0] : '';
}

function formatBidDocumentsForPrompt(input) {
  const documents = Array.isArray(input.bidDocuments) ? input.bidDocuments : [];
  return documents.map((document, index) => `【投标文件${index + 1}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n${document.content}`).join('\n\n--- 投标文件分隔线 ---\n\n');
}

function getArrayPayload(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function normalizeFindingType(value) {
  const raw = String(value || '').trim();
  if (raw === 'invalidBid' || raw.includes('无效')) return 'invalidBid';
  return 'rejectionItem';
}

function normalizeSeverity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw.includes('高')) return 'high';
  if (raw === 'low' || raw.includes('低')) return 'low';
  return 'medium';
}

function buildCommonRejectionCheckMessages(input) {
  const messages = [
    {
      role: 'user',
      content: `【废标项检查输入 v1｜检查项】
以下内容来自招标文件“无效投标”和“废标项”解析结果。后续任务必须优先基于这些检查口径，不要自行扩大到无法从电子投标文件判断的事项。

${input.invalidBidAndRejectionItems}`,
    },
  ];

  if (input.customCheckItems?.trim()) {
    messages.push({
      role: 'user',
      content: `【废标项检查输入 v1｜自定义检查项】
以下是用户补充的电子投标文件检查关注点。仅在能从电子投标文件正文、目录、附件文本或材料内容中判断时使用；如果涉及签字、盖章、密封、现场递交、纸质正副本等纸质或线下事项，必须忽略。

${input.customCheckItems.trim()}`,
    });
  }

  messages.push({
    role: 'user',
    content: `【废标项检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续每条风险必须明确返回所属 bidDocumentId，只能引用对应投标文件中可见的内容作为证据。

重要限制：当前原文由文本解析得到，图片、扫描件、截图、附件页等非文本内容可能已被过滤或无法完整呈现。检查材料缺失时，不得要求必须看到图片内容、扫描件正文或附件正文；如果投标文件中已经出现某项材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他可表明该材料已插入/已提交的结构性文本线索，应视为该材料至少存在提交线索。

${formatBidDocumentsForPrompt(input)}`,
  });

  return messages;
}

function buildRejectionCheckAnalysisMessages(input) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第一轮：分析】
请先分析检查范围，不要输出最终风险列表。

分析要求：
1. 梳理“无效投标”和“废标项”中哪些能通过电子投标文件内容判断。
2. 明确排除签字、盖章、密封、纸质正副本、现场递交、开标现场授权到场、纸质文件封装等纸质或线下事项。
3. 结合各投标文件目录和正文结构，指出重点核查章节、附件、报价、资格材料、技术/商务响应位置，并说明是否存在不同文件需要分别关注的风险。
4. 判断材料是否缺失时，先识别章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索等结构性文本线索；只要存在这类线索，就不能因为图片或扫描件正文不可见而判定缺失。
5. 如果某项检查需要外部事实、现场行为或纸质原件才能判断，标记为“不纳入电子文件检查”。
6. 仅输出分析结论，使用简体中文。`,
    },
  ];
}

function buildRejectionCheckInspectionMessages(input, analysis) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】
${analysis}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第二轮：检查】
请基于第一轮分析逐项检查所有电子投标文件，输出初步风险列表。

检查要求：
1. 每条风险必须有某一份投标文件中的明确证据，并写明 bidDocumentId；证据不足不要输出。
2. 不检查签字、盖章、密封、纸质正副本、现场递交、纸质原件等事项。
3. 重点关注实质性条款未响应、必要章节或附件缺失、资格材料明显缺失/过期、报价或关键承诺前后矛盾、技术/商务偏离未说明等电子正文可判断风险。
4. 判断“材料缺失”时，只有在目录、章节标题、附件标题、材料清单、正文、表格和其他结构性线索中均找不到对应材料痕迹，才可以输出疑似缺失；不得仅因图片内容、扫描件正文或附件正文不可见而输出缺失风险。
5. 如果投标文件中已有对应材料的结构性文本线索，应视为至少有提交线索，可提示人工复核内容完整性，但不要判定为缺失。
6. 区分风险类型：无效标使用 invalidBid，废标项使用 rejectionItem。
7. 暂不要求 JSON，可用结构化 Markdown 输出初步结果。`,
    },
  ];
}

function buildRejectionCheckFinalMessages(input, analysis, draftFindings) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】
${analysis}` },
    { role: 'user', content: `【废标项检查任务 v1｜第二轮初步检查结果】
${draftFindings}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第三轮：补充与定稿】
请对第二轮结果去重、合并、补漏，并删除不符合要求的条目，最终只输出 JSON。

定稿规则：
1. 只保留能从电子投标文件原文判断且有明确证据的风险。
2. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
3. 删除只有猜测、没有投标文件证据、或仅凭常识无法确认的条目。
4. 删除仅因图片内容、扫描件正文或附件正文不可见而产生的材料缺失条目；如果投标文件中存在对应材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他结构性文本线索，不得将该材料定稿为缺失。
5. 同一问题合并为一条，标题简短明确。
6. severity 只能是 high、medium、low；type 只能是 invalidBid 或 rejectionItem。
7. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：
{
  "findings": [
    {
      "bidDocumentId": "对应投标文件的 bidDocumentId，例如 bid-xxxx",
      "type": "invalidBid",
      "severity": "high",
      "title": "不超过 28 个中文字符的风险标题",
      "summary": "一句话概括风险",
      "requirement": "对应检查依据或招标要求，尽量引用原检查项",
      "bidEvidence": "投标文件中的明确证据、章节、原文摘录或缺失位置说明",
      "riskReason": "为什么该证据可能构成无效标或废标项风险",
      "suggestion": "建议用户如何处理或复核"
    }
  ]
}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildTypoCheckMessages(input) {
  return [
    { role: 'user', content: `【错别字检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能检查这些原文中真实存在的文字，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【错别字检查任务 v1】
请检查投标文件中的错别字、明显别字、同音错字、形近错字和明显录入错误，并输出 JSON。

检查要求：
1. 只输出你高度确信的错别字，不输出风格建议、标点偏好、表达优化或术语争议。
2. 每条必须来自某一份投标文件原文，wrongText 必须是原文中出现的原始错字或短词，bidDocumentId 必须是输入中提供的真实 ID。
3. correctText 是建议改成的正确字词。
4. originalExcerpt 尽量摘录包含 wrongText 的原文短片段，便于程序校验；不要改写原文。
5. 如果没有明确错别字，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","wrongText":"原文中的错别字或短词","correctText":"建议正确字词","originalExcerpt":"包含错别字的原文短片段","reason":"为什么判断为错别字"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

function buildLogicCheckMessages(input) {
  return [
    { role: 'user', content: `【逻辑谬误检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能基于这些投标文件内容进行逻辑一致性检查，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【逻辑谬误检查任务 v1】
请检查投标文件中的逻辑谬误和前后不一致问题，并输出 JSON。

检查范围：
1. 句子本身存在逻辑漏洞、因果不成立、条件互相矛盾或结论无法由前文推出。
2. 全文前后不一致，包括但不限于处理相同工作的人员名单、设备型号、工期、金额、数量、服务期限、项目名称、技术参数等应高度一致的内容前后不一致。

输出要求：
1. 只保留有明确文本依据的问题，避免泛泛而谈。
2. 问题可能涉及同一份投标文件内的多处原文，originalText 可摘录关键原文，locationHint 写明大概位置、章节、表格或上下文线索，bidDocumentId 必须是输入中提供的真实 ID。
3. title 必须简短明确，便于作为折叠列表标题。
4. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

function normalizeRejectionCheckFindings(parsed, bidDocuments) {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  return getArrayPayload(parsed, ['findings', 'items', 'risks'])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
      const title = normalizeText(item.title).slice(0, 80);
      const bidEvidence = normalizeText(item.bidEvidence || item.evidence || item.bid_evidence);
      const riskReason = normalizeText(item.riskReason || item.reason || item.risk_reason);
      return {
        id: normalizeText(item.id) || createId('rejection_finding'),
        bidDocumentId,
        type: normalizeFindingType(item.type),
        severity: normalizeSeverity(item.severity),
        title,
        summary: normalizeText(item.summary) || title,
        requirement: normalizeText(item.requirement || item.source) || '未明确引用具体检查依据，请人工复核。',
        bidEvidence,
        riskReason,
        suggestion: normalizeText(item.suggestion) || '请结合招标文件要求和投标文件原文人工复核后处理。',
      };
    })
    .filter((item) => item.bidDocumentId && item.title && item.bidEvidence && item.riskReason);
}

function findVerifiedTypoPosition(bidContent, wrongText, originalExcerpt, options = {}) {
  if (!wrongText) return -1;
  const segmentStartOffset = Number.isFinite(Number(options.segmentStartOffset))
    ? Math.max(0, Math.floor(Number(options.segmentStartOffset)))
    : 0;
  const segmentEndOffset = Number.isFinite(Number(options.segmentEndOffset))
    ? Math.min(bidContent.length, Math.max(segmentStartOffset, Math.floor(Number(options.segmentEndOffset))))
    : bidContent.length;
  if (segmentStartOffset > 0 || segmentEndOffset < bidContent.length) {
    const segmentContent = bidContent.slice(segmentStartOffset, segmentEndOffset);
    if (originalExcerpt) {
      const excerptIndex = segmentContent.indexOf(originalExcerpt);
      const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
      if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return segmentStartOffset + excerptIndex + wrongIndexInExcerpt;
    }
    const wrongIndexInSegment = segmentContent.indexOf(wrongText);
    if (wrongIndexInSegment >= 0) return segmentStartOffset + wrongIndexInSegment;
  }
  if (originalExcerpt) {
    const excerptIndex = bidContent.indexOf(originalExcerpt);
    const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
    if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return excerptIndex + wrongIndexInExcerpt;
  }
  return bidContent.indexOf(wrongText);
}

function createVerifiedTypoExcerpt(bidContent, position, wrongText) {
  let start = Math.max(0, position - typoExcerptRadius);
  let end = Math.min(bidContent.length, position + wrongText.length + typoExcerptRadius);
  const startTagOpen = bidContent.lastIndexOf('<', start);
  const startTagClose = bidContent.lastIndexOf('>', start);
  if (startTagOpen > startTagClose) {
    const tagEnd = bidContent.indexOf('>', start);
    if (tagEnd >= 0 && tagEnd < position) start = tagEnd + 1;
  }
  const endTagOpen = bidContent.lastIndexOf('<', end);
  const endTagClose = bidContent.lastIndexOf('>', end);
  if (endTagOpen > endTagClose) {
    const tagEnd = bidContent.indexOf('>', end);
    if (tagEnd >= 0) end = Math.min(bidContent.length, tagEnd + 1);
  }
  return bidContent.slice(start, end).trim();
}

function createLineLocationHint(bidContent, position) {
  const before = bidContent.slice(0, Math.max(0, position));
  return `原文第 ${before.split(/\r\n|\r|\n/).length} 行附近`;
}

function normalizeTypoCheckFindings(parsed, bidDocuments, options = {}) {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [];
  const bidDocumentIds = new Set(documents.map((document) => document.id).filter(Boolean));
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set();
  const findings = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'typos'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
    const bidDocument = documentMap.get(bidDocumentId);
    if (!bidDocument?.content) continue;
    const wrongText = normalizeText(item.wrongText || item.wrong_text || item.wrong || item.typo).slice(0, 60);
    const correctText = normalizeText(item.correctText || item.correct_text || item.correct || item.suggestion).slice(0, 60);
    const originalExcerpt = normalizeText(item.originalExcerpt || item.original_excerpt || item.excerpt || item.context);
    const reason = normalizeText(item.reason || item.riskReason || item.detail) || '疑似错别字，请结合原文复核。';
    if (!wrongText || !correctText || wrongText === correctText) continue;
    const position = findVerifiedTypoPosition(bidDocument.content, wrongText, originalExcerpt, options);
    if (position < 0) continue;
    const key = `${bidDocumentId}\u0000${wrongText}\u0000${correctText}\u0000${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      id: normalizeText(item.id) || createId('typo_finding'),
      bidDocumentId,
      wrongText,
      correctText,
      originalExcerpt: createVerifiedTypoExcerpt(bidDocument.content, position, wrongText),
      reason,
      locationHint: createLineLocationHint(bidDocument.content, position),
      position,
    });
  }
  return findings;
}

function normalizeLogicCheckFindings(parsed, bidDocuments) {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  const seen = new Set();
  const findings = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'risks', 'issues'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
    const title = normalizeText(item.title || item.summary).slice(0, 80);
    const originalText = normalizeText(item.originalText || item.original_text || item.evidence || item.bidEvidence) || '未提供明确原文摘录，请结合位置线索复核。';
    const locationHint = normalizeText(item.locationHint || item.location_hint || item.location || item.position) || '未明确具体位置，请结合原文摘录复核。';
    const fallacyReason = normalizeText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason);
    const suggestion = normalizeText(item.suggestion || item.recommendation) || '请结合投标文件上下文人工复核后修改。';
    if (!bidDocumentId || !title || !fallacyReason) continue;
    const key = `${bidDocumentId}\u0000${title}\u0000${fallacyReason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ id: normalizeText(item.id) || createId('logic_finding'), bidDocumentId, title, originalText, locationHint, fallacyReason, suggestion });
  }
  return findings;
}

function truncatePromptText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function getCurrentAiConfig(aiService) {
  try {
    return typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  } catch {
    return {};
  }
}

function shouldUseSegmentedPrompt(aiService, promptText, limitRatio = fullPromptLimitRatio) {
  const config = getCurrentAiConfig(aiService);
  return splitUserTextByContextLimit(promptText, config, { limitRatio }).length > 1;
}

function shouldUseSegmentedRejectionFlow(aiService, input) {
  return shouldUseSegmentedPrompt(
    aiService,
    [input.invalidBidAndRejectionItems, input.customCheckItems, formatBidDocumentsForPrompt(input)].join('\n\n'),
  );
}

function shouldUseSegmentedBidDocuments(aiService, bidDocuments) {
  return shouldUseSegmentedPrompt(aiService, formatBidDocumentsForPrompt({ bidDocuments }));
}

function createBidDocumentSegments(document, config, limitRatio) {
  const segments = splitUserTextByContextLimit(document.content, config, { limitRatio });
  let startOffset = 0;
  return segments.map((content, index) => {
    const endOffset = startOffset + content.length;
    const segment = {
      content,
      startOffset,
      endOffset,
      segmentIndex: index + 1,
      totalSegments: segments.length,
    };
    startOffset = endOffset;
    return segment;
  });
}

function createBidPackageSegments(bidDocuments, config, limitRatio) {
  const localSegments = [];
  for (const [documentIndex, document] of bidDocuments.entries()) {
    const documentLabel = getBidDocumentDisplayName(document, documentIndex);
    const segments = createBidDocumentSegments(document, config, limitRatio);
    for (const segment of segments) {
      localSegments.push({
        documentId: document.id,
        documentLabel,
        content: `【${documentLabel}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n【当前文件片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段】\n${segment.content}`,
      });
    }
  }

  return localSegments.map((segment, index) => ({
    ...segment,
    segmentIndex: index + 1,
    totalSegments: localSegments.length,
  }));
}

function createSegmentPromptDocument(document, segment) {
  return { ...document, content: segment.content };
}

function getBidDocumentDisplayName(document, documentIndex) {
  return `投标文件${documentIndex + 1}${document.fileName ? `（${document.fileName}）` : ''}`;
}

function formatBidDocumentIdList(bidDocuments) {
  return (Array.isArray(bidDocuments) ? bidDocuments : [])
    .map((document, index) => `- ${getBidDocumentDisplayName(document, index)}：${document.id}`)
    .join('\n');
}

function getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId = '') {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  return getBidDocumentIdFromItem(item, bidDocumentIds) || (bidDocumentIds.has(fallbackBidDocumentId) ? fallbackBidDocumentId : '');
}

function limitDedupeItems(items, maxCount, keyBuilder) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const key = normalizeText(keyBuilder(item)) || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxCount) break;
  }
  return result;
}

function dedupeItems(items, keyBuilder) {
  return limitDedupeItems(items, Number.MAX_SAFE_INTEGER, keyBuilder);
}

function normalizeRollingEvidenceItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const name = truncatePromptText(item.name || item.title || item.material || item.item || item.requirement, 80);
  const evidence = truncatePromptText(item.evidence || item.originalText || item.original_text || item.excerpt || item.content || item.description, 600);
  const locationHint = truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 160);
  const source = truncatePromptText(item.source || item.requirement || item.reason, 240);
  if (!name && !evidence) return null;
  return {
    bidDocumentId,
    name: name || truncatePromptText(evidence, 80),
    evidence,
    locationHint,
    source,
  };
}

function normalizeRollingRejectionRiskItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const title = truncatePromptText(item.title || item.summary || item.requirement, 80);
  if (!title) return null;
  return {
    bidDocumentId,
    type: normalizeFindingType(item.type),
    severity: normalizeSeverity(item.severity),
    title,
    summary: truncatePromptText(item.summary || title, 180),
    requirement: truncatePromptText(item.requirement || item.source, 360),
    bidEvidence: truncatePromptText(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncatePromptText(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeResolvedSummaryItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = truncatePromptText(item.title || item.summary || item.name, 100);
  const reason = truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360);
  if (!title && !reason) return null;
  return {
    title: title || truncatePromptText(reason, 100),
    reason,
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizePatchReferenceId(item, keys) {
  for (const key of keys) {
    const value = normalizeText(item?.[key]);
    if (value) return value;
  }
  return '';
}

function createSequentialStateId(prefix, sequence) {
  return `${prefix}_${String(sequence).padStart(4, '0')}`;
}

function assignRejectionEvidenceId(state, item) {
  const id = createSequentialStateId('evidence', state.nextEvidenceSeq);
  state.nextEvidenceSeq += 1;
  return { ...item, id };
}

function assignRejectionRiskId(state, item) {
  const id = createSequentialStateId('risk', state.nextRiskSeq);
  state.nextRiskSeq += 1;
  return { ...item, id };
}

function assignLogicFactId(state, item) {
  const id = createSequentialStateId('fact', state.nextFactSeq);
  state.nextFactSeq += 1;
  return { ...item, id };
}

function assignLogicIssueId(state, item) {
  const id = createSequentialStateId('issue', state.nextIssueSeq);
  state.nextIssueSeq += 1;
  return { ...item, id };
}

function normalizeRollingRejectionRiskUpdate(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'riskId', 'risk_id', 'pendingRiskId', 'pending_risk_id']);
  if (!id) return null;
  return {
    id,
    bidDocumentId: getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId),
    type: item.type ? normalizeFindingType(item.type) : undefined,
    severity: item.severity ? normalizeSeverity(item.severity) : undefined,
    title: truncatePromptText(item.title || item.summary || item.requirement, 80),
    summary: truncatePromptText(item.summary, 180),
    requirement: truncatePromptText(item.requirement || item.source, 360),
    bidEvidence: truncatePromptText(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncatePromptText(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingRejectionResolve(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'riskId', 'risk_id', 'pendingRiskId', 'pending_risk_id']);
  if (!id) return null;
  return {
    id,
    title: truncatePromptText(item.title || item.summary || item.name, 100),
    reason: truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizeRollingRejectionPatch(parsed, bidDocuments, fallbackBidDocumentId = '') {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const evidenceAdds = getArrayPayload(source, ['evidenceAdds', 'evidence_adds', 'submittedEvidenceAdds', 'submitted_evidence_adds', 'submittedEvidence', 'submitted_evidence'])
    .map((item) => normalizeRollingEvidenceItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskAdds = getArrayPayload(source, ['pendingRiskAdds', 'pending_risk_adds', 'pendingRisks', 'pending_risks'])
    .map((item) => normalizeRollingRejectionRiskItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskUpdates = getArrayPayload(source, ['pendingRiskUpdates', 'pending_risk_updates', 'riskUpdates', 'risk_updates'])
    .map((item) => normalizeRollingRejectionRiskUpdate(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskResolves = getArrayPayload(source, ['pendingRiskResolves', 'pending_risk_resolves', 'riskResolves', 'risk_resolves', 'resolvedRisks', 'resolved_risks'])
    .map(normalizeRollingRejectionResolve)
    .filter(Boolean);
  const confirmedRisks = normalizeRejectionCheckFindings({
    findings: getArrayPayload(source, ['confirmedRiskAdds', 'confirmed_risk_adds', 'confirmedRisks', 'confirmed_risks', 'confirmedFindings', 'confirmed_findings', 'findings']),
  }, bidDocuments);

  return { evidenceAdds, pendingRiskAdds, pendingRiskUpdates, pendingRiskResolves, confirmedRiskAdds: confirmedRisks };
}

function mergeDefinedFields(target, update, fields) {
  const next = { ...target };
  for (const field of fields) {
    if (update[field] !== undefined && update[field] !== '') {
      next[field] = update[field];
    }
  }
  return next;
}

function applyRollingRejectionPatch(state, patch) {
  const next = {
    ...state,
    submittedEvidence: [...state.submittedEvidence],
    pendingRisks: [...state.pendingRisks],
    resolvedRisks: [...state.resolvedRisks],
    confirmedRisks: [...state.confirmedRisks],
  };

  for (const item of patch.evidenceAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.name}\u0000${item.evidence}`;
    const exists = next.submittedEvidence.some((evidence) => `${evidence.bidDocumentId}\u0000${evidence.name}\u0000${evidence.evidence}` === key);
    if (!exists) next.submittedEvidence.push(assignRejectionEvidenceId(next, item));
  }

  for (const item of patch.pendingRiskAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.requirement}`;
    const exists = next.pendingRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.requirement}` === key)
      || next.confirmedRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.requirement}` === key);
    if (!exists) next.pendingRisks.push(assignRejectionRiskId(next, item));
  }

  for (const update of patch.pendingRiskUpdates || []) {
    next.pendingRisks = next.pendingRisks.map((risk) => risk.id === update.id
      ? mergeDefinedFields(risk, update, ['type', 'severity', 'title', 'summary', 'requirement', 'bidEvidence', 'riskReason', 'suggestion', 'statusReason'])
      : risk);
  }

  for (const resolve of patch.pendingRiskResolves || []) {
    const riskIndex = next.pendingRisks.findIndex((risk) => risk.id === resolve.id);
    if (riskIndex < 0) continue;
    const [risk] = next.pendingRisks.splice(riskIndex, 1);
    next.resolvedRisks.push({
      id: `resolved_${risk.id}`,
      riskId: risk.id,
      title: resolve.title || risk.title,
      reason: resolve.reason || '后续片段已提供线索，原待确认风险被排除。',
      locationHint: resolve.locationHint || risk.locationHint,
    });
  }

  for (const item of patch.confirmedRiskAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}`;
    const exists = next.confirmedRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.bidEvidence}` === key);
    if (!exists) next.confirmedRisks.push(assignRejectionRiskId(next, item));
  }

  return {
    ...next,
    submittedEvidence: dedupeItems(next.submittedEvidence, (item) => `${item.bidDocumentId}\u0000${item.name}\u0000${item.evidence}`),
    pendingRisks: dedupeItems(next.pendingRisks, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.requirement}`),
    resolvedRisks: dedupeItems(next.resolvedRisks, (item) => `${item.title}\u0000${item.reason}`),
    confirmedRisks: dedupeItems(next.confirmedRisks, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}`),
  };
}

function createEmptyRollingRejectionState() {
  return {
    nextEvidenceSeq: 1,
    nextRiskSeq: 1,
    submittedEvidence: [],
    pendingRisks: [],
    resolvedRisks: [],
    confirmedRisks: [],
  };
}

function normalizeLogicFactItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const category = truncatePromptText(item.category || item.type || item.field || '关键事实', 60);
  const name = truncatePromptText(item.name || item.title || item.fieldName || item.field_name, 100);
  const value = truncatePromptText(item.value || item.fact || item.content || item.description, 500);
  const evidence = truncatePromptText(item.evidence || item.originalText || item.original_text || item.excerpt, 500);
  const locationHint = truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 160);
  if (!name && !value && !evidence) return null;
  return {
    bidDocumentId,
    category,
    name: name || truncatePromptText(value || evidence, 100),
    value,
    evidence,
    locationHint,
  };
}

function normalizeRollingLogicIssueItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const title = truncatePromptText(item.title || item.summary || item.name, 80);
  const fallacyReason = truncatePromptText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600);
  if (!title && !fallacyReason) return null;
  return {
    bidDocumentId,
    title: title || truncatePromptText(fallacyReason, 80),
    originalText: truncatePromptText(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason,
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingLogicIssueUpdate(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'issueId', 'issue_id', 'pendingIssueId', 'pending_issue_id']);
  if (!id) return null;
  return {
    id,
    bidDocumentId: getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId),
    title: truncatePromptText(item.title || item.summary || item.name, 80),
    originalText: truncatePromptText(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason: truncatePromptText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingLogicResolve(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'issueId', 'issue_id', 'pendingIssueId', 'pending_issue_id']);
  if (!id) return null;
  return {
    id,
    title: truncatePromptText(item.title || item.summary || item.name, 100),
    reason: truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizeRollingLogicPatch(parsed, bidDocuments, fallbackBidDocumentId = '') {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const factAdds = getArrayPayload(source, ['factAdds', 'fact_adds', 'factRegisterAdds', 'fact_register_adds', 'facts', 'factRegister', 'fact_register'])
    .map((item) => normalizeLogicFactItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueAdds = getArrayPayload(source, ['pendingIssueAdds', 'pending_issue_adds', 'pendingIssues', 'pending_issues'])
    .map((item) => normalizeRollingLogicIssueItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueUpdates = getArrayPayload(source, ['pendingIssueUpdates', 'pending_issue_updates', 'issueUpdates', 'issue_updates'])
    .map((item) => normalizeRollingLogicIssueUpdate(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueResolves = getArrayPayload(source, ['pendingIssueResolves', 'pending_issue_resolves', 'issueResolves', 'issue_resolves', 'resolvedIssues', 'resolved_issues'])
    .map(normalizeRollingLogicResolve)
    .filter(Boolean);
  const confirmedIssues = normalizeLogicCheckFindings({
    findings: getArrayPayload(source, ['confirmedIssueAdds', 'confirmed_issue_adds', 'confirmedIssues', 'confirmed_issues', 'confirmedFindings', 'confirmed_findings', 'findings']),
  }, bidDocuments);

  return { factAdds, pendingIssueAdds, pendingIssueUpdates, pendingIssueResolves, confirmedIssueAdds: confirmedIssues };
}

function applyRollingLogicPatch(state, patch) {
  const next = {
    ...state,
    factRegister: [...state.factRegister],
    pendingIssues: [...state.pendingIssues],
    resolvedIssues: [...state.resolvedIssues],
    confirmedIssues: [...state.confirmedIssues],
  };

  for (const item of patch.factAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.category}\u0000${item.name}\u0000${item.value}`;
    const exists = next.factRegister.some((fact) => `${fact.bidDocumentId}\u0000${fact.category}\u0000${fact.name}\u0000${fact.value}` === key);
    if (!exists) next.factRegister.push(assignLogicFactId(next, item));
  }

  for (const item of patch.pendingIssueAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`;
    const exists = next.pendingIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key)
      || next.confirmedIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key);
    if (!exists) next.pendingIssues.push(assignLogicIssueId(next, item));
  }

  for (const update of patch.pendingIssueUpdates || []) {
    next.pendingIssues = next.pendingIssues.map((issue) => issue.id === update.id
      ? mergeDefinedFields(issue, update, ['title', 'originalText', 'locationHint', 'fallacyReason', 'suggestion', 'statusReason'])
      : issue);
  }

  for (const resolve of patch.pendingIssueResolves || []) {
    const issueIndex = next.pendingIssues.findIndex((issue) => issue.id === resolve.id);
    if (issueIndex < 0) continue;
    const [issue] = next.pendingIssues.splice(issueIndex, 1);
    next.resolvedIssues.push({
      id: `resolved_${issue.id}`,
      issueId: issue.id,
      title: resolve.title || issue.title,
      reason: resolve.reason || '后续片段已解释或修正，原待确认问题被排除。',
      locationHint: resolve.locationHint || issue.locationHint,
    });
  }

  for (const item of patch.confirmedIssueAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`;
    const exists = next.confirmedIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key);
    if (!exists) next.confirmedIssues.push(assignLogicIssueId(next, item));
  }

  return {
    ...next,
    factRegister: dedupeItems(next.factRegister, (item) => `${item.bidDocumentId}\u0000${item.category}\u0000${item.name}\u0000${item.value}`),
    pendingIssues: dedupeItems(next.pendingIssues, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`),
    resolvedIssues: dedupeItems(next.resolvedIssues, (item) => `${item.title}\u0000${item.reason}`),
    confirmedIssues: dedupeItems(next.confirmedIssues, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`),
  };
}

function createEmptyRollingLogicState() {
  return {
    nextFactSeq: 1,
    nextIssueSeq: 1,
    factRegister: [],
    pendingIssues: [],
    resolvedIssues: [],
    confirmedIssues: [],
  };
}

function dedupeRejectionFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}\u0000${item.riskReason}`);
}

function dedupeTypoFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => {
    const position = Number(item.position);
    const positionKey = Number.isFinite(position) ? String(Math.floor(position)) : `${item.locationHint || ''}\u0000${item.originalExcerpt || ''}`;
    return `${item.bidDocumentId}\u0000${item.wrongText}\u0000${item.correctText}\u0000${positionKey}`;
  });
}

function dedupeLogicFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.locationHint}\u0000${item.fallacyReason}`);
}

function takeRecentItems(items, limit) {
  const source = Array.isArray(items) ? items : [];
  return source.slice(Math.max(0, source.length - limit));
}

function createRollingRejectionStateSummary(state) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidence: takeRecentItems(state.submittedEvidence, rollingSummaryEvidenceLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncatePromptText(item.evidence, 220),
      locationHint: item.locationHint,
      source: truncatePromptText(item.source, 160),
    })),
    pendingRisks: state.pendingRisks.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      requirement: truncatePromptText(item.requirement, 220),
      bidEvidence: truncatePromptText(item.bidEvidence, 260),
      riskReason: truncatePromptText(item.riskReason, 260),
      statusReason: truncatePromptText(item.statusReason, 180),
    })),
    resolvedRisks: takeRecentItems(state.resolvedRisks, rollingSummaryResolvedLimit),
    confirmedRisks: takeRecentItems(state.confirmedRisks, rollingSummaryConfirmedLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      bidEvidence: truncatePromptText(item.bidEvidence, 260),
      riskReason: truncatePromptText(item.riskReason, 260),
    })),
  };
}

function createRollingLogicStateSummary(state) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegister: takeRecentItems(state.factRegister, rollingSummaryEvidenceLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncatePromptText(item.value, 220),
      evidence: truncatePromptText(item.evidence, 220),
      locationHint: item.locationHint,
    })),
    pendingIssues: state.pendingIssues.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncatePromptText(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncatePromptText(item.fallacyReason, 260),
      statusReason: truncatePromptText(item.statusReason, 180),
    })),
    resolvedIssues: takeRecentItems(state.resolvedIssues, rollingSummaryResolvedLimit),
    confirmedIssues: takeRecentItems(state.confirmedIssues, rollingSummaryConfirmedLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncatePromptText(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncatePromptText(item.fallacyReason, 260),
    })),
  };
}

function createFinalRejectionStateSummary(state) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidenceIndex: state.submittedEvidence.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncatePromptText(item.evidence, 180),
      locationHint: item.locationHint,
      source: truncatePromptText(item.source, 120),
    })),
    resolvedRisks: state.resolvedRisks.map((item) => ({
      id: item.id,
      riskId: item.riskId,
      title: item.title,
      reason: truncatePromptText(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

function createFinalLogicStateSummary(state) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegisterIndex: state.factRegister.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncatePromptText(item.value, 180),
      evidence: truncatePromptText(item.evidence, 180),
      locationHint: item.locationHint,
    })),
    resolvedIssues: state.resolvedIssues.map((item) => ({
      id: item.id,
      issueId: item.issueId,
      title: item.title,
      reason: truncatePromptText(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

function chunkItems(items, batchSize) {
  const result = [];
  const source = Array.isArray(items) ? items : [];
  for (let index = 0; index < source.length; index += batchSize) {
    result.push(source.slice(index, index + batchSize));
  }
  return result;
}

function createRejectionFinalCandidates(state) {
  return [
    ...state.confirmedRisks.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingRisks.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
}

function createLogicFinalCandidates(state) {
  return [
    ...state.confirmedIssues.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingIssues.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
}

function buildRollingRejectionBaseMessages(input) {
  const messages = [
    {
      role: 'user',
      content: `【废标项滚动检查输入｜检查依据】
以下内容来自招标文件“无效投标”和“废标项”解析结果。必须优先基于这些检查口径，不要自行扩大到无法从电子投标文件判断的事项。

${input.invalidBidAndRejectionItems}`,
    },
  ];

  if (input.customCheckItems?.trim()) {
    messages.push({
      role: 'user',
      content: `【废标项滚动检查输入｜自定义检查项】
以下是用户补充的电子投标文件检查关注点。仅在能从电子投标文件正文、目录、附件文本或材料内容中判断时使用；如果涉及签字、盖章、密封、现场递交、纸质正副本等纸质或线下事项，必须忽略。

${input.customCheckItems.trim()}`,
    });
  }

  return messages;
}

function buildRollingRejectionSegmentMessages(input, segment, stateSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项滚动检查｜当前状态摘要】
你正在按顺序审阅同一个投标包。完整权威状态由程序维护，你只能基于当前片段返回增量 patch。
下面是前序片段累计状态的精简摘要；如需更新或排除 pendingRisks，只能引用摘要中已有的 id。

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项滚动检查｜当前投标包片段】
投标包片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段
当前片段所属文件：${segment.documentLabel}
当前片段默认 bidDocumentId：${segment.documentId}

本投标包有效 bidDocumentId：
${bidDocumentIdList}

重要限制：当前内容只是整个投标包的一段，不是全部投标文件。不得因为当前段或当前文件没有出现某项材料、附件、承诺或响应，就确认该材料缺失；这类问题只能先放入 pendingRisks，后续片段或其他投标文件可能会补充或推翻。

${segment.content}`,
    },
    {
      role: 'user',
      content: `【废标项滚动检查任务】
请基于当前片段输出增量 patch，只输出 JSON。不要返回完整累计状态，程序会负责合并和保留历史状态。

Patch 要求：
1. evidenceAdds 只放当前片段新增的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索、承诺或响应线索。
2. pendingRiskAdds 只放当前片段发现、但需要后续片段或其他文件继续确认的问题。
3. pendingRiskUpdates 只能引用状态摘要中 pendingRisks 的 id，用于补充或修正该待确认项。
4. pendingRiskResolves 只能引用状态摘要中 pendingRisks 的 id；如果当前片段证明某个“缺失/未响应”不成立，就在这里给出排除原因。
5. confirmedRiskAdds 只放当前片段或累计摘要已经提供明确投标文件证据，且不依赖纸质、线下或外部事实的风险。
6. 不检查签字、盖章、密封、纸质正副本、现场递交、纸质原件等事项。
7. 每条风险、证据和事实必须保留 bidDocumentId，且只能使用上方有效 bidDocumentId；如果当前片段没有明确切换文件，默认使用 ${segment.documentId}。

JSON 格式：
{
  "evidenceAdds": [{"bidDocumentId":"有效 bidDocumentId","name":"材料或响应线索名称","evidence":"原文线索或摘要","locationHint":"章节/表格/位置线索","source":"对应检查项或说明"}],
  "pendingRiskAdds": [{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"medium","title":"待确认问题","summary":"摘要","requirement":"检查依据","bidEvidence":"当前证据或缺口","riskReason":"为什么需要继续确认","suggestion":"建议","statusReason":"仍需后续片段确认的原因"}],
  "pendingRiskUpdates": [{"id":"pendingRisks 中已有 id","bidEvidence":"补充证据或缺口","riskReason":"更新原因","statusReason":"当前仍需确认的原因"}],
  "pendingRiskResolves": [{"id":"pendingRisks 中已有 id","reason":"被当前片段或累计线索排除的原因","locationHint":"位置线索"}],
  "confirmedRiskAdds": [{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"风险标题","summary":"摘要","requirement":"检查依据","bidEvidence":"明确投标文件证据","riskReason":"风险原因","suggestion":"建议"}]
}`,
    },
  ];
}

function buildRejectionFinalBatchMessages(input, candidates, stateSummary, batchIndex, totalBatches) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项最终定稿｜状态摘要】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项最终定稿｜候选批次 ${batchIndex}/${totalBatches}】
请只基于下面这一批候选输出最终废标项检查结果，只输出 JSON。

候选风险：
${JSON.stringify(candidates, null, 2)}

定稿规则：
1. 只保留能从电子投标文件原文或累计状态判断且有明确证据的风险。
2. candidateStatus 为 pending 且仍未形成完整证据闭环的问题不得输出为最终风险。
3. 如果某项“缺失/未响应”已经在 submittedEvidenceIndex 中出现章节、目录、附件标题、材料清单、表格条目、页码线索、图片占位线索或其他提交线索，不能定稿为缺失。
4. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
5. 同一问题合并为一条，bidDocumentId 必须来自上方有效 bidDocumentId。
6. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"不超过 28 个中文字符的风险标题","summary":"一句话概括风险","requirement":"对应检查依据或招标要求","bidEvidence":"投标文件中的明确证据、章节、原文摘录或缺失位置说明","riskReason":"为什么该证据可能构成无效标或废标项风险","suggestion":"建议用户如何处理或复核"}]}`,
    },
  ];
}

function buildRejectionGlobalMergeMessages(input, findings, finalSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项全局合稿｜证据索引】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

以下是 Main 侧维护的全量精简状态索引，用于跨批次去重、排除误判和避免早期证据丢失：
${JSON.stringify(finalSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项全局合稿任务】
以下 findings 来自多个候选批次的初步定稿结果。请进行全局合稿，只输出最终 JSON。

待合稿 findings：
${JSON.stringify({ findings }, null, 2)}

合稿规则：
1. 合并跨批次重复或高度相似的风险，保留证据更明确、表述更完整的一条。
2. 如果 submittedEvidenceIndex 已经出现对应材料、章节、附件标题、目录、表格、页码线索、图片占位线索或其他提交线索，不得把该材料定稿为缺失。
3. 删除 resolvedRisks 已排除或证据不足的风险。
4. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
5. bidDocumentId 必须来自上方有效 bidDocumentId。
6. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"不超过 28 个中文字符的风险标题","summary":"一句话概括风险","requirement":"对应检查依据或招标要求","bidEvidence":"投标文件中的明确证据、章节、原文摘录或缺失位置说明","riskReason":"为什么该证据可能构成无效标或废标项风险","suggestion":"建议用户如何处理或复核"}]}`,
    },
  ];
}

function buildRollingLogicSegmentMessages(input, segment, stateSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误滚动检查｜当前累计状态】
你正在按顺序审阅同一个投标包。完整权威状态由程序维护，你只能基于当前片段返回增量 patch。
下面是前序片段累计状态的精简摘要；如需更新或排除 pendingIssues，只能引用摘要中已有的 id。

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误滚动检查｜当前投标包片段】
投标包片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段
当前片段所属文件：${segment.documentLabel}
当前片段默认 bidDocumentId：${segment.documentId}

本投标包有效 bidDocumentId：
${bidDocumentIdList}

重要限制：当前内容只是整个投标包的一段，不是全部投标文件。前文或其他文件中的疑似矛盾可能会被后续片段解释，当前段也可能修正前文状态。不得仅凭当前段缺少解释就直接定稿为逻辑谬误。

${segment.content}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误滚动检查任务】
请基于当前片段输出增量 patch，只输出 JSON。不要返回完整累计状态，程序会负责合并和保留历史状态。

Patch 要求：
1. factAdds 只放当前片段新增的关键事实，包括人员、设备型号、工期、金额、数量、服务期限、项目名称、技术参数、承诺、资质有效期等。
2. pendingIssueAdds 只放当前片段与状态摘要比对后发现、但仍需后续确认的疑似前后不一致问题。
3. pendingIssueUpdates 只能引用状态摘要中 pendingIssues 的 id，用于补充或修正该待确认问题。
4. pendingIssueResolves 只能引用状态摘要中 pendingIssues 的 id；如果当前片段解释或修正了某个疑似问题，就在这里给出排除原因。
5. confirmedIssueAdds 只放证据明确、无法由上下文解释或修正的问题。
6. 每条事实和问题必须保留 bidDocumentId，且只能使用上方有效 bidDocumentId；如果当前片段没有明确切换文件，默认使用 ${segment.documentId}。

JSON 格式：
{
  "factAdds": [{"bidDocumentId":"有效 bidDocumentId","category":"事实类型","name":"事实名称","value":"事实值","evidence":"原文摘录或摘要","locationHint":"章节/表格/位置线索"}],
  "pendingIssueAdds": [{"bidDocumentId":"有效 bidDocumentId","title":"待确认问题","originalText":"相关原文摘录","locationHint":"位置线索","fallacyReason":"疑似矛盾原因","suggestion":"建议","statusReason":"仍需后续片段确认的原因"}],
  "pendingIssueUpdates": [{"id":"pendingIssues 中已有 id","originalText":"补充原文","fallacyReason":"更新原因","statusReason":"当前仍需确认的原因"}],
  "pendingIssueResolves": [{"id":"pendingIssues 中已有 id","reason":"被当前片段或累计线索排除的原因","locationHint":"位置线索"}],
  "confirmedIssueAdds": [{"bidDocumentId":"有效 bidDocumentId","title":"问题标题","originalText":"关键原文摘录","locationHint":"位置线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]
}`,
    },
  ];
}

function buildLogicFinalBatchMessages(input, candidates, stateSummary, batchIndex, totalBatches) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误最终定稿｜状态摘要】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误最终定稿｜候选批次 ${batchIndex}/${totalBatches}】
请只基于下面这一批候选输出最终逻辑谬误检查结果，只输出 JSON。

候选问题：
${JSON.stringify(candidates, null, 2)}

定稿规则：
1. 只保留有明确投标文件证据、无法由上下文解释或修正的问题。
2. candidateStatus 为 pending 且仍未形成完整证据闭环的问题不得输出为最终问题。
3. 如果 resolvedIssues 或 factRegisterIndex 已经说明疑似矛盾不成立，必须删除。
4. 同一问题合并为一条，bidDocumentId 必须来自上方有效 bidDocumentId。
5. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}`,
    },
  ];
}

function buildLogicGlobalMergeMessages(input, findings, finalSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误全局合稿｜事实索引】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

以下是 Main 侧维护的全量精简状态索引，用于跨批次去重、排除误判和避免早期事实丢失：
${JSON.stringify(finalSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误全局合稿任务】
以下 findings 来自多个候选批次的初步定稿结果。请进行全局合稿，只输出最终 JSON。

待合稿 findings：
${JSON.stringify({ findings }, null, 2)}

合稿规则：
1. 合并跨批次重复或高度相似的逻辑问题，保留证据更明确、表述更完整的一条。
2. 如果 factRegisterIndex 或 resolvedIssues 已经解释、修正或排除了疑似矛盾，不得保留。
3. 只保留有明确投标文件证据、无法由上下文解释或修正的问题。
4. bidDocumentId 必须来自上方有效 bidDocumentId。
5. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}`,
    },
  ];
}

function createRejectionDeveloperLogger(aiService, name, meta = {}) {
  try {
    return aiService?.createDeveloperLogger?.('rejection-check', { name, meta }) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
}

function summarizeFindingsForLog(kind, findings = []) {
  const result = {
    kind,
    count: findings.length,
  };
  if (kind === 'rejection') {
    result.by_type = findings.reduce((counts, item) => {
      const type = item.type || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
    result.by_severity = findings.reduce((counts, item) => {
      const severity = item.severity || 'unknown';
      counts[severity] = (counts[severity] || 0) + 1;
      return counts;
    }, {});
  }
  return result;
}

async function runText(aiService, request, _onProgress, label) {
  const content = await aiService.chat({
    ...request,
    logTitle: request.logTitle || request.log_title || label,
  });
  if (!content.trim()) {
    throw new Error(`${label}未返回内容`);
  }
  return content;
}

async function runJson(aiService, request, onProgress, _label) {
  const jsonRequest = {
    ...request,
    response_format: request.response_format || { type: 'json_object' },
    progressCallback: request.progressCallback || onProgress,
    logTitle: request.logTitle || request.log_title || request.progressLabel || _label,
  };
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(jsonRequest) : aiService.requestJson(jsonRequest);
}

async function runRollingRejectionItemCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const segments = createBidPackageSegments(input.bidDocuments, config, rollingSegmentLimitRatio);
  let state = createEmptyRollingRejectionState();
  onProgress('正在按上下文长度滚动审阅投标包。');

  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动审阅投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段。`);
    const stateSummary = createRollingRejectionStateSummary(state);
    const payload = await runJson(aiService, {
      messages: buildRollingRejectionSegmentMessages(input, segment, stateSummary),
      temperature: 0.1,
      schemaName: 'RollingRejectionCheckPatch',
      progressLabel: '投标包废标项滚动审阅',
      failureMessage: '废标项滚动审阅状态格式无效，请重新检查',
    }, onProgress, '投标包废标项滚动审阅');
    state = applyRollingRejectionPatch(state, normalizeRollingRejectionPatch(payload, input.bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿废标项风险。');
  const candidates = createRejectionFinalCandidates(state);
  if (!candidates.length) return [];
  const batches = chunkItems(candidates, finalCandidateBatchSize);
  const findings = [];
  const finalSummary = createFinalRejectionStateSummary(state);
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿废标项风险第 ${batchIndex + 1}/${batches.length} 批。`);
    const finalPayload = await runJson(aiService, {
      messages: buildRejectionFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length),
      temperature: 0.1,
      schemaName: 'RejectionCheckFindings',
      progressLabel: '投标包废标项检查定稿',
      failureMessage: '废标项检查结果格式无效，请重新检查',
    }, onProgress, '投标包废标项检查定稿');
    findings.push(...normalizeRejectionCheckFindings(finalPayload, input.bidDocuments));
  }
  const mergedFindings = dedupeRejectionFindings(findings);
  if (!mergedFindings.length) return [];
  onProgress('正在全局合并废标项风险。');
  const mergedPayload = await runJson(aiService, {
    messages: buildRejectionGlobalMergeMessages(input, mergedFindings, finalSummary),
    temperature: 0.1,
    schemaName: 'RejectionCheckGlobalMergeFindings',
    progressLabel: '废标项风险全局合稿',
    failureMessage: '废标项风险全局合稿结果格式无效，请重新检查',
  }, onProgress, '废标项风险全局合稿');
  return dedupeRejectionFindings(normalizeRejectionCheckFindings(mergedPayload, input.bidDocuments));
}

async function runSegmentedTypoCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const findings = [];
  onProgress('正在按上下文长度分段识别错别字。');

  for (const [documentIndex, document] of input.bidDocuments.entries()) {
    const documentLabel = getBidDocumentDisplayName(document, documentIndex);
    const segments = createBidDocumentSegments(document, config, typoSegmentLimitRatio);
    for (const segment of segments) {
      onProgress(`${documentLabel}：正在识别第 ${segment.segmentIndex}/${segment.totalSegments} 段错别字。`);
      const payload = await runJson(aiService, {
        messages: buildTypoCheckMessages({ bidDocuments: [createSegmentPromptDocument(document, segment)] }),
        temperature: 0.1,
        schemaName: 'TypoCheckFindings',
        progressLabel: `${documentLabel}错别字检查`,
        failureMessage: '错别字检查结果格式无效，请重新检查',
      }, onProgress, `${documentLabel}错别字检查`);
      findings.push(...normalizeTypoCheckFindings(payload, [document], {
        segmentStartOffset: segment.startOffset,
        segmentEndOffset: segment.endOffset,
      }));
    }
  }

  onProgress('正在合并并校验错别字原文位置。');
  return dedupeTypoFindings(findings);
}

async function runRollingLogicCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const segments = createBidPackageSegments(input.bidDocuments, config, rollingSegmentLimitRatio);
  let state = createEmptyRollingLogicState();
  onProgress('正在按上下文长度滚动检查投标包逻辑谬误。');

  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动检查投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段逻辑。`);
    const stateSummary = createRollingLogicStateSummary(state);
    const payload = await runJson(aiService, {
      messages: buildRollingLogicSegmentMessages(input, segment, stateSummary),
      temperature: 0.1,
      schemaName: 'RollingLogicCheckPatch',
      progressLabel: '投标包逻辑滚动检查',
      failureMessage: '逻辑谬误滚动检查状态格式无效，请重新检查',
    }, onProgress, '投标包逻辑滚动检查');
    state = applyRollingLogicPatch(state, normalizeRollingLogicPatch(payload, input.bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿逻辑问题。');
  const candidates = createLogicFinalCandidates(state);
  if (!candidates.length) return [];
  const batches = chunkItems(candidates, finalCandidateBatchSize);
  const findings = [];
  const finalSummary = createFinalLogicStateSummary(state);
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿逻辑问题第 ${batchIndex + 1}/${batches.length} 批。`);
    const finalPayload = await runJson(aiService, {
      messages: buildLogicFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length),
      temperature: 0.1,
      schemaName: 'LogicCheckFindings',
      progressLabel: '投标包逻辑谬误检查定稿',
      failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
    }, onProgress, '投标包逻辑谬误检查定稿');
    findings.push(...normalizeLogicCheckFindings(finalPayload, input.bidDocuments));
  }
  const mergedFindings = dedupeLogicFindings(findings);
  if (!mergedFindings.length) return [];
  onProgress('正在全局合并逻辑问题。');
  const mergedPayload = await runJson(aiService, {
    messages: buildLogicGlobalMergeMessages(input, mergedFindings, finalSummary),
    temperature: 0.1,
    schemaName: 'LogicCheckGlobalMergeFindings',
    progressLabel: '逻辑问题全局合稿',
    failureMessage: '逻辑问题全局合稿结果格式无效，请重新检查',
  }, onProgress, '逻辑问题全局合稿');
  return dedupeLogicFindings(normalizeLogicCheckFindings(mergedPayload, input.bidDocuments));
}

async function runRejectionItemCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedRejectionFlow(aiService, input)) {
    return runRollingRejectionItemCheck(aiService, input, onProgress);
  }

  onProgress('第一轮：正在分析检查范围。');
  const analysis = await runText(
    aiService,
    { messages: buildRejectionCheckAnalysisMessages(input), temperature: 0.1 },
    onProgress,
    '第一轮分析',
  );
  onProgress('第二轮：正在逐项检查投标文件。');
  const draftFindings = await runText(
    aiService,
    { messages: buildRejectionCheckInspectionMessages(input, analysis), temperature: 0.1 },
    onProgress,
    '第二轮检查',
  );
  onProgress('第三轮：正在补充、去重并生成结果。');
  const payload = await runJson(aiService, {
    messages: buildRejectionCheckFinalMessages(input, analysis, draftFindings),
    temperature: 0.1,
    schemaName: 'RejectionCheckFindings',
    progressLabel: '废标项检查结果',
    failureMessage: '废标项检查结果格式无效，请重新检查',
  }, onProgress, '第三轮定稿');
  return normalizeRejectionCheckFindings(payload, input.bidDocuments);
}

async function runTypoCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedBidDocuments(aiService, input.bidDocuments)) {
    return runSegmentedTypoCheck(aiService, input, onProgress);
  }

  onProgress('正在识别错别字候选。');
  const payload = await runJson(aiService, {
    messages: buildTypoCheckMessages({ bidDocuments: input.bidDocuments }),
    temperature: 0.1,
    schemaName: 'TypoCheckFindings',
    progressLabel: '错别字检查结果',
    failureMessage: '错别字检查结果格式无效，请重新检查',
  }, onProgress, '错别字检查');
  onProgress('正在校验错别字原文位置。');
  return normalizeTypoCheckFindings(payload, input.bidDocuments);
}

async function runLogicCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedBidDocuments(aiService, input.bidDocuments)) {
    return runRollingLogicCheck(aiService, input, onProgress);
  }

  onProgress('正在检查逻辑谬误。');
  const payload = await runJson(aiService, {
    messages: buildLogicCheckMessages({ bidDocuments: input.bidDocuments }),
    temperature: 0.1,
    schemaName: 'LogicCheckFindings',
    progressLabel: '逻辑谬误检查结果',
    failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
  }, onProgress, '逻辑谬误检查');
  return normalizeLogicCheckFindings(payload, input.bidDocuments);
}

function updateExtractionState(workspaceStore, updateTask, taskPartial, extractionPartial) {
  const prev = workspaceStore.loadRejectionCheck() || {};
  const task = updateTask(taskPartial);
  const rejectionCheck = workspaceStore.updateRejectionCheck({
    invalidBidAndRejectionItems: { ...(prev.invalidBidAndRejectionItems || {}), ...extractionPartial },
    extractionTask: task,
  });
  updateTask(taskPartial, rejectionCheck);
  return rejectionCheck;
}

async function runRejectionItemsExtractionTask({ aiService, workspaceStore, updateTask, payload }) {
  const state = workspaceStore.loadRejectionCheck ? workspaceStore.loadRejectionCheck() : {};
  const tenderDocument = state.tenderDocument || null;
  if (typeof workspaceStore.readDocumentMarkdown !== 'function' || typeof workspaceStore.createDocumentSignature !== 'function') {
    throw new Error('废标项检查存储接口尚未初始化');
  }
  const tenderContent = String(workspaceStore.readDocumentMarkdown('tender') || '');
  const tenderSignature = String(workspaceStore.createDocumentSignature({ ...tenderDocument, content: tenderContent }) || '');
  if (!tenderContent.trim() || !tenderSignature) throw new Error('缺少招标文件内容，无法解析无效与废标项');
  const developerLogger = createRejectionDeveloperLogger(aiService, 'rejection-items-extraction', {
    tender_signature: tenderSignature,
  });
  developerLogger.write('rejection.extraction.started', {
    tender_signature: tenderSignature,
    tender_content_metrics: textMetrics(tenderContent),
  });

  const logs = ['开始解析无效与废标项。'];
  updateExtractionState(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, {
    status: 'running',
    content: '',
    source: 'ai',
    tenderSignature,
    error: undefined,
    updatedAt: now(),
  });

  let content = '';
  try {
    content = await runInvalidBidAndRejectionItemsExtraction({
      aiService,
      fileContent: tenderContent,
    });
  } catch (error) {
    const message = error?.message || '无效与废标项解析失败';
    developerLogger.write('rejection.extraction.error', {
      tender_signature: tenderSignature,
      error: compactLogError(error),
    });
    updateExtractionState(workspaceStore, updateTask, {
      status: 'error',
      progress: 100,
      logs: [`无效与废标项解析失败：${message}`],
      error: message,
    }, {
      status: 'error',
      content: '',
      source: 'ai',
      tenderSignature,
      error: message,
      updatedAt: now(),
    });
    return;
  }

  const finalContent = stripTripleQuoteWrapper(content);
  const success = Boolean(finalContent.trim());
  developerLogger.write('rejection.extraction.completed', {
    tender_signature: tenderSignature,
    status: success ? 'success' : 'error',
    output_metrics: textMetrics(finalContent),
    error: success ? undefined : '模型未返回解析内容',
  });
  updateExtractionState(workspaceStore, updateTask, {
    status: success ? 'success' : 'error',
    progress: 100,
    logs: success ? ['无效与废标项解析完成。'] : ['无效与废标项解析失败：模型未返回解析内容。'],
    error: success ? undefined : '模型未返回解析内容',
  }, {
    status: success ? 'success' : 'error',
    content: finalContent,
    source: 'ai',
    tenderSignature,
    error: success ? undefined : '模型未返回解析内容',
    updatedAt: now(),
  });
}

function createRunningResult(inputSignature, progressMessage) {
  return { status: 'running', findings: [], inputSignature, progressMessage, updatedAt: now() };
}

function updateCheckWorkspace(workspaceStore, updateTask, taskPartial, partial) {
  const task = updateTask(taskPartial);
  const rejectionCheck = workspaceStore.updateRejectionCheck({ ...partial, checkTask: task });
  updateTask(taskPartial, rejectionCheck);
  return rejectionCheck;
}

async function runRejectionCheckTask({ aiService, workspaceStore, updateTask, payload }) {
  const state = workspaceStore.loadRejectionCheck ? workspaceStore.loadRejectionCheck() : {};
  const options = state.checkOptions || {};
  const runOptions = payload?.runOptions || options;
  const bidDocuments = Array.isArray(state.bidDocuments) ? state.bidDocuments : [];
  if (typeof workspaceStore.readDocumentMarkdown !== 'function'
    || typeof workspaceStore.createDocumentSignature !== 'function'
    || typeof workspaceStore.createRejectionCheckInputSignature !== 'function') {
    throw new Error('废标项检查存储接口尚未初始化');
  }
  const currentBidDocuments = bidDocuments
    .map((document) => ({ ...document, content: String(workspaceStore.readDocumentMarkdown(document.id) || '') }))
    .filter((document) => document.id && document.content.trim());
  const invalidBidAndRejectionItems = String(state.invalidBidAndRejectionItems?.content || '');
  const customCheckItems = String(state.customCheckItems ?? '');
  const rejectionInputSignature = String(workspaceStore.createRejectionCheckInputSignature(currentBidDocuments, invalidBidAndRejectionItems, customCheckItems) || '');
  const bidSignature = currentBidDocuments.map((document) => workspaceStore.createDocumentSignature(document)).filter(Boolean).join('\n---yibiao-rejection-bid-signature---\n');
  if (!currentBidDocuments.length || !bidSignature) throw new Error('缺少投标文件内容，无法开始检查');

  const enabledTasks = [
    runOptions.rejectionCheck ? 'rejection' : '',
    runOptions.typoCheck ? 'typo' : '',
    runOptions.logicCheck ? 'logic' : '',
  ].filter(Boolean);
  if (!enabledTasks.length) throw new Error('请至少启用一种检查');
  if (runOptions.rejectionCheck && (!invalidBidAndRejectionItems.trim() || !rejectionInputSignature)) {
    throw new Error('请先完成无效与废标项解析');
  }

  const developerLogger = createRejectionDeveloperLogger(aiService, 'rejection-check-run', {
    bid_signature: bidSignature,
    rejection_input_signature: rejectionInputSignature,
    enabled_tasks: enabledTasks,
  });
  developerLogger.write('rejection.check.started', {
    bid_signature: bidSignature,
    rejection_input_signature: rejectionInputSignature,
    enabled_tasks: enabledTasks,
    bid_document_count: currentBidDocuments.length,
    bid_content_metrics: currentBidDocuments.map((document) => ({ id: document.id, file_name: document.fileName, ...textMetrics(document.content) })),
    invalid_items_metrics: textMetrics(invalidBidAndRejectionItems),
    custom_items_metrics: textMetrics(customCheckItems),
  });

  let completed = 0;
  const logs = ['开始检查投标文件。'];
  const initialPartial = { checkOptions: options };
  if (runOptions.rejectionCheck) initialPartial.rejectionCheckResult = createRunningResult(rejectionInputSignature, '第一轮：正在分析检查范围。');
  if (runOptions.typoCheck) initialPartial.typoCheckResult = createRunningResult(bidSignature, '正在识别错别字候选。');
  if (runOptions.logicCheck) initialPartial.logicCheckResult = createRunningResult(bidSignature, '正在检查逻辑谬误。');
  updateCheckWorkspace(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, initialPartial);

  function updateOverall(label, partial) {
    const progress = Math.min(95, Math.round(5 + (completed / enabledTasks.length) * 90));
    updateCheckWorkspace(workspaceStore, updateTask, { status: 'running', progress, logs: [...logs, label] }, partial);
  }

  async function runOne(kind, label, runner, resultKey, inputSignature) {
    developerLogger.write('rejection.check.stage.started', {
      kind,
      label,
      input_signature: inputSignature,
    });
    try {
      const findings = await runner((message) => {
        updateOverall(`${label}：${message}`, { [resultKey]: createRunningResult(inputSignature, message) });
      });
      completed += 1;
      developerLogger.write('rejection.check.stage.completed', {
        kind,
        label,
        input_signature: inputSignature,
        result: summarizeFindingsForLog(kind, findings),
      });
      updateOverall(`${label}完成。`, {
        [resultKey]: {
          status: 'success',
          findings,
          inputSignature,
          activeFindingId: findings[0]?.id,
          progressMessage: findings.length ? `${label}发现 ${findings.length} 项` : `${label}未发现问题`,
          updatedAt: now(),
        },
      });
      return { kind, status: 'success' };
    } catch (error) {
      completed += 1;
      const message = error.message || `${label}失败`;
      developerLogger.write('rejection.check.stage.error', {
        kind,
        label,
        input_signature: inputSignature,
        error: compactLogError(error),
      });
      updateOverall(`${label}失败：${message}`, {
        [resultKey]: { status: 'error', findings: [], inputSignature, error: message, progressMessage: message, updatedAt: now() },
      });
      return { kind, status: 'error', error: message };
    }
  }

  const tasks = [];
  if (runOptions.rejectionCheck) {
    tasks.push(runOne('rejection', '废标项检查', (onProgress) => runRejectionItemCheck(aiService, { invalidBidAndRejectionItems, customCheckItems, bidDocuments: currentBidDocuments }, onProgress), 'rejectionCheckResult', rejectionInputSignature));
  }
  if (runOptions.typoCheck) {
    tasks.push(runOne('typo', '错别字检查', (onProgress) => runTypoCheck(aiService, { bidDocuments: currentBidDocuments }, onProgress), 'typoCheckResult', bidSignature));
  }
  if (runOptions.logicCheck) {
    tasks.push(runOne('logic', '逻辑谬误检查', (onProgress) => runLogicCheck(aiService, { bidDocuments: currentBidDocuments }, onProgress), 'logicCheckResult', bidSignature));
  }

  const results = await Promise.all(tasks);
  const failed = results.filter((item) => item.status === 'error');
  updateCheckWorkspace(workspaceStore, updateTask, {
    status: failed.length ? 'error' : 'success',
    progress: 100,
    logs: failed.length ? [`检查完成，${failed.length} 个任务失败。`] : ['检查完成。'],
    error: failed.length ? `${failed.length} 个检查任务失败` : undefined,
  }, {});
  developerLogger.write('rejection.check.completed', {
    status: failed.length ? 'error' : 'success',
    enabled_tasks: enabledTasks,
    failed_count: failed.length,
    results: results.map((item) => ({ kind: item.kind, status: item.status, error: item.error || undefined })),
  });
}

module.exports = {
  runRejectionItemsExtractionTask,
  runRejectionCheckTask,
};
