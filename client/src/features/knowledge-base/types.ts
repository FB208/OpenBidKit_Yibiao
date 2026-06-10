export interface KnowledgeItem {
  id: string;
  title: string;
  resume: string;
  content: string;
  source_block_ids?: string[];
  source_file?: string;
}

export interface KnowledgeCandidateItem {
  id: string;
  title: string;
  summary: string;
}

export interface KnowledgeDiscardedBlockGroup {
  block_ids: string[];
  reason: string;
  source?: string;
}

export interface KnowledgeAnalysisReport {
  total_blocks: number;
  filtered_blocks_count: number;
  candidate_items_count: number;
  final_items_count: number;
  matched_blocks_count: number;
  discarded_blocks_count: number;
  system_discarded_after_retry_count: number;
  new_items_from_recovery_count: number;
  recovery_attempt_count: number;
  batch_size: number;
  coverage_rate: number;
  matched_rate: number;
  created_at: string;
}

export interface KnowledgeAnalysisSnapshot {
  document: KnowledgeDocument;
  block_count: number;
  filtered_blocks_count: number;
  markdown_chars: number;
  kept_block_chars: number;
  covered_unique_content_chars: number;
  coverage_rate_vs_markdown: number;
  candidate_items: KnowledgeCandidateItem[];
  report: KnowledgeAnalysisReport | null;
  discarded: KnowledgeDiscardedBlockGroup[];
  system_discarded_after_retry: KnowledgeDiscardedBlockGroup[];
  debug_log_path?: string;
}

export interface KnowledgeBaseStartMatchingResult {
  success: boolean;
  message: string;
  document?: KnowledgeDocument;
}

export interface KnowledgeBaseRetryDocumentResult {
  success: boolean;
  message: string;
  document?: KnowledgeDocument;
}

export interface KnowledgeBaseMigrationStatus {
  needsMigration: boolean;
  legacyFolderCount: number;
  legacyDocumentCount: number;
  legacyCompletedDocumentCount?: number;
  legacySkippedDocumentCount?: number;
  migrationCompleted?: boolean;
  cleanupPending?: boolean;
  message?: string;
}

export interface KnowledgeBaseMigrationResult {
  success: boolean;
  message: string;
  index?: KnowledgeBaseIndex;
  migratedFolderCount?: number;
  migratedDocumentCount?: number;
  skippedDocumentCount?: number;
  cleanupPending?: boolean;
}

export interface KnowledgeBaseMutationResult {
  success: boolean;
  message: string;
}

export interface KnowledgeBaseIndexMutationResult extends KnowledgeBaseMutationResult {
  index: KnowledgeBaseIndex;
  document?: KnowledgeDocument;
}

export type KnowledgeDocumentStatus = 'pending' | 'copying' | 'converting' | 'extracting' | 'ready_for_matching' | 'matching' | 'recovering' | 'analyzing' | 'saving' | 'success' | 'error';

export interface KnowledgeFolder {
  id: string;
  name: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocument {
  id: string;
  folder_id: string;
  file_name: string;
  status: KnowledgeDocumentStatus;
  progress: number;
  message: string;
  item_count: number;
  block_count?: number;
  filtered_block_count?: number;
  candidate_item_count?: number;
  discarded_block_count?: number;
  system_discarded_after_retry_count?: number;
  last_batch_size?: number;
  sort_order?: number;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface KnowledgeBaseIndex {
  folders: KnowledgeFolder[];
  documents: KnowledgeDocument[];
}

export interface KnowledgeBaseUploadResult {
  success: boolean;
  message: string;
  documents?: KnowledgeDocument[];
}

export interface KnowledgeBaseEvent {
  document: KnowledgeDocument;
}
