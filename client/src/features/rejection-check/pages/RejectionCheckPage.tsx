import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, isLibreOfficeRequiredMessage, MarkdownEditor, MarkdownRenderer, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  LogicCheckFinding,
  LogicCheckResultState,
  RejectionBackgroundTaskState,
  RejectionCheckFinding,
  RejectionCheckStep,
  RejectionCheckOptions,
  RejectionCheckResultState,
  RejectionCheckResultTab,
  RejectionCheckRunStatus,
  RejectionCheckWorkspaceState,
  RejectionDocumentContent,
  RejectionDocumentRole,
  RejectionDocumentSource,
  RejectionExtractionState,
  RejectionResultTab,
  TypoCheckFinding,
  TypoCheckResultState,
} from '../types';

interface TechnicalPlanSnapshot {
  tenderFile?: { fileName?: string } | null;
  bidAnalysisTasks?: Record<string, { status?: string; content?: string }>;
}

const steps: RejectionCheckStep[] = ['documents', 'items', 'results'];

const stepLabels: Record<RejectionCheckStep, string> = {
  documents: '选择标书',
  items: '无效与废标项',
  results: '检查结果',
};

const documentTabs: RejectionDocumentRole[] = ['tender', 'bid'];

const resultTabs: Array<{ id: RejectionResultTab; label: string }> = [
  { id: 'analysis', label: '解析结果' },
  { id: 'custom', label: '自定义检查项' },
];

const checkResultTabs: Array<{ id: RejectionCheckResultTab; label: string; description: string }> = [
  { id: 'rejection', label: '废标项检查', description: '根据无效与废标项检查投标文件响应风险' },
  { id: 'typo', label: '错别字检查', description: '检查投标文件中的错别字和明显文字错误' },
  { id: 'logic', label: '逻辑谬误检查', description: '检查前后矛盾、逻辑不一致和表达漏洞' },
];

const defaultCheckOptions: RejectionCheckOptions = {
  rejectionCheck: true,
  typoCheck: true,
  logicCheck: true,
};

const documentLabels: Record<RejectionDocumentRole, string> = {
  tender: '招标文件',
  bid: '投标文件',
};

const sourceLabels: Record<RejectionDocumentSource, string> = {
  upload: '上传解析',
  'technical-plan': '技术方案',
};

const extractionStatusLabels: Record<RejectionExtractionState['status'], string> = {
  idle: '待解析',
  running: '解析中',
  success: '已完成',
  error: '解析失败',
};

const checkRunStatusLabels: Record<RejectionCheckRunStatus, string> = {
  idle: '待检查',
  running: '检查中',
  success: '已完成',
  error: '检查失败',
};

type RejectionCheckTabStatus = RejectionCheckRunStatus | 'disabled';

const checkTabStatusLabels: Record<RejectionCheckTabStatus, string> = {
  ...checkRunStatusLabels,
  disabled: '未启用',
};

const findingTypeLabels: Record<RejectionCheckFinding['type'], string> = {
  invalidBid: '无效标',
  rejectionItem: '废标项',
};

const findingSeverityLabels: Record<RejectionCheckFinding['severity'], string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

function createEmptyExtractionState(): RejectionExtractionState {
  return { status: 'idle', content: '' };
}

function createEmptyRejectionCheckResultState(): RejectionCheckResultState {
  return { status: 'idle', findings: [] };
}

function createEmptyTypoCheckResultState(): TypoCheckResultState {
  return { status: 'idle', findings: [] };
}

function createEmptyLogicCheckResultState(): LogicCheckResultState {
  return { status: 'idle', findings: [] };
}

function normalizeBackgroundTaskState(state?: Partial<RejectionBackgroundTaskState> | null): RejectionBackgroundTaskState | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const type = state.type === 'rejection-items-extraction' || state.type === 'rejection-check-run' ? state.type : undefined;
  const status = state.status === 'running' || state.status === 'success' || state.status === 'error' ? state.status : undefined;
  if (!type || !status || typeof state.task_id !== 'string') return undefined;

  return {
    task_id: state.task_id,
    type,
    status,
    progress: Number.isFinite(Number(state.progress)) ? Number(state.progress) : 0,
    logs: Array.isArray(state.logs) ? state.logs.map((item) => String(item)) : [],
    started_at: typeof state.started_at === 'string' ? state.started_at : new Date().toISOString(),
    updated_at: typeof state.updated_at === 'string' ? state.updated_at : new Date().toISOString(),
    error: typeof state.error === 'string' ? state.error : undefined,
  };
}

function normalizeCheckOptions(options?: Partial<RejectionCheckOptions> | null): RejectionCheckOptions {
  return {
    rejectionCheck: true,
    typoCheck: options?.typoCheck !== false,
    logicCheck: options?.logicCheck !== false,
  };
}

function isCheckResultTabEnabled(tabId: RejectionCheckResultTab, options: RejectionCheckOptions) {
  if (tabId === 'rejection') return options.rejectionCheck;
  if (tabId === 'typo') return options.typoCheck;
  return options.logicCheck;
}

function getCheckResultTabProgress(status: RejectionCheckTabStatus, progressMessage?: string) {
  if (status === 'success' || status === 'error') return 100;
  if (status !== 'running') return 0;
  if (progressMessage?.includes('第三轮')) return 85;
  if (progressMessage?.includes('校验')) return 78;
  if (progressMessage?.includes('第二轮')) return 60;
  if (progressMessage?.includes('识别') || progressMessage?.includes('逻辑')) return 55;
  return 30;
}

function normalizeExtractionState(state?: Partial<RejectionExtractionState> | null): RejectionExtractionState {
  if (!state) {
    return createEmptyExtractionState();
  }

  const content = typeof state.content === 'string' ? stripTripleQuoteWrapper(state.content) : '';
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  return {
    ...state,
    status: status as RejectionExtractionState['status'],
    content,
    error: state.error,
  };
}

function normalizeFindingState(item: Partial<RejectionCheckFinding> | null | undefined, index: number): RejectionCheckFinding | null {
  if (!item) return null;
  const type = item.type === 'invalidBid' || item.type === 'rejectionItem' ? item.type : 'rejectionItem';
  const severity = item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const bidEvidence = typeof item.bidEvidence === 'string' ? item.bidEvidence.trim() : '';
  const riskReason = typeof item.riskReason === 'string' ? item.riskReason.trim() : '';
  if (!title || !bidEvidence || !riskReason) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `rejection-finding-${index + 1}`,
    type,
    severity,
    title,
    summary: typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : title,
    requirement: typeof item.requirement === 'string' && item.requirement.trim() ? item.requirement.trim() : '未明确引用具体检查依据，请人工复核。',
    bidEvidence,
    riskReason,
    suggestion: typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion.trim() : '请结合招标文件要求和投标文件原文人工复核后处理。',
  };
}

