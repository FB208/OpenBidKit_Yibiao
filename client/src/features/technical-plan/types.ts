import type { OutlineData, OutlineMode } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'bid-analysis' | 'outline-generation' | 'global-facts' | 'content-edit' | 'expand';
export type BidAnalysisMode = 'key' | 'full';
export type BidAnalysisTaskStatus = 'idle' | 'running' | 'success' | 'error';
export type BackgroundTaskType = 'bid-analysis' | 'outline-generation' | 'global-facts-generation' | 'content-generation';
export type BackgroundTaskStatus = 'running' | 'pausing' | 'paused' | 'success' | 'error';
export type ContentGenerationSectionStatus = 'idle' | 'running' | 'success' | 'error';
export type ContentTableRequirement = 'none' | 'light' | 'moderate' | 'heavy';
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
  tableRequirement: ContentTableRequirement;
  minimumWords: number;
  contentConcurrency: number;
  enableConsistencyAudit: boolean;
}

export interface ContentImageStats {
  planned: number;
  attempted: number;
  success: number;
  failed: number;
  skipped: number;
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
    content?: {
      phase: 'planning' | 'generating' | 'outline-expanding' | 'expanding' | 'auditing' | 'illustrating' | 'done';
      planning_total: number;
      planning_completed: number;
      generation_total: number;
      generation_completed: number;
      outline_expansion_total?: number;
      outline_expansion_completed?: number;
      outline_expansion_step_total?: number;
      outline_expansion_step_completed?: number;
      outline_expansion_round?: number;
      outline_expansion_round_total?: number;
      outline_expansion_step_label?: string;
      minimum_words?: number;
      current_words?: number;
      audit_group_total?: number;
      audit_group_completed?: number;
      audit_conflict_total?: number;
      audit_fix_total?: number;
      audit_fix_completed?: number;
      audit_fix_failed?: number;
      illustration_total?: number;
      illustration_completed?: number;
    };
    images?: Partial<ContentImageStats> & {
      total?: ContentImageStats;
      ai?: ContentImageStats;
      mermaid?: ContentImageStats;
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

export type ContentIllustrationType = 'ai' | 'mermaid' | 'none';

export interface ContentGenerationPlanData {
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
  mermaid: {
    needed: boolean;
    title: string;
    code: string;
    priority: number;
    reason: string;
  };
  image: {
    needed: boolean;
    style: 'engineering_diagram' | 'realistic_photo' | '';
    title: string;
    prompt: string;
    priority: number;
    reason: string;
  };
}

export interface ContentGenerationPlanState {
  plan: ContentGenerationPlanData;
  illustration_type: ContentIllustrationType;
  updated_at?: string;
}

export type ContentGenerationPlans = Record<string, ContentGenerationPlanState>;

export interface ContentGenerationRuntimeState {
  phase?: string;
  touched_item_ids?: string[];
  outline_expansion_completed?: number;
  expansion_cycle_item_ids?: string[];
  expansion_attempted_item_ids?: string[];
  expansion_cycle_start_words?: number;
  target_item_id?: string;
  regenerate_requirement?: string;
  updated_at?: string;
}

export interface TechnicalPlanTenderFile {
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string;
  importedAt?: string;
  selectedSectionId?: string;
  selectedSectionTitle?: string;
  selectedSectionHeadLine?: string;
  updatedAt: string;
}

export interface DetectedBidSection {
  id: string;
  index: number;
  title: string;
  headLine: string;
  description: string;
}

export interface TechnicalPlanState {
  step: TechnicalPlanStep;
  tenderFile: TechnicalPlanTenderFile | null;
  projectOverview: string;
  techRequirements: string;
  bidAnalysisMode: BidAnalysisMode;
  bidAnalysisTasks: BidAnalysisTasks;
  bidAnalysisProgress: number;
  outlineMode: OutlineMode;
  referenceKnowledgeDocumentIds: string[];
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  globalFactsTask?: BackgroundTaskState;
  globalFacts: GlobalFactGroupState[];
  contentGenerationTask?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  contentGenerationSections: ContentGenerationSections;
  contentGenerationPlans: ContentGenerationPlans;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  outlineData: OutlineData | null;
}
