import type { OutlineData, OutlineMode } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'bid-analysis' | 'outline-generation' | 'content-edit' | 'expand';
export type BidAnalysisMode = 'key' | 'full';
export type BidAnalysisTaskStatus = 'idle' | 'running' | 'success' | 'error';
export type BackgroundTaskType = 'bid-analysis' | 'outline-generation';
export type BackgroundTaskStatus = 'running' | 'success' | 'error';

export interface BackgroundTaskState {
  task_id: string;
  type: BackgroundTaskType;
  status: BackgroundTaskStatus;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface BidAnalysisTaskState {
  id: string;
  label: string;
  status: BidAnalysisTaskStatus;
  content: string;
  error?: string;
}

export type BidAnalysisTasks = Record<string, BidAnalysisTaskState>;

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
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  outlineData: OutlineData | null;
}
