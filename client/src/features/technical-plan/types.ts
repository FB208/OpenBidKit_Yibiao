import type { OutlineData, OutlineMode } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'bid-analysis' | 'outline-generation' | 'content-edit' | 'expand';
export type BidAnalysisMode = 'key' | 'full';
export type BidAnalysisTaskStatus = 'idle' | 'running' | 'success' | 'error';
export type BackgroundTaskType = 'bid-analysis' | 'outline-generation' | 'content-generation';
export type BackgroundTaskStatus = 'running' | 'success' | 'error';
export type ContentGenerationSectionStatus = 'idle' | 'running' | 'success' | 'error';
export type ContentTableRequirement = 'none' | 'light' | 'moderate' | 'heavy';

export interface ContentGenerationOptions {
  useAiImages: boolean;
  maxAiImages: number;
  useMermaidImages: boolean;
  tableRequirement: ContentTableRequirement;
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
      phase: 'planning' | 'generating' | 'illustrating' | 'done';
      planning_total: number;
      planning_completed: number;
      generation_total: number;
      generation_completed: number;
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

export interface TechnicalPlanState {
  step: TechnicalPlanStep;
  fileName: string;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  bidAnalysisMode: BidAnalysisMode;
  bidAnalysisTasks: BidAnalysisTasks;
  bidAnalysisProgress: number;
  outlineMode: OutlineMode;
  referenceKnowledgeDocumentIds: string[];
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  contentGenerationTask?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  contentGenerationSections: ContentGenerationSections;
  contentGenerationPlans: ContentGenerationPlans;
  outlineData: OutlineData | null;
}
