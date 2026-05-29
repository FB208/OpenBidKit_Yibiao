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

export type DuplicateAnalysisStatus = 'pending' | 'running' | 'success' | 'error';

export interface DuplicateContentExtractionItem {
  file_id: string;
  file_name: string;
  status: DuplicateAnalysisStatus;
  content_path?: string;
  content_length?: number;
  error?: string;
}

export interface DuplicateMetadataItem {
  key: string;
  label: string;
  value: string;
  normalized?: string;
  date_day?: string;
  comparable?: boolean;
  date_comparable?: boolean;
}

export interface DuplicateMetadataFileResult {
  file_id: string;
  file_name: string;
  status: DuplicateAnalysisStatus;
  metadata: DuplicateMetadataItem[];
  error?: string;
}

export interface DuplicateMetadataComparisonRow {
  key: string;
  label: string;
  values: Record<string, string>;
  duplicate_file_ids: string[];
  same_day_file_ids: string[];
}

export interface DuplicateSubTaskProgress {
  status: DuplicateAnalysisStatus;
  completed: number;
  total: number;
}

export interface DuplicateMetadataAnalysisState {
  status: DuplicateAnalysisStatus;
  progress: number;
  message: string;
  signature?: string;
  started_at?: string;
  updated_at?: string;
  contentExtraction: DuplicateSubTaskProgress;
  metadataExtraction: DuplicateSubTaskProgress;
  files: DuplicateMetadataFileResult[];
  rows: DuplicateMetadataComparisonRow[];
  contentFiles: DuplicateContentExtractionItem[];
  logs?: string[];
}

export type DuplicateOutlineItemSource = 'catalog' | 'heading' | 'semantic';

export type DuplicateOutlineMatchType = 'duplicate' | 'similar';


export interface DuplicateOutlineItem {
  id: string;
  level: number;
  number?: string;
  title: string;
  normalized_title: string;
  path_titles: string[];
  normalized_path: string;
  source: DuplicateOutlineItemSource;
  confidence: number;
  order: number;
  parent_id?: string;
  from_tender: boolean;
  matched_tender_sentence?: string;
  duplicate_group_ids: string[];
  similar_group_ids: string[];
}

export interface DuplicateOutlineFileResult {
  file_id: string;
  file_name: string;
  status: DuplicateAnalysisStatus;
  source?: DuplicateOutlineItemSource;
  confidence?: number;
  item_count: number;
  tender_matched_count: number;
  items: DuplicateOutlineItem[];
  error?: string;
}

export interface DuplicateOutlineGroup {
  id: string;
  type: DuplicateOutlineMatchType;
  title: string;
  score: number;
  file_ids: string[];
  item_ids: Record<string, string[]>;
  paths: Record<string, string[]>;
}

export interface DuplicateOutlinePairwiseSimilarity {
  file_a_id: string;
  file_b_id: string;
  score: number;
  title_overlap: number;
  path_overlap: number;
  order_similarity: number;
  shared_count: number;
  risk: 'high' | 'medium' | 'low' | 'none';
}

export interface DuplicateOutlineAnalysisState {
  status: DuplicateAnalysisStatus;
  progress: number;
  message: string;
  signature?: string;
  started_at?: string;
  updated_at?: string;
  tenderSentenceCount: number;
  tenderMatchedItemCount: number;
  extraction: DuplicateSubTaskProgress;
  files: DuplicateOutlineFileResult[];
  duplicateGroups: DuplicateOutlineGroup[];
  pairwiseSimilarities: DuplicateOutlinePairwiseSimilarity[];
}

export interface DuplicateContentSentenceItem {
  id: string;
  sentence: string;
  normalized: string;
  file_ids: string[];
  occurrences: Record<string, number>;
  first_order: number;
}

export interface DuplicateContentAnalysisState {
  status: DuplicateAnalysisStatus;
  progress: number;
  message: string;
  signature?: string;
  started_at?: string;
  updated_at?: string;
  tenderSentenceCount: number;
  tenderMatchedSentenceCount: number;
  totalSentenceCount: number;
  extraction: DuplicateSubTaskProgress;
  duplicateSentences: DuplicateContentSentenceItem[];
}

export interface DuplicateImageFileResult {
  file_id: string;
  file_name: string;
  status: DuplicateAnalysisStatus;
  image_count: number;
  unique_image_count: number;
  error?: string;
}

export interface DuplicateImageItem {
  id: string;
  hash: string;
  preview_url: string;
  file_ids: string[];
  occurrences: Record<string, number>;
  locations?: Record<string, Array<{
    image_index: number;
    directory: string;
    previous_sentence: string;
  }>>;
}

export interface DuplicateImageAnalysisState {
  status: DuplicateAnalysisStatus;
  progress: number;
  message: string;
  signature?: string;
  started_at?: string;
  updated_at?: string;
  extraction: DuplicateSubTaskProgress;
  totalImageCount: number;
  files: DuplicateImageFileResult[];
  duplicateImages: DuplicateImageItem[];
}

export interface DuplicateCheckTaskState {
  task_id: string;
  type: 'duplicate-analysis';
  group?: 'duplicate-check';
  step?: number;
  lock_policy?: string;
  payload_signature?: string;
  status: 'running' | 'success' | 'error';
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface DuplicateCheckWorkspaceState {
  tenderFile: LocalFileSelection | null;
  bidFiles: LocalFileSelection[];
  step?: DuplicateCheckStep;
  activeAnalysisTab?: DuplicateAnalysisTabId;
  analysisTask?: DuplicateCheckTaskState;
  metadataAnalysis?: DuplicateMetadataAnalysisState;
  outlineAnalysis?: DuplicateOutlineAnalysisState;
  contentAnalysis?: DuplicateContentAnalysisState;
  imageAnalysis?: DuplicateImageAnalysisState;
}

export interface ChapterContentContext {
  project_overview: string;
}
