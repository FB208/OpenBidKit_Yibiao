export type RejectionDocumentRole = 'tender' | 'bid';

export type RejectionDocumentSource = 'upload' | 'technical-plan';

export type RejectionCheckStep = 'documents' | 'items' | 'results';

export type RejectionResultTab = 'analysis' | 'custom';

export type RejectionCheckResultTab = 'rejection' | 'typo' | 'logic';

export type RejectionExtractionStatus = 'idle' | 'running' | 'success' | 'error';

export type RejectionExtractionSource = 'ai' | 'technical-plan';

export type RejectionCheckRunStatus = 'idle' | 'running' | 'success' | 'error';

export type RejectionFindingType = 'invalidBid' | 'rejectionItem';

export type RejectionFindingSeverity = 'high' | 'medium' | 'low';

export interface RejectionDocumentContent {
  role: RejectionDocumentRole;
  fileName: string;
  content: string;
  source: RejectionDocumentSource;
  parserLabel?: string;
  importedAt: string;
}

export interface RejectionCheckWorkspaceState {
  tenderDocument: RejectionDocumentContent | null;
  bidDocument: RejectionDocumentContent | null;
  activeDocumentTab: RejectionDocumentRole;
  step?: RejectionCheckStep;
  activeResultTab?: RejectionResultTab;
  activeCheckResultTab?: RejectionCheckResultTab;
  invalidBidAndRejectionItems?: RejectionExtractionState;
  customCheckItems?: string;
  checkOptions?: RejectionCheckOptions;
  rejectionCheckResult?: RejectionCheckResultState;
  typoCheckResult?: TypoCheckResultState;
  logicCheckResult?: LogicCheckResultState;
}

export interface RejectionCheckOptions {
  rejectionCheck: boolean;
  typoCheck: boolean;
  logicCheck: boolean;
}

export interface RejectionExtractionState {
  status: RejectionExtractionStatus;
  content: string;
  source?: RejectionExtractionSource;
  tenderSignature?: string;
  updatedAt?: string;
  error?: string;
}

export interface RejectionCheckFinding {
  id: string;
  type: RejectionFindingType;
  severity: RejectionFindingSeverity;
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
}

export interface RejectionCheckResultState {
  status: RejectionCheckRunStatus;
  findings: RejectionCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface TypoCheckFinding {
  id: string;
  wrongText: string;
  correctText: string;
  originalExcerpt: string;
  reason: string;
  locationHint?: string;
}

export interface TypoCheckResultState {
  status: RejectionCheckRunStatus;
  findings: TypoCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface LogicCheckFinding {
  id: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
}

export interface LogicCheckResultState {
  status: RejectionCheckRunStatus;
  findings: LogicCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface RejectionRiskItem {
  id: string;
  title: string;
  source: string;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

export interface RejectionCheckReport {
  passed: boolean;
  risks: RejectionRiskItem[];
}