function normalizeRejectionCheckResultState(state?: Partial<RejectionCheckResultState> | null): RejectionCheckResultState {
  if (!state) {
    return createEmptyRejectionCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeFindingState(item, index)).filter((item): item is RejectionCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function normalizeTypoFindingState(item: Partial<TypoCheckFinding> | null | undefined, index: number): TypoCheckFinding | null {
  if (!item) return null;
  const wrongText = typeof item.wrongText === 'string' ? item.wrongText.trim() : '';
  const correctText = typeof item.correctText === 'string' ? item.correctText.trim() : '';
  const originalExcerpt = typeof item.originalExcerpt === 'string' ? item.originalExcerpt.trim() : '';
  if (!wrongText || !correctText || !originalExcerpt || wrongText === correctText) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `typo-finding-${index + 1}`,
    wrongText,
    correctText,
    originalExcerpt,
    reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : '疑似错别字，请结合原文复核。',
    locationHint: typeof item.locationHint === 'string' && item.locationHint.trim() ? item.locationHint.trim() : undefined,
  };
}

function normalizeTypoCheckResultState(state?: Partial<TypoCheckResultState> | null): TypoCheckResultState {
  if (!state) {
    return createEmptyTypoCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeTypoFindingState(item, index)).filter((item): item is TypoCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function normalizeLogicFindingState(item: Partial<LogicCheckFinding> | null | undefined, index: number): LogicCheckFinding | null {
  if (!item) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const fallacyReason = typeof item.fallacyReason === 'string' ? item.fallacyReason.trim() : '';
  if (!title || !fallacyReason) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `logic-finding-${index + 1}`,
    title,
    originalText: typeof item.originalText === 'string' && item.originalText.trim() ? item.originalText.trim() : '未提供明确原文摘录，请结合位置线索复核。',
    locationHint: typeof item.locationHint === 'string' && item.locationHint.trim() ? item.locationHint.trim() : '未明确具体位置，请结合原文摘录复核。',
    fallacyReason,
    suggestion: typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion.trim() : '请结合投标文件上下文人工复核后修改。',
  };
}

function normalizeLogicCheckResultState(state?: Partial<LogicCheckResultState> | null): LogicCheckResultState {
  if (!state) {
    return createEmptyLogicCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeLogicFindingState(item, index)).filter((item): item is LogicCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function formatCharacterCount(length: number) {
  if (length >= 10000) return `${(length / 10000).toFixed(1)} 万字`;
  return `${length} 字`;
}

function formatContentLength(content: string) {
  return formatCharacterCount(content.trim().length);
}

function formatImportedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function getFileBadge(document: RejectionDocumentContent) {
  if (document.source === 'technical-plan') return '方案';
  const extension = document.fileName.split('.').pop()?.trim();
  return extension ? extension.slice(0, 4).toUpperCase() : 'DOC';
}

function createDocumentContent(
  role: RejectionDocumentRole,
  source: RejectionDocumentSource,
  fileName: string,
  content: string,
  parserLabel?: string,
): RejectionDocumentContent {
  return {
    role,
    fileName,
    content,
    source,
    parserLabel,
    importedAt: new Date().toISOString(),
  };
}

function createDocumentSignature(document: RejectionDocumentContent | null) {
  if (!document) {
    return '';
  }

  const content = document.content.trim();
  return [
    document.source,
    document.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-rejection-signature---\n');
}

function createRejectionCheckInputSignature(
  bidDocument: RejectionDocumentContent | null,
  invalidBidAndRejectionItems: string,
  customCheckItems: string,
) {
  const bidSignature = createDocumentSignature(bidDocument);
  const analysis = invalidBidAndRejectionItems.trim();
  if (!bidSignature || !analysis) {
    return '';
  }

  const custom = customCheckItems.trim();
  return [
    bidSignature,
    analysis.length,
    analysis.slice(0, 800),
    analysis.slice(-800),
    custom.length,
    custom.slice(0, 800),
    custom.slice(-800),
  ].join('\n---yibiao-rejection-check-input---\n');
}

function getTechnicalPlanDiscardedBids(technicalPlan: TechnicalPlanSnapshot | null | undefined) {
  const task = technicalPlan?.bidAnalysisTasks?.discardedBids;
  return task?.status === 'success' && task.content?.trim() ? task.content : '';
}

function stripTripleQuoteWrapper(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return content;
}

function DocumentFilePill({ document, onRemove }: { document: RejectionDocumentContent; onRemove: () => void }) {
  return (
    <article className="rejection-file-pill">
      <div className="rejection-file-icon">{getFileBadge(document)}</div>
      <div className="rejection-file-info">
        <strong title={document.fileName}>{document.fileName}</strong>
        <span>{sourceLabels[document.source]} · {formatContentLength(document.content)} · {formatImportedAt(document.importedAt)}</span>
      </div>
      <button type="button" onClick={onRemove} aria-label={`移除${documentLabels[document.role]}`}>
        移除
      </button>
    </article>
  );
}

function FindingDetailBlock({ label, content, allowRawHtml = false }: { label: string; content: string; allowRawHtml?: boolean }) {
  return (
    <div className="rejection-finding-detail-block">
      <strong>{label}</strong>
      <div className="markdown-viewer rejection-finding-markdown">
        <MarkdownRenderer allowRawHtml={allowRawHtml}>
          {content || '未提供'}
        </MarkdownRenderer>
      </div>
    </div>
  );
}

function escapeInlineHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMarkdownText(content: string, target: string) {
  if (!target) {
    return content;
  }

  const parts = content.split(target);
  if (parts.length <= 1) {
    return content;
  }

  return parts.map((part, index) => index < parts.length - 1
    ? `${part}<mark>${escapeInlineHtml(target)}</mark>`
    : part).join('');
}

function TypoOriginalBlock({ excerpt, wrongText }: { excerpt: string; wrongText: string }) {
  const highlightedContent = highlightMarkdownText(excerpt || '未提供', wrongText);

  return (
    <div className="rejection-finding-detail-block">
      <strong>原文内容</strong>
      <div className="markdown-viewer rejection-finding-markdown typo-original-excerpt">
        <MarkdownRenderer allowRawHtml>
          {highlightedContent}
        </MarkdownRenderer>
      </div>
    </div>
  );
}

function RejectionFindingItem({ finding, expanded, onToggle, onDelete }: { finding: RejectionCheckFinding; expanded: boolean; onToggle: () => void; onDelete: () => void }) {
  return (
    <article className={`rejection-finding-item is-${finding.type} is-${finding.severity}${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong>{finding.title}</strong>
              <em className={`rejection-finding-tag is-${finding.type}`}>{findingTypeLabels[finding.type]}</em>
              <em className={`rejection-finding-severity is-${finding.severity}`}>{findingSeverityLabels[finding.severity]}</em>
            </span>
            <small>{finding.summary}</small>
          </span>
        </button>
        <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.title}`}>
          删除
        </button>
      </div>

      {expanded && (
        <div className="rejection-finding-detail">
          <FindingDetailBlock label="检查依据" content={finding.requirement} allowRawHtml />
          <FindingDetailBlock label="投标文件证据" content={finding.bidEvidence} allowRawHtml />
          <FindingDetailBlock label="风险原因" content={finding.riskReason} />
          <FindingDetailBlock label="处理建议" content={finding.suggestion} />
        </div>
      )}
    </article>
  );
}

function TypoFindingItem({ finding, expanded, onToggle, onDelete, onCopyOriginal, onCopyWrong }: { finding: TypoCheckFinding; expanded: boolean; onToggle: () => void; onDelete: () => void; onCopyOriginal: () => void; onCopyWrong: () => void }) {
  return (
    <article className={`rejection-finding-item is-typo${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong className="typo-finding-title">
                <span>{finding.wrongText}</span>
                <i aria-hidden="true">-&gt;</i>
                <span>{finding.correctText}</span>
              </strong>
              <em className="rejection-finding-tag is-typo">错别字</em>
            </span>
            <small>{finding.reason}</small>
          </span>
        </button>
        <div className="rejection-finding-actions">
          <button type="button" className="rejection-finding-copy" onClick={onCopyWrong} aria-label={`复制错字${finding.wrongText}`}>
            复制错字
          </button>
          <button type="button" className="rejection-finding-copy" onClick={onCopyOriginal} aria-label={`复制${finding.wrongText}所在原文`}>
            复制原文
          </button>
          <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.wrongText}`}>
            删除
          </button>
        </div>
      </div>

      {expanded && (
        <div className="rejection-finding-detail typo-finding-detail">
          <TypoOriginalBlock excerpt={finding.originalExcerpt} wrongText={finding.wrongText} />
          <FindingDetailBlock label="判断原因" content={finding.reason} />
        </div>
      )}
    </article>
  );
}

function LogicFindingItem({ finding, expanded, onToggle, onDelete }: { finding: LogicCheckFinding; expanded: boolean; onToggle: () => void; onDelete: () => void }) {
  return (
    <article className={`rejection-finding-item is-logic${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong>{finding.title}</strong>
              <em className="rejection-finding-tag is-logic">逻辑谬误</em>
            </span>
            <small>{finding.locationHint}</small>
          </span>
        </button>
        <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.title}`}>
          删除
        </button>
      </div>

      {expanded && (
        <div className="rejection-finding-detail">
          <FindingDetailBlock label="原文与位置" content={`${finding.locationHint}\n\n${finding.originalText}`} allowRawHtml />
          <FindingDetailBlock label="谬误原因" content={finding.fallacyReason} />
          <FindingDetailBlock label="修改建议" content={finding.suggestion} />
        </div>
      )}
    </article>
  );
}

function RejectionCheckPage() {
  const [step, setStep] = useState<RejectionCheckStep>('documents');
  const [tenderDocument, setTenderDocument] = useState<RejectionDocumentContent | null>(null);
  const [bidDocument, setBidDocument] = useState<RejectionDocumentContent | null>(null);
  const [activeDocumentTab, setActiveDocumentTab] = useState<RejectionDocumentRole>('tender');
  const [activeResultTab, setActiveResultTab] = useState<RejectionResultTab>('analysis');
  const [activeCheckResultTab, setActiveCheckResultTab] = useState<RejectionCheckResultTab>('rejection');
  const [invalidBidAndRejectionItems, setInvalidBidAndRejectionItems] = useState<RejectionExtractionState>(() => createEmptyExtractionState());
  const [rejectionCheckResult, setRejectionCheckResult] = useState<RejectionCheckResultState>(() => createEmptyRejectionCheckResultState());
  const [typoCheckResult, setTypoCheckResult] = useState<TypoCheckResultState>(() => createEmptyTypoCheckResultState());
  const [logicCheckResult, setLogicCheckResult] = useState<LogicCheckResultState>(() => createEmptyLogicCheckResultState());
  const [extractionTask, setExtractionTask] = useState<RejectionBackgroundTaskState | undefined>();
  const [checkTask, setCheckTask] = useState<RejectionBackgroundTaskState | undefined>();
  const [customCheckItems, setCustomCheckItems] = useState('');
  const [checkOptions, setCheckOptions] = useState<RejectionCheckOptions>(defaultCheckOptions);
  const [draftCheckOptions, setDraftCheckOptions] = useState<RejectionCheckOptions>(defaultCheckOptions);
  const [checkConfigDialogOpen, setCheckConfigDialogOpen] = useState(false);
  const [busy, setBusy] = useState<'technical-plan' | 'tender-upload' | 'bid-upload' | null>(null);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const hydratedRef = useRef(false);
  const autoStartedSignatureRef = useRef('');
  const technicalPlanCheckSignatureRef = useRef('');
  const activeTaskTypesRef = useRef<Set<string> | null>(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const activeDocument = activeDocumentTab === 'tender' ? tenderDocument : bidDocument;
  const tenderSignature = useMemo(() => createDocumentSignature(tenderDocument), [tenderDocument]);
  const bidSignature = useMemo(() => createDocumentSignature(bidDocument), [bidDocument]);
  const hasAnyDocument = Boolean(tenderDocument || bidDocument);
  const checkOptionsChanged = checkOptions.typoCheck !== defaultCheckOptions.typoCheck
    || checkOptions.logicCheck !== defaultCheckOptions.logicCheck;
  const hasAnyWorkspaceData = Boolean(
    hasAnyDocument
    || invalidBidAndRejectionItems.content.trim()
    || rejectionCheckResult.status !== 'idle'
    || rejectionCheckResult.findings.length
    || typoCheckResult.status !== 'idle'
    || typoCheckResult.findings.length
    || logicCheckResult.status !== 'idle'
    || logicCheckResult.findings.length
    || extractionTask
    || checkTask
    || customCheckItems.trim()
    || checkOptionsChanged,
  );
  const canGoNext = Boolean(tenderDocument && bidDocument);
  const activeIndex = steps.indexOf(step);
  const extractionRunning = invalidBidAndRejectionItems.status === 'running' || extractionTask?.status === 'running';
  const extractionMatchesTender = Boolean(tenderSignature && invalidBidAndRejectionItems.tenderSignature === tenderSignature);
  const visibleExtractionStatus = extractionMatchesTender ? invalidBidAndRejectionItems.status : 'idle';
  const visibleExtractionContent = extractionMatchesTender ? invalidBidAndRejectionItems.content : '';
  const hasCurrentExtraction = Boolean(
    visibleExtractionContent.trim(),
  );
  const resultSourceLabel = !extractionMatchesTender
    ? '等待解析'
    : invalidBidAndRejectionItems.source === 'technical-plan'
      ? '来自技术方案解析结果'
      : invalidBidAndRejectionItems.source === 'ai'
        ? '由废标项检查解析生成'
        : '等待解析';
  const activeCheckResult = checkResultTabs.find((tab) => tab.id === activeCheckResultTab) || checkResultTabs[0];
  const currentRejectionCheckInputSignature = useMemo(
    () => createRejectionCheckInputSignature(bidDocument, visibleExtractionContent, customCheckItems),
    [bidDocument, customCheckItems, visibleExtractionContent],
  );
  const rejectionCheckMatchesInput = Boolean(
    currentRejectionCheckInputSignature
    && rejectionCheckResult.inputSignature === currentRejectionCheckInputSignature,
  );
  const typoCheckMatchesInput = Boolean(
    bidSignature
    && typoCheckResult.inputSignature === bidSignature,
  );
  const logicCheckMatchesInput = Boolean(
    bidSignature
    && logicCheckResult.inputSignature === bidSignature,
  );
  const visibleRejectionCheckStatus: RejectionCheckRunStatus = rejectionCheckMatchesInput ? rejectionCheckResult.status : 'idle';
  const visibleRejectionFindings = rejectionCheckMatchesInput ? rejectionCheckResult.findings : [];
  const visibleTypoCheckStatus: RejectionCheckRunStatus = typoCheckMatchesInput ? typoCheckResult.status : 'idle';
  const visibleTypoFindings = typoCheckMatchesInput ? typoCheckResult.findings : [];
  const visibleLogicCheckStatus: RejectionCheckRunStatus = logicCheckMatchesInput ? logicCheckResult.status : 'idle';
  const visibleLogicFindings = logicCheckMatchesInput ? logicCheckResult.findings : [];
  const rejectionCheckRunning = rejectionCheckResult.status === 'running';
  const typoCheckRunning = typoCheckResult.status === 'running';
  const logicCheckRunning = logicCheckResult.status === 'running';
  const backgroundCheckRunning = checkTask?.status === 'running';
  const checkRunning = rejectionCheckRunning || typoCheckRunning || logicCheckRunning || backgroundCheckRunning;
  const customCheckItemsDisabled = extractionRunning || checkRunning;
  const hasStaleRejectionCheckResult = Boolean(
    currentRejectionCheckInputSignature
    && rejectionCheckResult.inputSignature
    && rejectionCheckResult.inputSignature !== currentRejectionCheckInputSignature
    && (rejectionCheckResult.findings.length || rejectionCheckResult.status !== 'idle'),
  );
  const hasStaleTypoCheckResult = Boolean(
    bidSignature
    && typoCheckResult.inputSignature
    && typoCheckResult.inputSignature !== bidSignature
    && (typoCheckResult.findings.length || typoCheckResult.status !== 'idle'),
  );
  const hasStaleLogicCheckResult = Boolean(
    bidSignature
    && logicCheckResult.inputSignature
    && logicCheckResult.inputSignature !== bidSignature
    && (logicCheckResult.findings.length || logicCheckResult.status !== 'idle'),
  );

  useEffect(() => {
    if (!analyticsReady) return;

    const page = step === 'documents'
      ? `rejection-check/documents/${activeDocumentTab}`
      : step === 'items'
        ? `rejection-check/items/${activeResultTab}`
        : `rejection-check/results/${activeCheckResultTab}`;
    trackPageView(page);
  }, [activeCheckResultTab, activeDocumentTab, activeResultTab, analyticsReady, step]);

  function applyWorkspaceState(state: RejectionCheckWorkspaceState, options: { syncViewState?: boolean } = {}) {
    const syncViewState = options.syncViewState !== false;
    setTenderDocument(state.tenderDocument || null);
    setBidDocument(state.bidDocument || null);
    if (syncViewState) {
      setActiveDocumentTab(state.activeDocumentTab === 'bid' ? 'bid' : 'tender');
      setStep(state.step === 'items' || state.step === 'results' ? state.step : 'documents');
      setActiveResultTab(state.activeResultTab === 'custom' ? 'custom' : 'analysis');
      setActiveCheckResultTab(checkResultTabs.some((tab) => tab.id === state.activeCheckResultTab) ? state.activeCheckResultTab as RejectionCheckResultTab : 'rejection');
    }
    setInvalidBidAndRejectionItems(normalizeExtractionState({
      ...(state.invalidBidAndRejectionItems || {}),
      content: stripTripleQuoteWrapper(state.invalidBidAndRejectionItems?.content || ''),
    }));
    setRejectionCheckResult(normalizeRejectionCheckResultState(state.rejectionCheckResult));
    setTypoCheckResult(normalizeTypoCheckResultState(state.typoCheckResult));
    setLogicCheckResult(normalizeLogicCheckResultState(state.logicCheckResult));
    setExtractionTask(normalizeBackgroundTaskState(state.extractionTask));
    setCheckTask(normalizeBackgroundTaskState(state.checkTask));
    setCustomCheckItems(typeof state.customCheckItems === 'string' ? state.customCheckItems : '');
    const nextOptions = normalizeCheckOptions(state.checkOptions);
    setCheckOptions(nextOptions);
    setDraftCheckOptions(nextOptions);
  }

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.workspace.loadRejectionCheck()
      .then((state) => {
        if (canceled || !state) return;
        applyWorkspaceState(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取废标项检查缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
          setAnalyticsReady(true);
          if (activeTaskTypesRef.current) {
            markStaleTasksWithoutActive(activeTaskTypesRef.current);
          }
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    if (extractionRunning || checkRunning) {
      return;
    }

    const state: RejectionCheckWorkspaceState = {
      tenderDocument,
      bidDocument,
      activeDocumentTab,
      step,
      activeResultTab,
      activeCheckResultTab,
      invalidBidAndRejectionItems,
      rejectionCheckResult,
      typoCheckResult,
      logicCheckResult,
      extractionTask,
      checkTask,
      customCheckItems,
      checkOptions,
    };
    void window.yibiao?.workspace.saveRejectionCheck(state)
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存废标项检查缓存失败', 'error');
      });
  }, [activeCheckResultTab, activeDocumentTab, activeResultTab, bidDocument, checkOptions, checkRunning, checkTask, customCheckItems, extractionRunning, extractionTask, invalidBidAndRejectionItems, logicCheckResult, rejectionCheckResult, showToast, step, tenderDocument, typoCheckResult]);

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<unknown, RejectionCheckWorkspaceState>((event) => {
      if (event.rejectionCheck) {
        applyWorkspaceState(event.rejectionCheck, { syncViewState: false });
      }
    });

    void window.yibiao.tasks.getActiveTasks()
      .then((tasks) => {
        const activeTypes = new Set((Array.isArray(tasks) ? tasks : [])
          .map((task) => {
            const type = task && typeof task === 'object' ? (task as { type?: string }).type : '';
            return typeof type === 'string' ? type : '';
          }));
        activeTaskTypesRef.current = activeTypes;
        if (hydratedRef.current) {
          markStaleTasksWithoutActive(activeTypes);
        }
      })
      .catch((error) => {
        console.warn('获取废标项检查后台任务状态失败', error);
      });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current || step !== 'items' || !tenderDocument || !tenderSignature) {
      return;
    }

    if (extractionRunning) {
      return;
    }

    void prepareInvalidBidAndRejectionItems(false);
  }, [extractionRunning, invalidBidAndRejectionItems.content, invalidBidAndRejectionItems.source, invalidBidAndRejectionItems.tenderSignature, step, tenderDocument, tenderSignature]);

  function clearExtractionForTenderChange() {
    autoStartedSignatureRef.current = '';
    technicalPlanCheckSignatureRef.current = '';
    setInvalidBidAndRejectionItems(createEmptyExtractionState());
    setRejectionCheckResult(createEmptyRejectionCheckResultState());
    setExtractionTask(undefined);
    setCheckTask(undefined);
  }

  async function importParsedDocument(role: RejectionDocumentRole) {
    const documentLabel = documentLabels[role];
    try {
      const importer = window.yibiao?.file.importRejectionCheckDocument;
      if (typeof importer !== 'function') {
        throw new Error('文件解析接口尚未加载，请重启应用后重试');
      }

      setBusy(role === 'tender' ? 'tender-upload' : 'bid-upload');
      const result = await importer(role);

      if (!result?.success || !result.file_content) {
        const message = result?.message || `未选择${documentLabel}`;
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      const nextDocument = createDocumentContent(
        role,
        'upload',
        result.file_name || documentLabel,
        result.file_content,
        result.parser_label,
      );
      if (role === 'tender') {
        clearExtractionForTenderChange();
        setTenderDocument(nextDocument);
      } else {
        setRejectionCheckResult(createEmptyRejectionCheckResultState());
        setTypoCheckResult(createEmptyTypoCheckResultState());
        setLogicCheckResult(createEmptyLogicCheckResultState());
        setCheckTask(undefined);
        setBidDocument(nextDocument);
      }
      setActiveDocumentTab(role);
      showToast(`${documentLabel}已解析`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : `${documentLabel}解析失败`;
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function readTenderFromTechnicalPlan() {
    if (!window.yibiao?.technicalPlan) {
      showToast('技术方案缓存接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    try {
      setBusy('technical-plan');
      const technicalPlan = await window.yibiao.technicalPlan.loadState() as TechnicalPlanSnapshot;
      const markdown = await window.yibiao.technicalPlan.readTenderMarkdown();
      if (!markdown.trim()) {
        showToast('技术方案中暂无可读取的招标文件正文', 'info');
        return;
      }

      clearExtractionForTenderChange();
      setTenderDocument(createDocumentContent(
        'tender',
        'technical-plan',
        technicalPlan.tenderFile?.fileName || '技术方案招标文件',
        markdown,
      ));
      setActiveDocumentTab('tender');
      showToast('已从技术方案读取招标文件', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取技术方案招标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  function removeDocument(role: RejectionDocumentRole) {
    if (role === 'tender') {
      clearExtractionForTenderChange();
      setTenderDocument(null);
      if (step === 'items') {
        setStep('documents');
      }
    } else {
      setRejectionCheckResult(createEmptyRejectionCheckResultState());
      setTypoCheckResult(createEmptyTypoCheckResultState());
      setLogicCheckResult(createEmptyLogicCheckResultState());
      setCheckTask(undefined);
      setBidDocument(null);
    }
  }

  async function tryUseTechnicalPlanDiscardedBids(signature: string) {
    if (!tenderDocument || tenderDocument.source !== 'technical-plan') {
      return false;
    }

    if (technicalPlanCheckSignatureRef.current === signature && invalidBidAndRejectionItems.source === 'technical-plan') {
      return hasCurrentExtraction;
    }

    technicalPlanCheckSignatureRef.current = signature;
    if (!window.yibiao?.technicalPlan) {
      return false;
    }

    const technicalPlan = await window.yibiao.technicalPlan.loadState() as TechnicalPlanSnapshot;
    const markdown = await window.yibiao.technicalPlan.readTenderMarkdown();
    if (markdown.trim() !== tenderDocument.content.trim()) {
      return false;
    }

    const content = stripTripleQuoteWrapper(getTechnicalPlanDiscardedBids(technicalPlan));
    if (!content) {
      return false;
    }

    setInvalidBidAndRejectionItems({
      status: 'success',
      content,
      source: 'technical-plan',
      tenderSignature: signature,
      updatedAt: new Date().toISOString(),
    });
    setRejectionCheckResult(createEmptyRejectionCheckResultState());
    return true;
  }

  async function prepareInvalidBidAndRejectionItems(force: boolean) {
    if (!tenderDocument || !tenderSignature) {
      showToast('请先准备招标文件', 'info');
      return;
    }

    if (!force) {
      if (hasCurrentExtraction) {
        return;
      }

      if (autoStartedSignatureRef.current === tenderSignature) {
        return;
      }

      try {
        const usedTechnicalPlanResult = await tryUseTechnicalPlanDiscardedBids(tenderSignature);
        if (usedTechnicalPlanResult) {
          return;
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取技术方案无效标与废标项失败', 'error');
      }
    }

    void startInvalidBidAndRejectionItemsExtraction(tenderSignature);
  }

  async function startInvalidBidAndRejectionItemsExtraction(signature: string) {
    if (!tenderDocument) {
      showToast('请先准备招标文件', 'info');
      return;
    }

    autoStartedSignatureRef.current = signature;
    const startedAt = new Date().toISOString();
    const nextExtractionState: RejectionExtractionState = {
      status: 'running',
      content: '',
      source: 'ai',
      tenderSignature: signature,
      updatedAt: startedAt,
    };
    const nextExtractionTask: RejectionBackgroundTaskState = {
      task_id: `local-${Date.now()}`,
      type: 'rejection-items-extraction',
      status: 'running',
      progress: 5,
      logs: ['正在启动无效与废标项解析任务。'],
      started_at: startedAt,
      updated_at: startedAt,
    };
    const emptyRejectionCheckResult = createEmptyRejectionCheckResultState();

    setInvalidBidAndRejectionItems(nextExtractionState);
    setRejectionCheckResult(emptyRejectionCheckResult);
    setExtractionTask(nextExtractionTask);
    setCheckTask(undefined);

    try {
      const starter = window.yibiao?.tasks.startRejectionItemsExtraction;
      if (typeof starter !== 'function') {
        throw new Error('后台任务接口尚未加载，请重启应用后重试');
      }

      await starter({
        tenderContent: tenderDocument.content,
        tenderSignature: signature,
        workspaceState: {
          tenderDocument,
          bidDocument,
          activeDocumentTab,
          step,
          activeResultTab,
          activeCheckResultTab,
          customCheckItems,
          checkOptions,
          invalidBidAndRejectionItems: nextExtractionState,
          rejectionCheckResult: emptyRejectionCheckResult,
          extractionTask: nextExtractionTask,
          checkTask: undefined,
        },
      });
      showToast('无效与废标项解析任务已在后台启动', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动无效与废标项解析失败';
      setInvalidBidAndRejectionItems({
        status: 'error',
        content: '',
        error: message,
        source: 'ai',
        tenderSignature: signature,
        updatedAt: new Date().toISOString(),
      });
      setExtractionTask((prev) => prev ? { ...prev, status: 'error', progress: 100, error: message, logs: [message], updated_at: new Date().toISOString() } : prev);
      showToast(message, 'error');
    }
  }

  function resetWorkspace() {
    autoStartedSignatureRef.current = '';
    technicalPlanCheckSignatureRef.current = '';
    setStep('documents');
    setTenderDocument(null);
    setBidDocument(null);
    setActiveDocumentTab('tender');
    setActiveResultTab('analysis');
    setActiveCheckResultTab('rejection');
    setInvalidBidAndRejectionItems(createEmptyExtractionState());
    setRejectionCheckResult(createEmptyRejectionCheckResultState());
    setTypoCheckResult(createEmptyTypoCheckResultState());
    setLogicCheckResult(createEmptyLogicCheckResultState());
    setExtractionTask(undefined);
    setCheckTask(undefined);
    setCustomCheckItems('');
    setCheckOptions(defaultCheckOptions);
    setDraftCheckOptions(defaultCheckOptions);
    setCheckConfigDialogOpen(false);
    void window.yibiao?.workspace.clearRejectionCheck()
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空废标项检查缓存失败', 'error');
      });
    showToast('已重置废标项检查文件', 'success');
  }

  function openCheckConfigDialog() {
    setDraftCheckOptions(checkOptions);
    setCheckConfigDialogOpen(true);
  }

  function applyCheckOptions(options: RejectionCheckOptions) {
    setCheckOptions(options);
    if (!isCheckResultTabEnabled(activeCheckResultTab, options)) {
      setActiveCheckResultTab('rejection');
    }
  }

  function saveCheckOptions() {
    const nextOptions = normalizeCheckOptions(draftCheckOptions);
    applyCheckOptions(nextOptions);
    setCheckConfigDialogOpen(false);
    showToast('检查配置已保存', 'success');
  }

  async function startChecks(options: RejectionCheckOptions = checkOptions, runOptions: RejectionCheckOptions = options) {
    if (checkRunning) {
      return;
    }

    if (!bidDocument || !bidSignature) {
      showToast('请先准备投标文件', 'info');
      return;
    }

    if (runOptions.rejectionCheck && (visibleExtractionStatus !== 'success' || !visibleExtractionContent.trim())) {
      showToast('请先完成无效与废标项解析', 'info');
      setStep('items');
      return;
    }

    if (runOptions.rejectionCheck && !currentRejectionCheckInputSignature) {
      showToast('检查输入不完整，请确认投标文件和检查项', 'info');
      return;
    }

    if (!runOptions.rejectionCheck && !runOptions.typoCheck && !runOptions.logicCheck) {
      showToast('请至少启用一种检查', 'info');
      return;
    }

    const nextActiveCheckResultTab: RejectionCheckResultTab = runOptions.rejectionCheck ? 'rejection' : runOptions.typoCheck ? 'typo' : 'logic';
    setActiveCheckResultTab(nextActiveCheckResultTab);
    const startedAt = new Date().toISOString();
    const nextRejectionCheckResult: RejectionCheckResultState = runOptions.rejectionCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: currentRejectionCheckInputSignature,
          progressMessage: '第一轮：正在分析检查范围。',
          updatedAt: startedAt,
        }
      : rejectionCheckResult;
    const nextTypoCheckResult: TypoCheckResultState = runOptions.typoCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: bidSignature,
          progressMessage: '正在识别错别字候选。',
          updatedAt: startedAt,
        }
      : typoCheckResult;
    const nextLogicCheckResult: LogicCheckResultState = runOptions.logicCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: bidSignature,
          progressMessage: '正在检查逻辑谬误。',
          updatedAt: startedAt,
        }
      : logicCheckResult;
    const nextCheckTask: RejectionBackgroundTaskState = {
      task_id: `local-${Date.now()}`,
      type: 'rejection-check-run',
      status: 'running',
      progress: 5,
      logs: ['正在启动检查任务。'],
      started_at: startedAt,
      updated_at: startedAt,
    };

    if (runOptions.rejectionCheck) {
      setRejectionCheckResult(nextRejectionCheckResult);
    }

    if (runOptions.typoCheck) {
      setTypoCheckResult(nextTypoCheckResult);
    }

    if (runOptions.logicCheck) {
      setLogicCheckResult(nextLogicCheckResult);
    }

    setCheckTask(nextCheckTask);

    try {
      const starter = window.yibiao?.tasks.startRejectionCheck;
      if (typeof starter !== 'function') {
        throw new Error('后台任务接口尚未加载，请重启应用后重试');
      }

      await starter({
        checkOptions: options,
        runOptions,
        bidContent: bidDocument.content,
        invalidBidAndRejectionItems: visibleExtractionContent,
        customCheckItems,
        rejectionInputSignature: currentRejectionCheckInputSignature,
        bidSignature,
        workspaceState: {
          tenderDocument,
          bidDocument,
          activeDocumentTab,
          step,
          activeResultTab,
          activeCheckResultTab: nextActiveCheckResultTab,
          invalidBidAndRejectionItems,
          rejectionCheckResult: nextRejectionCheckResult,
          typoCheckResult: nextTypoCheckResult,
          logicCheckResult: nextLogicCheckResult,
          checkTask: nextCheckTask,
          customCheckItems,
          checkOptions: options,
        },
      });
      showToast('检查任务已在后台启动', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动检查任务失败';
      if (runOptions.rejectionCheck) {
        setRejectionCheckResult((prev) => prev.inputSignature === currentRejectionCheckInputSignature
          ? { ...prev, status: 'error', error: message, progressMessage: message, updatedAt: new Date().toISOString() }
          : prev);
      }
      if (runOptions.typoCheck) {
        setTypoCheckResult((prev) => prev.inputSignature === bidSignature
          ? { ...prev, status: 'error', error: message, progressMessage: message, updatedAt: new Date().toISOString() }
          : prev);
      }
      if (runOptions.logicCheck) {
        setLogicCheckResult((prev) => prev.inputSignature === bidSignature
          ? { ...prev, status: 'error', error: message, progressMessage: message, updatedAt: new Date().toISOString() }
          : prev);
      }
      setCheckTask((prev) => prev ? { ...prev, status: 'error', error: message, progress: 100, updated_at: new Date().toISOString() } : prev);
      showToast(message, 'error');
    }
  }

  function startCheckWithOptions() {
    const nextOptions = normalizeCheckOptions(draftCheckOptions);
    applyCheckOptions(nextOptions);
    setCheckConfigDialogOpen(false);
    void startChecks(nextOptions);
  }

  function retrySingleCheck(tabId: RejectionCheckResultTab) {
    void startChecks(checkOptions, {
      rejectionCheck: tabId === 'rejection',
      typoCheck: tabId === 'typo',
      logicCheck: tabId === 'logic',
    });
  }

  function toggleFinding(findingId: string) {
    setRejectionCheckResult((prev) => ({
      ...prev,
      activeFindingId: prev.activeFindingId === findingId ? undefined : findingId,
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteFinding(findingId: string) {
    setRejectionCheckResult((prev) => {
      const findings = prev.findings.filter((item) => item.id !== findingId);
      return {
        ...prev,
        findings,
        activeFindingId: prev.activeFindingId === findingId ? undefined : prev.activeFindingId,
        progressMessage: findings.length ? `保留 ${findings.length} 个需复核风险项` : '所有风险项已处理',
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function toggleTypoFinding(findingId: string) {
    setTypoCheckResult((prev) => ({
      ...prev,
      activeFindingId: prev.activeFindingId === findingId ? undefined : findingId,
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteTypoFinding(findingId: string) {
    setTypoCheckResult((prev) => {
      const findings = prev.findings.filter((item) => item.id !== findingId);
      return {
        ...prev,
        findings,
        activeFindingId: prev.activeFindingId === findingId ? undefined : prev.activeFindingId,
        progressMessage: findings.length ? `保留 ${findings.length} 个疑似错别字` : '所有错别字项已处理',
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function copyTypoOriginal(finding: TypoCheckFinding) {
    try {
      await navigator.clipboard.writeText(finding.originalExcerpt);
      showToast('已复制原文', 'success');
    } catch {
      showToast('复制原文失败', 'error');
    }
  }

  async function copyTypoWrong(finding: TypoCheckFinding) {
    try {
      await navigator.clipboard.writeText(finding.wrongText);
      showToast('已复制错字', 'success');
    } catch {
      showToast('复制错字失败', 'error');
    }
  }

  function toggleLogicFinding(findingId: string) {
    setLogicCheckResult((prev) => ({
      ...prev,
      activeFindingId: prev.activeFindingId === findingId ? undefined : findingId,
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteLogicFinding(findingId: string) {
    setLogicCheckResult((prev) => {
      const findings = prev.findings.filter((item) => item.id !== findingId);
      return {
        ...prev,
        findings,
        activeFindingId: prev.activeFindingId === findingId ? undefined : prev.activeFindingId,
        progressMessage: findings.length ? `保留 ${findings.length} 个逻辑问题` : '所有逻辑问题已处理',
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function markStaleTasksWithoutActive(activeTypes: Set<string>) {
    if (!activeTypes.has('rejection-items-extraction')) {
      markStaleExtractionTask();
    }
    if (!activeTypes.has('rejection-check-run')) {
      markStaleCheckTask();
    }
  }

  function markStaleExtractionTask() {
    setInvalidBidAndRejectionItems((prev) => prev.status === 'running'
      ? {
          ...prev,
          status: 'error',
          error: '上次解析未完成，请重新解析',
          updatedAt: new Date().toISOString(),
        }
      : prev);
    setExtractionTask((prev) => prev?.status === 'running'
      ? {
          ...prev,
          status: 'error',
          progress: 100,
          error: '上次解析未完成，请重新解析',
          logs: ['上次解析未完成，请重新解析。'],
          updated_at: new Date().toISOString(),
        }
      : prev);
  }

  function markStaleCheckTask() {
    const staleMessage = '上次检查未完成，请重新检查';
    const markResult = <T extends RejectionCheckResultState | TypoCheckResultState | LogicCheckResultState>(prev: T): T => (prev.status === 'running'
      ? {
          ...prev,
          status: 'error',
          error: staleMessage,
          progressMessage: staleMessage,
          updatedAt: new Date().toISOString(),
        }
      : prev);
    setRejectionCheckResult(markResult);
    setTypoCheckResult(markResult);
    setLogicCheckResult(markResult);
    setCheckTask((prev) => prev?.status === 'running'
      ? {
          ...prev,
          status: 'error',
          progress: 100,
          error: staleMessage,
          logs: [staleMessage],
          updated_at: new Date().toISOString(),
        }
      : prev);
  }

  function switchStep(nextStep: RejectionCheckStep) {
    if (nextStep === 'items' && !canGoNext) {
      showToast('请先准备招标文件和投标文件', 'info');
      return;
    }
    setStep(nextStep);
  }

  function goToOffset(offset: number) {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      switchStep(nextStep);
    }
  }

  const hasVisibleCheckResult = visibleRejectionCheckStatus === 'success'
    || visibleRejectionCheckStatus === 'error'
    || visibleTypoCheckStatus === 'success'
    || visibleTypoCheckStatus === 'error'
    || visibleLogicCheckStatus === 'success'
    || visibleLogicCheckStatus === 'error';
  const checkActionLabel = checkRunning
    ? '检查中...'
    : hasVisibleCheckResult
      ? '重新检查'
      : '开始检查';
  const rejectionCheckSummaryText = visibleRejectionCheckStatus === 'running'
    ? rejectionCheckResult.progressMessage || 'AI 正在检查投标文件。'
    : visibleRejectionCheckStatus === 'error'
      ? rejectionCheckResult.error || '废标项检查失败，请重新检查。'
      : visibleRejectionCheckStatus === 'success'
        ? visibleRejectionFindings.length
          ? `发现 ${visibleRejectionFindings.length} 个需要复核的风险项。`
          : '暂未发现符合条件的废标项风险。'
          : hasStaleRejectionCheckResult
            ? '检查输入已变化，请重新检查以刷新结果。'
            : '点击开始检查后展示废标项检查结果。';
  const typoCheckSummaryText = visibleTypoCheckStatus === 'running'
    ? typoCheckResult.progressMessage || 'AI 正在识别并校验错别字。'
    : visibleTypoCheckStatus === 'error'
      ? typoCheckResult.error || '错别字检查失败，请重新检查。'
      : visibleTypoCheckStatus === 'success'
        ? visibleTypoFindings.length
          ? `发现 ${visibleTypoFindings.length} 个疑似错别字。`
          : '暂未发现明确错别字。'
        : hasStaleTypoCheckResult
          ? '投标文件已变化，请重新检查以刷新结果。'
          : '点击开始检查后展示错别字检查结果。';
  const logicCheckSummaryText = visibleLogicCheckStatus === 'running'
    ? logicCheckResult.progressMessage || 'AI 正在检查逻辑谬误。'
    : visibleLogicCheckStatus === 'error'
      ? logicCheckResult.error || '逻辑谬误检查失败，请重新检查。'
      : visibleLogicCheckStatus === 'success'
        ? visibleLogicFindings.length
          ? `发现 ${visibleLogicFindings.length} 个逻辑问题。`
          : '暂未发现明确逻辑谬误。'
        : hasStaleLogicCheckResult
          ? '投标文件已变化，请重新检查以刷新结果。'
          : '点击开始检查后展示逻辑谬误检查结果。';

  function renderDisabledCheckContent(label: string) {
    return (
      <div className="markdown-empty-state rejection-finding-empty">
        <strong>{label}已关闭</strong>
        <p>可在右上角检查配置中重新启用。</p>
      </div>
    );
  }

  function renderTypoCheckContent() {
    if (!checkOptions.typoCheck) {
      return renderDisabledCheckContent('错别字检查');
    }

    return (
      <>
        <div className="rejection-finding-summary">
          <div>
            <span className="section-kicker">错别字检查</span>
            <h3>{visibleTypoCheckStatus === 'running' ? '正在检查错别字' : '错别字检查结果'}</h3>
            <p>{typoCheckSummaryText}</p>
          </div>
          <div className={`rejection-result-status is-${visibleTypoCheckStatus}`}>
            <span>{checkRunStatusLabels[visibleTypoCheckStatus]}</span>
            <small>{visibleTypoCheckStatus === 'success' ? `${visibleTypoFindings.length} 个错别字` : typoCheckResult.progressMessage || '等待执行'}</small>
          </div>
        </div>

        {visibleTypoCheckStatus === 'running' ? (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>AI 正在检查错别字</strong>
            <p>{typoCheckResult.progressMessage || '正在识别候选并校验原文位置。'}</p>
          </div>
        ) : visibleTypoCheckStatus === 'error' ? (
          <div className="markdown-empty-state rejection-finding-empty is-error">
            <strong>{typoCheckResult.error || '错别字检查失败'}</strong>
            <p>请确认模型配置可用，或重新检查当前投标文件。</p>
            <button type="button" className="secondary-action" onClick={() => retrySingleCheck('typo')} disabled={checkRunning || extractionRunning || !bidDocument}>
              重新检查错别字
            </button>
          </div>
        ) : visibleTypoFindings.length ? (
          <div className="rejection-finding-list">
            {visibleTypoFindings.map((finding) => (
              <TypoFindingItem
                key={finding.id}
                finding={finding}
                expanded={typoCheckResult.activeFindingId === finding.id}
                onToggle={() => toggleTypoFinding(finding.id)}
                onDelete={() => deleteTypoFinding(finding.id)}
                onCopyOriginal={() => void copyTypoOriginal(finding)}
                onCopyWrong={() => void copyTypoWrong(finding)}
              />
            ))}
          </div>
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{visibleTypoCheckStatus === 'success' ? '暂未发现错别字' : hasStaleTypoCheckResult ? '投标文件已变化' : '等待错别字检查'}</strong>
            <p>{typoCheckSummaryText}</p>
          </div>
        )}
      </>
    );
  }

  function renderLogicCheckContent() {
    if (!checkOptions.logicCheck) {
      return renderDisabledCheckContent('逻辑谬误检查');
    }

    return (
      <>
        <div className="rejection-finding-summary">
          <div>
            <span className="section-kicker">逻辑谬误检查</span>
            <h3>{visibleLogicCheckStatus === 'running' ? '正在检查逻辑谬误' : '逻辑谬误检查结果'}</h3>
            <p>{logicCheckSummaryText}</p>
          </div>
          <div className={`rejection-result-status is-${visibleLogicCheckStatus}`}>
            <span>{checkRunStatusLabels[visibleLogicCheckStatus]}</span>
            <small>{visibleLogicCheckStatus === 'success' ? `${visibleLogicFindings.length} 个逻辑问题` : logicCheckResult.progressMessage || '等待执行'}</small>
          </div>
        </div>

        {visibleLogicCheckStatus === 'running' ? (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>AI 正在检查逻辑谬误</strong>
            <p>{logicCheckResult.progressMessage || '正在检查句子逻辑漏洞和全文前后不一致。'}</p>
          </div>
        ) : visibleLogicCheckStatus === 'error' ? (
          <div className="markdown-empty-state rejection-finding-empty is-error">
            <strong>{logicCheckResult.error || '逻辑谬误检查失败'}</strong>
            <p>请确认模型配置可用，或重新检查当前投标文件。</p>
            <button type="button" className="secondary-action" onClick={() => retrySingleCheck('logic')} disabled={checkRunning || extractionRunning || !bidDocument}>
              重新检查逻辑谬误
            </button>
          </div>
        ) : visibleLogicFindings.length ? (
          <div className="rejection-finding-list">
            {visibleLogicFindings.map((finding) => (
              <LogicFindingItem
                key={finding.id}
                finding={finding}
                expanded={logicCheckResult.activeFindingId === finding.id}
                onToggle={() => toggleLogicFinding(finding.id)}
                onDelete={() => deleteLogicFinding(finding.id)}
              />
            ))}
          </div>
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{visibleLogicCheckStatus === 'success' ? '暂未发现逻辑谬误' : hasStaleLogicCheckResult ? '投标文件已变化' : '等待逻辑谬误检查'}</strong>
            <p>{logicCheckSummaryText}</p>
          </div>
        )}
      </>
    );
  }

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'rejection-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          disabled: (!hasAnyWorkspaceData && step === 'documents') || busy !== null || extractionRunning || checkRunning,
          tooltip: '清空当前废标项检查文件',
          onClick: resetWorkspace,
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'documents' ? 'primary' : 'secondary',
          tooltip: '回到选择标书',
          onClick: () => switchStep('documents'),
        },
      ],
    },
    {
      id: 'rejection-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0 || extractionRunning || checkRunning,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: activeIndex >= steps.length - 1 || (step === 'documents' && !canGoNext) || extractionRunning || checkRunning,
          tooltip: activeIndex >= steps.length - 1
            ? '当前已经是最后一步'
            : step === 'documents' && !canGoNext
              ? '请先准备招标文件和投标文件'
              : `进入${stepLabels[steps[activeIndex + 1]]}`,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  return (
    <div className={`rejection-check-page is-${step}`}>
      {step === 'documents' ? (
        <>
          <section className="rejection-upload-board">
            <div className="rejection-page-title">
              <div>
                <span className="section-kicker">STEP 01</span>
                <h2>选择标书</h2>
              </div>
            </div>

            <div className="rejection-upload-stack">
              <article className="rejection-upload-row">
                <div className="rejection-upload-label">
                  <span>01</span>
                  <strong>招标文件</strong>
                </div>
                <div className="rejection-upload-content">
                  {tenderDocument ? (
                    <DocumentFilePill document={tenderDocument} onRemove={() => removeDocument('tender')} />
                  ) : (
                    <div className="rejection-empty-upload">
                      <strong>等待招标文件</strong>
                      <span>用于识别废标条款、响应格式和强制性要求。</span>
                    </div>
                  )}
                </div>
                <div className="rejection-upload-actions">
                  <button type="button" className="secondary-action" onClick={readTenderFromTechnicalPlan} disabled={busy !== null}>
                    {busy === 'technical-plan' ? '读取中...' : '从技术方案读取'}
                  </button>
                  <button type="button" className="primary-action" onClick={() => void importParsedDocument('tender')} disabled={busy !== null}>
                    {busy === 'tender-upload' ? '解析中...' : tenderDocument ? '替换' : '上传'}
                  </button>
                </div>
              </article>

              <article className="rejection-upload-row bid-row">
                <div className="rejection-upload-label">
                  <span>02</span>
                  <strong>投标文件</strong>
                </div>
                <div className="rejection-upload-content">
                  {bidDocument ? (
                    <DocumentFilePill document={bidDocument} onRemove={() => removeDocument('bid')} />
                  ) : (
                    <div className="rejection-empty-upload">
                      <strong>等待投标文件</strong>
                      <span>重新上传会直接替换当前投标文件。</span>
                    </div>
                  )}
                </div>
                <div className="rejection-upload-actions single-action">
                  <button type="button" className="primary-action" onClick={() => void importParsedDocument('bid')} disabled={busy !== null}>
                    {busy === 'bid-upload' ? '解析中...' : bidDocument ? '替换' : '上传'}
                  </button>
                </div>
              </article>
            </div>
          </section>

          <div className="rejection-document-tabs" role="tablist" aria-label="废标项检查正文切换">
            {documentTabs.map((tab) => {
              const isActive = tab === activeDocumentTab;
              return (
                <button
                  type="button"
                  className={`rejection-document-tab${isActive ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`rejection-document-panel-${tab}`}
                  id={`rejection-document-tab-${tab}`}
                  key={tab}
                  onClick={() => setActiveDocumentTab(tab)}
                >
                  <strong>{documentLabels[tab]}</strong>
                </button>
              );
            })}
          </div>

          <section
            className="rejection-reader-card analysis-markdown-card"
            role="tabpanel"
            id={`rejection-document-panel-${activeDocumentTab}`}
            aria-labelledby={`rejection-document-tab-${activeDocumentTab}`}
          >
            <div className="analysis-result-head rejection-reader-head">
              <strong>{documentLabels[activeDocumentTab]}正文</strong>
              <span>{activeDocument ? `${activeDocument.fileName} · ${sourceLabels[activeDocument.source]}` : '等待上传'}</span>
            </div>

            {activeDocument ? (
              <div className="markdown-viewer rejection-markdown-viewer">
                <MarkdownRenderer>
                  {activeDocument.content}
                </MarkdownRenderer>
              </div>
            ) : (
              <div className="markdown-empty-state rejection-empty-reader">
                <strong>尚未准备{documentLabels[activeDocumentTab]}</strong>
                <p>{activeDocumentTab === 'tender' ? '可从技术方案读取招标文件，也可以直接上传并解析成 Markdown。' : '请上传一份投标文件，页面会在这里展示解析后的 Markdown 正文。'}</p>
              </div>
            )}
          </section>
        </>
      ) : step === 'items' ? (
        <>
          <section className="rejection-result-command-bar">
            <div>
              <span className="section-kicker">STEP 02</span>
              <strong>无效与废标项</strong>
              <p>先提取招标文件中的无效投标和废标项，再补充自定义检查项。</p>
            </div>
            <div className={`rejection-result-status is-${visibleExtractionStatus}`}>
              <span>{extractionStatusLabels[visibleExtractionStatus]}</span>
              <small>{resultSourceLabel}</small>
            </div>
            <button
              type="button"
              className="primary-action"
              onClick={() => void prepareInvalidBidAndRejectionItems(Boolean(visibleExtractionContent.trim()) || visibleExtractionStatus === 'error')}
              disabled={!tenderDocument || extractionRunning}
            >
              {extractionRunning ? '解析中...' : visibleExtractionContent.trim() ? '重新解析' : '开始解析'}
            </button>
          </section>

          <div className="rejection-document-tabs" role="tablist" aria-label="无效与废标项内容切换">
            {resultTabs.map((tab) => {
              const isActive = tab.id === activeResultTab;
              return (
                <button
                  type="button"
                  className={`rejection-document-tab${isActive ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`rejection-result-panel-${tab.id}`}
                  id={`rejection-result-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setActiveResultTab(tab.id)}
                >
                  <strong>{tab.label}</strong>
                </button>
              );
            })}
          </div>

          <section
            className="rejection-reader-card rejection-result-card analysis-markdown-card"
            role="tabpanel"
            id={`rejection-result-panel-${activeResultTab}`}
            aria-labelledby={`rejection-result-tab-${activeResultTab}`}
          >
            <div className="analysis-result-head rejection-reader-head">
              <strong>{activeResultTab === 'analysis' ? '解析结果' : '自定义检查项'}</strong>
              <span>{activeResultTab === 'analysis' ? `${extractionStatusLabels[visibleExtractionStatus]} · ${resultSourceLabel}` : customCheckItemsDisabled ? '任务运行中暂不能修改自定义检查项，当前检查会使用启动任务时的内容' : '可填写补充检查口径、人工关注项或项目经验'}</span>
            </div>

            {activeResultTab === 'analysis' ? (
              visibleExtractionContent.trim() ? (
                <div className="markdown-viewer rejection-markdown-viewer rejection-result-viewer">
                  <MarkdownRenderer>
                    {visibleExtractionContent}
                  </MarkdownRenderer>
                </div>
              ) : (
                <div className="markdown-empty-state rejection-empty-reader">
                  <strong>{visibleExtractionStatus === 'error' ? invalidBidAndRejectionItems.error || '解析失败' : '等待解析无效与废标项'}</strong>
                  <p>{extractionRunning ? '正在提取招标文件中的无效投标、废标项和可能风险。' : '进入本步骤后会自动解析；也可以点击上方“开始解析”。'}</p>
                </div>
              )
            ) : (
              <MarkdownEditor
                className="rejection-custom-editor"
                value={customCheckItems}
                onChange={setCustomCheckItems}
                disabled={customCheckItemsDisabled}
                placeholder="输入自定义检查项，例如：\n- 关注报价文件是否存在多处不一致\n- 关注资格证明材料有效期是否覆盖投标截止时间\n- 关注技术偏离表是否遗漏关键参数响应"
              />
            )}
          </section>
        </>
      ) : (
        <>
          <section className="rejection-check-result-panel">
            <div className="duplicate-page-title rejection-check-result-title">
              <div>
                <span className="section-kicker">STEP 03</span>
                <h2>检查结果</h2>
              </div>
              <div className="rejection-check-result-actions">
                <button
                  type="button"
                  className="outline-config-action"
                  onClick={openCheckConfigDialog}
                  aria-label="打开检查配置"
                  title="检查配置"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={openCheckConfigDialog}
                  disabled={checkRunning || extractionRunning}
                >
                  {checkActionLabel}
                </button>
              </div>
            </div>

            <div className="rejection-check-result-tabs" role="tablist" aria-label="废标项检查结果类型">
              {checkResultTabs.map((tab) => {
                const isActive = tab.id === activeCheckResultTab;
                const enabled = isCheckResultTabEnabled(tab.id, checkOptions);
                const status: RejectionCheckTabStatus = !enabled
                  ? 'disabled'
                  : tab.id === 'rejection'
                    ? visibleRejectionCheckStatus
                    : tab.id === 'typo'
                      ? visibleTypoCheckStatus
                      : visibleLogicCheckStatus;
                const progressMessage = tab.id === 'rejection'
                  ? rejectionCheckResult.progressMessage
                  : tab.id === 'typo'
                    ? typoCheckResult.progressMessage
                    : logicCheckResult.progressMessage;
                const progress = getCheckResultTabProgress(status, progressMessage);
                return (
                  <button
                    type="button"
                    className={`rejection-check-result-tab${isActive ? ' is-active' : ''} is-${status}`}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`rejection-check-result-panel-${tab.id}`}
                    id={`rejection-check-result-tab-${tab.id}`}
                    key={tab.id}
                    onClick={() => setActiveCheckResultTab(tab.id)}
                  >
                    <span className="duplicate-analysis-tab-main">
                      <strong>{tab.label}</strong>
                      <em>{checkTabStatusLabels[status]}</em>
                    </span>
                    <span className="duplicate-analysis-progress" aria-label={`${tab.label}检查进度 ${progress}%`}>
                      <span style={{ width: `${progress}%` }} />
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              className={`rejection-check-result-content${isCheckResultTabEnabled(activeCheckResult.id, checkOptions) ? ' is-rejection-list' : ''}`}
              role="tabpanel"
              id={`rejection-check-result-panel-${activeCheckResult.id}`}
              aria-labelledby={`rejection-check-result-tab-${activeCheckResult.id}`}
            >
              {activeCheckResult.id === 'rejection' ? (
                <>
                  <div className="rejection-finding-summary">
                    <div>
                      <span className="section-kicker">废标项检查</span>
                      <h3>{visibleRejectionCheckStatus === 'running' ? '正在检查投标文件' : '废标项检查结果'}</h3>
                      <p>{rejectionCheckSummaryText}</p>
                    </div>
                    <div className={`rejection-result-status is-${visibleRejectionCheckStatus}`}>
                      <span>{checkRunStatusLabels[visibleRejectionCheckStatus]}</span>
                      <small>{visibleRejectionCheckStatus === 'success' ? `${visibleRejectionFindings.length} 个风险项` : rejectionCheckResult.progressMessage || '等待执行'}</small>
                    </div>
                  </div>

                  {visibleRejectionCheckStatus === 'running' ? (
                    <div className="markdown-empty-state rejection-finding-empty">
                      <strong>AI 正在执行三轮检查</strong>
                      <p>{rejectionCheckResult.progressMessage || '正在分析检查范围、逐项核查投标文件并补充定稿。'}</p>
                    </div>
                  ) : visibleRejectionCheckStatus === 'error' ? (
                    <div className="markdown-empty-state rejection-finding-empty is-error">
                      <strong>{rejectionCheckResult.error || '废标项检查失败'}</strong>
                      <p>请确认模型配置可用，或重新检查当前投标文件。</p>
                      <button type="button" className="secondary-action" onClick={() => retrySingleCheck('rejection')} disabled={checkRunning || extractionRunning || !bidDocument || visibleExtractionStatus !== 'success' || !currentRejectionCheckInputSignature}>
                        重新检查废标项
                      </button>
                    </div>
                  ) : visibleRejectionFindings.length ? (
                    <div className="rejection-finding-list">
                      {visibleRejectionFindings.map((finding) => (
                        <RejectionFindingItem
                          key={finding.id}
                          finding={finding}
                          expanded={rejectionCheckResult.activeFindingId === finding.id}
                          onToggle={() => toggleFinding(finding.id)}
                          onDelete={() => deleteFinding(finding.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="markdown-empty-state rejection-finding-empty">
                      <strong>{visibleRejectionCheckStatus === 'success' ? '暂未发现废标项风险' : hasStaleRejectionCheckResult ? '检查输入已变化' : '等待废标项检查'}</strong>
                      <p>{rejectionCheckSummaryText}</p>
                    </div>
                  )}
                </>
              ) : activeCheckResult.id === 'typo' ? renderTypoCheckContent() : renderLogicCheckContent()}
            </div>
          </section>

          <Dialog.Root open={checkConfigDialogOpen} onOpenChange={setCheckConfigDialogOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="content-regenerate-modal" />
              <Dialog.Content className="content-generation-config-card rejection-check-config-card">
                <div className="content-regenerate-card-head">
                  <span className="section-kicker">检查配置</span>
                  <Dialog.Title>检查结果配置</Dialog.Title>
                </div>

                <div className="content-generation-config-list">
                  <label className="content-generation-config-row">
                    <span>
                      <strong>废标项检查</strong>
                      <small>基于招标文件无效与废标项检查投标文件响应风险，默认必选。</small>
                    </span>
                    <Switch.Root className="content-generation-switch" checked disabled aria-label="废标项检查">
                      <Switch.Thumb className="content-generation-switch-thumb" />
                    </Switch.Root>
                  </label>
                  <label className="content-generation-config-row">
                    <span>
                      <strong>错别字检查</strong>
                      <small>检查投标文件中的错别字、明显别字和文字疏漏。</small>
                    </span>
                    <Switch.Root
                      className="content-generation-switch"
                      checked={draftCheckOptions.typoCheck}
                      onCheckedChange={(checked) => setDraftCheckOptions((prev) => ({ ...prev, typoCheck: checked }))}
                      aria-label="错别字检查"
                    >
                      <Switch.Thumb className="content-generation-switch-thumb" />
                    </Switch.Root>
                  </label>
                  <label className="content-generation-config-row">
                    <span>
                      <strong>逻辑谬误检查</strong>
                      <small>检查前后矛盾、逻辑不一致和表述漏洞。</small>
                    </span>
                    <Switch.Root
                      className="content-generation-switch"
                      checked={draftCheckOptions.logicCheck}
                      onCheckedChange={(checked) => setDraftCheckOptions((prev) => ({ ...prev, logicCheck: checked }))}
                      aria-label="逻辑谬误检查"
                    >
                      <Switch.Thumb className="content-generation-switch-thumb" />
                    </Switch.Root>
                  </label>
                </div>

                <div className="content-regenerate-actions">
                  <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
                  <button type="button" className="secondary-action" onClick={saveCheckOptions}>
                    保存配置
                  </button>
                  <button type="button" className="primary-action" onClick={startCheckWithOptions} disabled={checkRunning || extractionRunning || !bidDocument || (draftCheckOptions.rejectionCheck && (visibleExtractionStatus !== 'success' || !currentRejectionCheckInputSignature))}>
                    {checkActionLabel}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )}

      <FloatingToolbar groups={toolbarGroups} label="废标项检查工具条" />
    </div>
  );
}

export default RejectionCheckPage;
