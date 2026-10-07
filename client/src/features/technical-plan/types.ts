import type { ExportTemplateScope, OutlineContentMode, TechnicalPlanOutlineData as OutlineData, OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'generation-settings' | 'bid-analysis' | 'outline-generation' | 'global-facts' | 'content-edit' | 'expand';
export type BidAnalysisMode = 'key' | 'full' | 'custom';
export type BidAnalysisTaskStatus = 'idle' | 'running' | 'success' | 'error';
export type BidSectionMode = 'single' | 'multiple';
export type BidSectionExtractionStatus = 'idle' | 'running' | 'success' | 'error';
export type BackgroundTaskType = 'bid-section-extraction' | 'bid-analysis' | 'outline-generation' | 'outline-adjustment' | 'global-facts-generation' | 'global-facts-adjustment' | 'content-generation';
export type BackgroundTaskStatus = 'running' | 'pausing' | 'paused' | 'success' | 'error';
export type ContentGenerationSectionStatus = 'idle' | 'running' | 'success' | 'error';
export type ContentGenerationPhase = 'planning' | 'restoring' | 'generating' | 'sections-completed' | 'word-converting' | 'word-completed' | 'auditing' | 'table-cleaning' | 'layout-checking' | 'business-filling' | 'done';
export type ContentTableRequirement = 'none' | 'light' | 'moderate' | 'heavy';
export type SaveOutlineReason = 'sort' | 'edit' | 'delete' | 'add-root' | 'add-child' | 'replace';
export type OutlineAttribute = '通用' | '商务/资信' | '技术' | '其他' | '目录' | '报价' | '业绩';
export type GlobalFactsMode = 'fabricate' | 'omit' | 'placeholder';

export interface SaveOutlineRequest {
  outlineData: OutlineData;
  reason: SaveOutlineReason;
  affectedNodeIds?: string[];
}

export interface OutlineSelectionItem {
  id: string;
  number: string;
  title: string;
  description: string;
  attr: OutlineAttribute;
  content_mode: OutlineContentMode;
  content_mode_note?: string;
}

export interface OutlineSelectionState {
  items: OutlineSelectionItem[];
  selected_ids: string[];
  confirmed: boolean;
  auto_answer_at?: string;
}

export interface SaveOutlineSelectionRequest {
  taskId: string;
  items: OutlineSelectionItem[];
  selectedIds: string[];
}

export type ContentImageQuantity = 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

export interface ContentGenerationOptions {
  imageQuantity: ContentImageQuantity;
  useAiImages: boolean;
  useMermaidImages: boolean;
  useHtmlImages: boolean;
  htmlImageOptimization: boolean;
  wordCountRepair: boolean;
  layoutCheck: boolean;
  htmlImageTypes: string;
  tableRequirement: ContentTableRequirement;
}

export interface TechnicalPlanGenerationConfig {
  bidAnalysisMode: BidAnalysisMode;
  bidAnalysisSelectedTaskIds: string[];
  bidSectionMode: BidSectionMode;
  outlineMode: OutlineMode;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  globalFactsMode: GlobalFactsMode;
  exportTemplateId: string;
  exportTemplateScope: ExportTemplateScope;
  contentGenerationOptions: ContentGenerationOptions;
}

export interface ContentGenerationProgressItem {
  status: 'pending' | 'running' | 'generating' | 'rendering' | 'success' | 'error' | 'needs_repair' | 'cancelled';
  kind?: 'ai' | 'html' | 'mermaid';
  source_ready?: boolean;
  source_file?: string;
  asset_ref?: string;
}

export interface ContentGenerationWorkflowProgress {
  phase: ContentGenerationPhase;
  round: number;
  step: string;
  label: string;
  started_at: string;
  activity: string;
  steps: Record<string, { items: Record<string, ContentGenerationProgressItem>; unit?: string; total?: number; done?: boolean }>;
}

export interface ContentGenerationProgressDetail {
  mode: 'full' | 'single' | 'html' | 'html-single' | 'correction' | 'business';
  phase: ContentGenerationPhase;
  phase_label: string;
  phase_progress: number;
  completed: number;
  total: number;
  step: string;
  step_label: string;
  unit?: string;
  failed?: number;
  running?: number;
  pending?: number;
  cancelled?: number;
  indeterminate?: boolean;
  // Agent 分批派发的编辑类步骤没有程序可知的总数，只展示累计完成数。
  cumulative?: boolean;
  started_at?: string;
  activity?: string;
  detail_text?: string;
  done?: boolean;
}

export interface BackgroundTaskState {
  task_id: string;
  type: BackgroundTaskType;
  status: BackgroundTaskStatus;
  progress: number;
  progress_detail?: ContentGenerationProgressDetail;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: {
    agent?: {
      task_key: string;
      run_id: string;
      status: 'created' | 'running' | 'waiting-outline-selection' | 'success' | 'interrupted' | 'error';
      phase?: 'initial-outline' | 'outline-selection' | 'score-planning' | 'leaf_allocation' | 'children_generation' | 'leaf_adjustment' | 'leaf_final_decision' | 'outline_review_compaction' | 'outline_review' | 'completed' | string;
      agent_connection?: 'idle' | 'running';
      session_file?: string;
      resume_payload?: {
        reference_knowledge_document_ids?: string[];
        outline_mode?: OutlineMode;
        outline_expansion_mode?: OutlineExpansionMode;
        word_control_options?: OutlineWordControlOptions;
        no_technical_score_mode?: boolean;
      };
    };
    outline_selection?: OutlineSelectionState;
    outline?: {
      phase: 'generating' | 'reviewing' | 'word-adjusting' | 'second-review' | 'done';
      current_leaf_count: number;
      target_leaf_count?: number | null;
      leaf_counts_by_mode?: Partial<Record<OutlineContentMode, number>>;
      minimum_leaf_count?: number;
      maximum_leaf_count?: number;
      word_adjustment_attempts: number;
      word_adjustment_warning?: string;
      word_adjustment_warning_kind?: 'leaf-count' | 'quality';
    };
    content?: {
      phase: ContentGenerationPhase;
      planning_total: number;
      planning_completed: number;
      restoration_total?: number;
      restoration_completed?: number;
      /** 原方案还原保存后按原文可读字数统计，不代表扩写后的内容保留率。 */
      original_restoration?: {
        source_hash: string;
        total_words: number;
        restored_words: number;
        total_images: number;
        restored_images: number;
        rate: number | null;
      };
      generation_total: number;
      generation_completed: number;
      /** 已有非空 HTML 的小节，仅用于预览展示，不代表正式流程完成。 */
      preview_ready_section_ids?: string[];
      generated_html_words?: number;
      generated_html_workspace?: string;
      word_conversion_total?: number;
      word_conversion_completed?: number;
      output_progress?: ContentGenerationProgressDetail;
      workflow_progress?: ContentGenerationWorkflowProgress;
      minimum_words?: number;
      maximum_words?: number;
      section_words?: number;
      current_words?: number;
      consistency_status?: '' | 'extracting' | 'running' | 'completed';
      consistency_extract_completed?: number;
      consistency_extract_total?: number;
      consistency_summary?: string;
      consistency_remaining_issues?: string[];
      table_cleanup_total?: number;
      table_cleanup_completed?: number;
      layout_status?: 'checking' | 'supplementing' | 'rechecking' | 'completed';
      layout_total?: number;
      layout_completed?: number;
      developer_stage_gate?: ContentGenerationPhase;
      business_fill?: BusinessTemplateFillState;
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

export interface ContentGenerationPlanData {
  writing_focus?: string;
  /** 小节配图适配性，0-10 分，目前仅供正文编排记录。 */
  image_suitability_score: number;
  /** 编排后由程序按全文评分和配图比例决定是否参与新增配图。 */
  image_needed: boolean;
  knowledge: {
    item_ids: string[];
  };
  table: {
    needed: boolean;
    purpose: string;
  };
  original_material?: {
    restored: boolean;
    optimized: boolean;
    source_hash: string;
    /** 原文件行号从 1 开始，包含首尾；不同小节的范围不可重叠。 */
    source_ranges: { start_line: number; end_line: number }[];
    restored_words: number;
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

/** 商务模版填写副流程状态，统计以填写项为单位（同名字段或表格单元格）。 */
export interface BusinessTemplateFillState {
  phase: 'filling' | 'reviewing' | 'rendering' | 'completed';
  status: 'running' | 'paused' | 'interrupted' | 'error' | 'success';
  field_count: number;
  filled_count: number;
  manual_count: number;
  unresolved: Array<{ label: string; reason: string }>;
  /** 逐行清单表中未使用、已留空的行数。 */
  blank_row_count?: number;
  /** 连续修复无改善后按原样放行的质量问题。 */
  accepted_issues?: string[];
  error?: string | null;
  /** 等待确认字段值时自动确认的截止时间。 */
  auto_answer_at?: string;
  /** 字段值由用户确认还是自动确认。 */
  confirmed_by?: 'user' | 'auto';
  updated_at?: string;
}

/** 商务模版确认弹窗中的一个填写项：同名字段合并，逐行清单表按表格和行号区分。 */
export interface BusinessFillReviewUnit {
  key: string;
  name: string;
  kind: 'text' | 'choice' | 'attachment';
  fill_by: 'ai' | 'manual';
  instruction?: string;
  options?: string[];
  table_id?: string;
  row?: number;
  value?: string;
  selected?: string[];
  image_id?: string;
  blank?: boolean;
  unresolved_reason?: string;
}

/** 资信库图片选项，group 为所属记录。 */
export interface BusinessFillReviewImage {
  image_id: string;
  group: string;
  label: string;
  name: string;
  asset_url: string;
}

export interface BusinessFillReview {
  units: BusinessFillReviewUnit[];
  images: BusinessFillReviewImage[];
}

/** 用户确认的填写项值，空值不提交。 */
export interface BusinessFillReviewValue {
  key: string;
  value?: string;
  selected?: string[];
  image_id?: string;
}

export interface ContentGenerationRuntimeState {
  /** 已确认的 HTML 实际字数，按稳定小节 ID 保存，不保存 HTML 正文。 */
  section_words?: Record<string, number>;
  /** HTML 位于 Agent 会话目录；Word 文件相对于独立的业务输出目录。 */
  html_output?: {
    workspace_dir: string;
    word_output_dir: string;
    word_sections: Array<{ section_id: string; file: string }>;
  };
  generation_started?: boolean;
  direct_generation_item_ids?: string[];
  pending_item_ids?: string[];
  phase?: string;
  touched_item_ids?: string[];
  completed_stages?: string[];
  developer_stage_gate?: ContentGenerationPhase | '';
  target_item_id?: string;
  regenerate_requirement?: string;
  business_fill?: BusinessTemplateFillState;
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
  sourceDocxPath?: string;
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
  outlineAdjustmentTask?: BackgroundTaskState;
  globalFactsMode: GlobalFactsMode;
  globalFactsTask?: BackgroundTaskState;
  globalFactsAdjustmentTask?: BackgroundTaskState;
  globalFacts: GlobalFactGroupState[];
  contentGenerationTask?: BackgroundTaskState;
  exportTemplateId: string;
  exportTemplateScope: ExportTemplateScope;
  contentGenerationOptions?: ContentGenerationOptions;
  contentGenerationSections: ContentGenerationSections;
  contentGenerationPlans: ContentGenerationPlans;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  bidTemplateExists?: boolean;
  outlineData: OutlineData | null;
}
