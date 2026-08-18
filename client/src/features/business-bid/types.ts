import { DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS } from '../../shared/types';
import type { OutlineData, OutlineExpansionMode, OutlineWordControlOptions } from '../../shared/types';
import type { BackgroundTaskState, GlobalFactGroupState, ContentGenerationSectionState } from '../technical-plan/types';

export type { OutlineData } from '../../shared/types/outline';
export type { BackgroundTaskState, GlobalFactGroupState, ContentGenerationSectionState } from '../technical-plan/types';

export type BusinessBidStep =
  | 'document-analysis'
  | 'bid-analysis'
  | 'outline-generation'
  | 'global-facts'
  | 'content-edit'
  | 'expand';

export type BusinessBidClauseTaskStatus = 'idle' | 'running' | 'success' | 'error';

export interface BusinessBidClauseTaskState {
  id: string;
  label: string;
  status: BusinessBidClauseTaskStatus;
  content: string;
  error?: string;
}

export type BusinessBidClauseTasks = Record<string, BusinessBidClauseTaskState>;

export type BusinessBidClauseResponseStatus = '已响应' | '待确认' | '需复核' | '不满足';

export interface BusinessBidClauseItem {
  id: string;
  category: string;
  title: string;
  requirement: string;
  response_status: BusinessBidClauseResponseStatus;
  response_detail: string;
  deviation: string;
  isImportant: boolean;
}

export interface BusinessBidTenderFile {
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string | null;
  importedAt?: string;
  updatedAt: string;
}

export interface BusinessBidContentGenerationOptions {
  minimumWords: number;
}

export interface BusinessBidState {
  step: BusinessBidStep;
  tenderFile: BusinessBidTenderFile | null;
  referenceTechnicalPlan: boolean;
  referenceTechnicalPlanSummary?: string;
  referenceKnowledgeDocumentIds: string[];
  referenceKnowledgeSnippetIds: string[];
  referenceKnowledgeItemIds: string[];
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  outlineExpansionMode: OutlineExpansionMode;
  /** 招标文件中是否明确列出了商务标应包含的内容清单 */
  hasExplicitContentList?: boolean;
  /** 招标文件中列出的商务标应包含内容清单（如有） */
  requiredBusinessContents?: string[];
  /** 用户选择的知识库模板条目 ID（当 hasExplicitContentList 为 false 时，用户可补充选择） */
  selectedTemplateItemIds?: string[];
  /** 是否已应用了模板来生成矩阵 */
  templateApplied?: boolean;
  clauseAnalysisTasks: BusinessBidClauseTasks;
  clauseAnalysisProgress: number;
  clauseAnalysisTask?: BackgroundTaskState;
  outlineData: OutlineData | null;
  outlineGenerationTask?: BackgroundTaskState;
  clauseItems?: BusinessBidClauseItem[];
  globalFacts: GlobalFactGroupState[];
  globalFactsTask?: BackgroundTaskState;
  contentGenerationOptions?: BusinessBidContentGenerationOptions;
  contentGenerationSections: Record<string, ContentGenerationSectionState>;
  contentGenerationTask?: BackgroundTaskState;
}

export const BUSINESS_BID_STEP_LABELS: Record<BusinessBidStep, string> = {
  'document-analysis': '导入招标文件',
  'bid-analysis': '商务条款解析',
  'outline-generation': '目录生成',
  'global-facts': '全局事实设定',
  'content-edit': '生成正文',
  expand: '复核与导出',
};

export const BUSINESS_BID_STEPS: BusinessBidStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'global-facts',
  'content-edit',
  'expand',
];

export const initialBusinessBidState: BusinessBidState = {
  step: 'document-analysis',
  tenderFile: null,
  referenceTechnicalPlan: false,
  referenceKnowledgeDocumentIds: [],
  referenceKnowledgeSnippetIds: [],
  referenceKnowledgeItemIds: [],
  outlineWordControlOptions: { ...DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS },
  outlineExpansionMode: 'ai-complement',
  hasExplicitContentList: undefined,
  requiredBusinessContents: undefined,
  selectedTemplateItemIds: undefined,
  templateApplied: undefined,
  clauseAnalysisTasks: {},
  clauseAnalysisProgress: 0,
  outlineData: null,
  globalFacts: [],
  contentGenerationSections: {},
};
