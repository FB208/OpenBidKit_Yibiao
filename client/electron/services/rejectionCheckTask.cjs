const crypto = require('node:crypto');
const { compactLogError, createNoopDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { runInvalidBidAndRejectionItemsExtraction } = require('./bidAnalysisTask.cjs');

const checkRunStatus = ['idle', 'running', 'success', 'error'];
const typoExcerptRadius = 8;

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

function findVerifiedTypoPosition(bidContent, wrongText, originalExcerpt) {
  if (!wrongText) return -1;
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

function normalizeTypoCheckFindings(parsed, bidDocuments) {
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
    const position = findVerifiedTypoPosition(bidDocument.content, wrongText, originalExcerpt);
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

async function runRejectionItemCheck(aiService, input, onProgress) {
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
