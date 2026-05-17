import type { OutlineData } from './outline';

export type AnalysisType = 'overview' | 'requirements';

export interface BidProjectDraft {
  currentStep: number;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
}

export interface FileImportResult {
  success: boolean;
  message: string;
  file_content?: string;
  file_name?: string;
  parser_provider?: string;
  parser_label?: string;
  old_outline?: string;
}

export interface LocalFileSelection {
  id: string;
  file_name: string;
  file_path: string;
  extension: string;
  size: number;
  modified_at: string;
}

export interface FileSelectionResult {
  success: boolean;
  message: string;
  files?: LocalFileSelection[];
}

export type DuplicateCheckStep = 'upload' | 'analysis';

export type DuplicateAnalysisTabId = 'metadata' | 'outline' | 'content' | 'image';

export interface DuplicateCheckWorkspaceState {
  tenderFile: LocalFileSelection | null;
  bidFiles: LocalFileSelection[];
  step?: DuplicateCheckStep;
  activeAnalysisTab?: DuplicateAnalysisTabId;
}

export interface ChapterContentContext {
  project_overview: string;
}
