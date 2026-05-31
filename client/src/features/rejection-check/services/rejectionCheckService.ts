import {
  buildInvalidBidAndRejectionItemsPrompt,
  buildLogicCheckMessages,
  buildRejectionCheckAnalysisMessages,
  buildRejectionCheckFinalMessages,
  buildRejectionCheckInspectionMessages,
  buildTypoCheckMessages,
} from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { ChatMessage } from '../../../shared/types';
import { createId } from '../../../shared/utils/ids';
import type { LogicCheckFinding, RejectionCheckFinding, RejectionFindingSeverity, RejectionFindingType, TypoCheckFinding } from '../types';

const rejectionItemsSystemPrompt = `你是专业的招标文件分析助手。请严格基于用户提供的招标文件原文完成提取和总结。

通用要求：
1. 保持信息全面、准确，尽量使用原文内容，不要自行编造。
2. “此类标书还可能涉及的”部分只补充原文未提及但非常重要的高风险遗漏项，不罗列所有常见可能风险。
3. 只输出最终结果，不输出过程、提示语或客套话。
4. 始终使用简体中文。`;

export function buildInvalidBidAndRejectionItemsMessages(fileContent: string): ChatMessage[] {
  return [
    { role: 'system', content: rejectionItemsSystemPrompt },
    { role: 'user', content: `以下是完整招标文件 Markdown 原文。后续任务必须优先基于这份原文完成：\n\n${fileContent}` },
    { role: 'user', content: buildInvalidBidAndRejectionItemsPrompt() },
  ];
}

interface RunRejectionItemCheckInput {
  invalidBidAndRejectionItems: string;
  customCheckItems?: string;
  bidContent: string;
  onProgress?: (message: string) => void;
}

interface RunBidContentCheckInput {
  bidContent: string;
  onProgress?: (message: string) => void;
}

interface RejectionCheckFindingsPayload {
  findings?: unknown;
  items?: unknown;
  risks?: unknown;
}

interface TypoCheckFindingsPayload {
  findings?: unknown;
  items?: unknown;
  typos?: unknown;
}

interface LogicCheckFindingsPayload {
  findings?: unknown;
  items?: unknown;
  risks?: unknown;
  issues?: unknown;
}

const typoExcerptRadius = 8;

function normalizeFindingType(value: unknown): RejectionFindingType {
  const raw = String(value || '').trim();
  if (raw === 'invalidBid' || raw.includes('无效')) {
    return 'invalidBid';
  }
  return 'rejectionItem';
}

function normalizeSeverity(value: unknown): RejectionFindingSeverity {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw.includes('高')) return 'high';
  if (raw === 'low' || raw.includes('低')) return 'low';
  return 'medium';
}

function normalizeText(value: unknown) {
  return String(value || '').trim();
}

