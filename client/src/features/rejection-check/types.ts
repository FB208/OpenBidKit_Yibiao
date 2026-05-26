export type RejectionDocumentRole = 'tender' | 'bid';

export type RejectionDocumentSource = 'upload' | 'technical-plan';

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
