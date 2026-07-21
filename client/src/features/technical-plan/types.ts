import type { OutlineData, OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'bid-analysis' | 'outline-generation' | 'global-facts' | 'content-edit' | 'expand';
export type TechnicalPlanWorkflowKind = 'technical-plan' | 'existing-plan-expansion';
export type BidAnalysisMode = 'key' | 'full' | 'custom';
export type BidAnalysisTaskStatus = 'idle' | 'running' | 'success' | 'error';
export type BidSectionMode = 'single' | 'multiple';
export type BidSectionExtractionStatus = 'idle' | 'running' | 'success' | 'error';
export type BackgroundTaskType = 'bid-section-extraction' | 'bid-analysis' | 'outline-generation' | 'global-facts-generation' | 'content-generation';
export type BackgroundTaskStatus = 'running' | 'pausing' | 'paused' | 'success' | 'error';
export type ContentGenerationSectionStatus = 'idle' | 'running' | 'success' | 'error';
export type ContentTableRequirement = 'none' | 'light' | 'moderate' | 'heavy';
export type ConsistencyRepairMode = 'agent' | 'normal';
export type OriginalPlanCoverageRepairMode = 'agent' | 'normal';
export type SaveOutlineReason = 'sort' | 'edit' | 'delete' | 'add-root' | 'add-child' | 'replace';

export interface SaveOutlineRequest {
  outlineData: OutlineData;
  reason: SaveOutlineReason;
  idMap?: Record<string, string>;
  affectedNodeIds?: string[];
}

export interface ContentGenerationOptions {
  useAiImages: boolean;
  maxAiImages: number;
  useMermaidImages: boolean;
  maxMermaidImages: number;
  useHtmlImages: boolean;
  maxHtmlImages: number;
  htmlImageTypes: string;
  tableRequirement: ContentTableRequirement;
  enableConsistencyAudit: boolean;
  consistencyRepairMode: ConsistencyRepairMode;
  enableOriginalPlanCoverageAudit: boolean;
  originalPlanCoverageRepairMode: OriginalPlanCoverageRepairMode;
}

export interface BackgroundTaskState {
  task_id: string;
  type: BackgroundTaskType;
  status: BackgroundTaskStatus;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: {
    outline?: {
      phase: 'generating' | 'reviewing' | 'word-adjusting' | 'second-review' | 'done';
      current_leaf_count: number;
      minimum_leaf_count?: number;
      maximum_leaf_count?: number;
      word_adjustment_attempts: number;
      word_adjustment_warning?: string;
    };
    content?: {
      phase: 'planning' | 'restoring' | 'generating' | 'section-word-adjusting' | 'original-auditing' | 'auditing' | 'table-cleaning' | 'final-section-word-adjusting' | 'total-word-adjusting' | 'illustration-planning' | 'illustration-generating' | 'done';
      planning_total: number;
      planning_completed: number;
      generation_total: number;
      generation_completed: number;
      minimum_words?: number;
      maximum_words?: number;
      section_words?: number;
      strict_section_words?: boolean;
      current_words?: number;
      section_adjustment_total?: number;
      section_adjustment_completed?: number;
      section_adjustment_active_count?: number;
      section_adjustment_item_id?: string;
      section_adjustment_round?: number;
      section_adjustment_round_total?: number;
      total_adjustment_round?: number;
      total_adjustment_round_total?: number;
      total_adjustment_batch_total?: number;
      total_adjustment_batch_completed?: number;
      total_adjustment_batch_failed?: number;
      total_adjustment_active_count?: number;
      total_adjustment_item_id?: string;
      total_adjustment_remaining_words?: number;
      word_control_warning?: string;
      audit_group_total?: number;
      audit_group_completed?: number;
      audit_conflict_total?: number;
      audit_fix_total?: number;
      audit_fix_completed?: number;
      audit_fix_failed?: number;
      audit_repair_mode?: ConsistencyRepairMode | '';
      audit_agent_step_total?: number;
      audit_agent_step_completed?: number;
      audit_agent_step_label?: string;
      audit_agent_changed_sections?: number;
      audit_agent_failed_sections?: number;
      table_cleanup_total?: number;
      table_cleanup_completed?: number;
      table_cleanup_rewritten?: number;
      table_cleanup_skipped?: number;
      illustration_planning_step_total?: number;
      illustration_planning_step_completed?: number;
      illustration_planning_step_label?: string;
      illustration_candidate_ai?: number;
      illustration_candidate_mermaid?: number;
      illustration_candidate_html?: number;
      illustration_selected_ai?: number;
      illustration_selected_mermaid?: number;
      illustration_selected_html?: number;
      illustration_generation_total?: number;
      illustration_generation_completed?: number;
      illustration_generation_ai_total?: number;
      illustration_generation_ai_completed?: number;
      illustration_generation_mermaid_total?: number;
      illustration_generation_mermaid_completed?: number;
      illustration_generation_html_total?: number;
      illustration_generation_html_completed?: number;
      illustration_generation_step_label?: string;
    };
  };
}

export interface BidAnalysisTaskState {
  id: string;
  label: string;
  status: BidAnalysisTaskStatus;
  content: string;
  error?: string;
}

export type BidAnalysisTasks = Record<string, BidAnalysisTaskState>;

export interface GlobalFactGroupState {
  id: string;
  title: string;
  content: string;
  updated_at?: string;
}

export interface ContentGenerationSectionState {
  id: string;
  title: string;
  status: ContentGenerationSectionStatus;
  content: string;
  error?: string;
  updated_at?: string;
}

export type ContentGenerationSections = Record<string, ContentGenerationSectionState>;

export type ContentMermaidDiagramType = 'process' | 'hierarchy' | 'responsibility';
export type ContentIllustrationKind = 'ai' | 'mermaid' | 'html';
export type ContentIllustrationPlacement = 'before' | 'after';

export interface ContentGenerationPlanData {
  writing_focus?: string;
  knowledge: {
    item_ids: string[];
  };
  facts: {
    titles: string[];
  };
  table: {
    needed: boolean;
    purpose: string;
  };
  original_material?: {
    restored: boolean;
    optimized: boolean;
    source_ids: string[];
    source_titles: string[];
    source_hashes: string[];
    restored_chars: number;
    restored_at?: string;
    optimized_at?: string;
  };
}

export interface ContentGenerationPlanState {
  plan_version: number;
  plan: ContentGenerationPlanData;
  table_requirement?: 'none' | 'light' | 'moderate' | 'heavy';
  updated_at?: string;
}

export type ContentGenerationPlans = Record<string, ContentGenerationPlanState>;

export interface ContentIllustrationPlanItem {
  item_id: string;
  kind: ContentIllustrationKind;
  image_type: string;
  title: string;
  section_ids: string[];
  placement: ContentIllustrationPlacement;
  priority: number;
  generation?: {
    status: 'pending' | 'running' | 'success' | 'error';
    mode?: 'normal' | 'agent';
    code?: string;
    source_path?: string;
    asset_url?: string;
    attempts?: number;
    error?: string;
    updated_at?: string;
  };
}

export interface ContentIllustrationPlanState {
  plan_version: number;
  revision: string;
  items: ContentIllustrationPlanItem[];
  updated_at?: string;
}

export interface ContentGenerationRuntimeState {
  phase?: string;
  touched_item_ids?: string[];
  completed_stages?: string[];
  word_adjustment_stage?: 'section' | 'final-section' | 'total';
  word_adjustment_item_id?: string;
  word_adjustment_round?: number;
  word_adjustment_item_rounds?: Record<string, number>;
  word_adjustment_completed_item_ids?: string[];
  target_item_id?: string;
  regenerate_requirement?: string;
  updated_at?: string;
}

export interface TechnicalPlanTenderFile {
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  originalMarkdownPath?: string;
  originalMarkdownChars?: number;
  originalContentHash?: string;
  parserLabel?: string;
  importedAt?: string;
  selectedSectionId?: string;
  selectedSectionTitle?: string;
  updatedAt: string;
}

export interface TechnicalPlanTenderSourceFile {
  id: string;
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string;
  importedAt?: string;
  updatedAt: string;
}

export interface TechnicalPlanOriginalPlanFile {
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string;
  importedAt?: string;
  updatedAt: string;
}

export interface BidSectionLineRange {
  startLine: number;
  endLine: number;
  reason?: string;
}

export interface DetectedBidSection {
  id: string;
  index: number;
  unit: string;
  title: string;
  headLine: string;
  description: string;
  includeRanges?: BidSectionLineRange[];
  evidence?: string[];
}

export interface TechnicalPlanState {
  workflowKind: TechnicalPlanWorkflowKind;
  step: TechnicalPlanStep;
  tenderFile: TechnicalPlanTenderFile | null;
  tenderFiles: TechnicalPlanTenderSourceFile[];
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  projectOverview: string;
  techRequirements: string;
  bidAnalysisMode: BidAnalysisMode;
  bidAnalysisSelectedTaskIds: string[];
  bidAnalysisTasks: BidAnalysisTasks;
  bidAnalysisProgress: number;
  bidSectionMode: BidSectionMode;
  bidSections: DetectedBidSection[];
  bidSectionExtractionStatus: BidSectionExtractionStatus;
  bidSectionExtractionError?: string;
  outlineMode: OutlineMode;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  bidSectionExtractionTask?: BackgroundTaskState;
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  globalFactsTask?: BackgroundTaskState;
  globalFacts: GlobalFactGroupState[];
  contentGenerationTask?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  contentGenerationSections: ContentGenerationSections;
  contentGenerationPlans: ContentGenerationPlans;
  contentIllustrationPlan?: ContentIllustrationPlanState;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  outlineData: OutlineData | null;
}