function getArrayPayload(parsed: unknown, keys: string[]) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function normalizeRejectionCheckFindings(parsed: RejectionCheckFindingsPayload | unknown[]): RejectionCheckFinding[] {
  const rawFindings = getArrayPayload(parsed, ['findings', 'items', 'risks']);

  return rawFindings
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => {
      const title = normalizeText(item.title).slice(0, 80);
      const bidEvidence = normalizeText(item.bidEvidence || item.evidence || item.bid_evidence);
      const riskReason = normalizeText(item.riskReason || item.reason || item.risk_reason);

      return {
        id: normalizeText(item.id) || createId('rejection_finding'),
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
    .filter((item) => item.title && item.bidEvidence && item.riskReason);
}

function findVerifiedTypoPosition(bidContent: string, wrongText: string, originalExcerpt: string) {
  if (!wrongText) {
    return -1;
  }

  if (originalExcerpt) {
    const excerptIndex = bidContent.indexOf(originalExcerpt);
    const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
    if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) {
      return excerptIndex + wrongIndexInExcerpt;
    }
  }

  return bidContent.indexOf(wrongText);
}

function createVerifiedTypoExcerpt(bidContent: string, position: number, wrongText: string) {
  let start = Math.max(0, position - typoExcerptRadius);
  let end = Math.min(bidContent.length, position + wrongText.length + typoExcerptRadius);
  const startTagOpen = bidContent.lastIndexOf('<', start);
  const startTagClose = bidContent.lastIndexOf('>', start);
  if (startTagOpen > startTagClose) {
    const tagEnd = bidContent.indexOf('>', start);
    if (tagEnd >= 0 && tagEnd < position) {
      start = tagEnd + 1;
    }
  }

  const endTagOpen = bidContent.lastIndexOf('<', end);
  const endTagClose = bidContent.lastIndexOf('>', end);
  if (endTagOpen > endTagClose) {
    const tagEnd = bidContent.indexOf('>', end);
    if (tagEnd >= 0) {
      end = Math.min(bidContent.length, tagEnd + 1);
    }
  }

  return bidContent.slice(start, end).trim();
}

function createLineLocationHint(bidContent: string, position: number) {
  const before = bidContent.slice(0, Math.max(0, position));
  const lineNumber = before.split(/\r\n|\r|\n/).length;
  return `原文第 ${lineNumber} 行附近`;
}

function normalizeTypoCheckFindings(parsed: TypoCheckFindingsPayload | unknown[], bidContent: string): TypoCheckFinding[] {
  const rawFindings = getArrayPayload(parsed, ['findings', 'items', 'typos']);
  const seen = new Set<string>();
  const findings: TypoCheckFinding[] = [];

  for (const item of rawFindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const wrongText = normalizeText(record.wrongText || record.wrong_text || record.wrong || record.typo).slice(0, 60);
    const correctText = normalizeText(record.correctText || record.correct_text || record.correct || record.suggestion).slice(0, 60);
    const originalExcerpt = normalizeText(record.originalExcerpt || record.original_excerpt || record.excerpt || record.context);
    const reason = normalizeText(record.reason || record.riskReason || record.detail) || '疑似错别字，请结合原文复核。';
    if (!wrongText || !correctText || wrongText === correctText) {
      continue;
    }

    const position = findVerifiedTypoPosition(bidContent, wrongText, originalExcerpt);
    if (position < 0) {
      continue;
    }

    const verifiedExcerpt = createVerifiedTypoExcerpt(bidContent, position, wrongText);
    const key = `${wrongText}\u0000${correctText}\u0000${position}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    findings.push({
      id: normalizeText(record.id) || createId('typo_finding'),
      wrongText,
      correctText,
      originalExcerpt: verifiedExcerpt,
      reason,
      locationHint: createLineLocationHint(bidContent, position),
    });
  }

  return findings;
}

function normalizeLogicCheckFindings(parsed: LogicCheckFindingsPayload | unknown[]): LogicCheckFinding[] {
  const rawFindings = getArrayPayload(parsed, ['findings', 'items', 'risks', 'issues']);
  const seen = new Set<string>();
  const findings: LogicCheckFinding[] = [];

  for (const item of rawFindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const title = normalizeText(record.title || record.summary).slice(0, 80);
    const originalText = normalizeText(record.originalText || record.original_text || record.evidence || record.bidEvidence) || '未提供明确原文摘录，请结合位置线索复核。';
    const locationHint = normalizeText(record.locationHint || record.location_hint || record.location || record.position) || '未明确具体位置，请结合原文摘录复核。';
    const fallacyReason = normalizeText(record.fallacyReason || record.fallacy_reason || record.reason || record.riskReason);
    const suggestion = normalizeText(record.suggestion || record.recommendation) || '请结合投标文件上下文人工复核后修改。';
    if (!title || !fallacyReason) {
      continue;
    }

    const key = `${title}\u0000${fallacyReason}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    findings.push({
      id: normalizeText(record.id) || createId('logic_finding'),
      title,
      originalText,
      locationHint,
      fallacyReason,
      suggestion,
    });
  }

  return findings;
}

export async function runRejectionItemCheck(input: RunRejectionItemCheckInput): Promise<RejectionCheckFinding[]> {
  input.onProgress?.('第一轮：正在分析检查范围。');
  const analysis = await aiClient.chat({
    messages: buildRejectionCheckAnalysisMessages(input),
    temperature: 0.1,
  });

  input.onProgress?.('第二轮：正在逐项检查投标文件。');
  const draftFindings = await aiClient.chat({
    messages: buildRejectionCheckInspectionMessages(input, analysis),
    temperature: 0.1,
  });

  input.onProgress?.('第三轮：正在补充、去重并生成结果。');
  const finalPayload = await aiClient.requestJson<RejectionCheckFindingsPayload | unknown[]>({
    messages: buildRejectionCheckFinalMessages(input, analysis, draftFindings),
    temperature: 0.1,
    schemaName: 'RejectionCheckFindings',
    progressLabel: '废标项检查结果',
    failureMessage: '废标项检查结果格式无效，请重新检查',
  });

  return normalizeRejectionCheckFindings(finalPayload);
}

export async function runTypoCheck(input: RunBidContentCheckInput): Promise<TypoCheckFinding[]> {
  input.onProgress?.('正在识别错别字候选。');
  const payload = await aiClient.requestJson<TypoCheckFindingsPayload | unknown[]>({
    messages: buildTypoCheckMessages({ bidContent: input.bidContent }),
    temperature: 0.1,
    schemaName: 'TypoCheckFindings',
    progressLabel: '错别字检查结果',
    failureMessage: '错别字检查结果格式无效，请重新检查',
  });

  input.onProgress?.('正在校验错别字原文位置。');
  return normalizeTypoCheckFindings(payload, input.bidContent);
}

export async function runLogicCheck(input: RunBidContentCheckInput): Promise<LogicCheckFinding[]> {
  input.onProgress?.('正在检查逻辑谬误。');
  const payload = await aiClient.requestJson<LogicCheckFindingsPayload | unknown[]>({
    messages: buildLogicCheckMessages({ bidContent: input.bidContent }),
    temperature: 0.1,
    schemaName: 'LogicCheckFindings',
    progressLabel: '逻辑谬误检查结果',
    failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
  });

  return normalizeLogicCheckFindings(payload);
}
