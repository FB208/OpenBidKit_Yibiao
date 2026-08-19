import type { OutlineData, OutlineItem } from '../../shared/types';

export type FeasibilityReportStep = 'materials' | 'sources' | 'analysis' | 'outline' | 'parameters' | 'content';
export type FeasibilityProjectType = 'government' | 'enterprise';
export type FeasibilityOutlineTemplate =
  | 'government'
  | 'enterprise'
  | 'industrial'
  | 'hi_tech'
  | 'infrastructure'
  | 'eco_environmental'
  | 'commercial_realestate';
export type FeasibilityTaskType =
  | 'feasibility-analysis'
  | 'feasibility-outline'
  | 'feasibility-outline-adjustment'
  | 'feasibility-parameters'
  | 'feasibility-content'
  | 'feasibility-human-writing';
export type FeasibilityTaskStatus = 'running' | 'pausing' | 'paused' | 'success' | 'error';
export type FeasibilitySaveOutlineReason = 'sort' | 'edit' | 'delete' | 'add-root' | 'add-child' | 'replace';

export interface FeasibilityProjectInfo {
  projectName: string;
  projectType: FeasibilityProjectType;
  industry: string;
  constructionUnit: string;
  location: string;
  constructionContent: string;
  constructionPeriodYears: string;
  operationPeriodYears: string;
  totalInvestment: string;
  fundingSource: string;
}

export interface FeasibilitySourceFile {
  id: string;
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel: string | null;
  importedAt: string;
}

export interface FeasibilityBackgroundTaskState {
  task_id: string;
  type: FeasibilityTaskType;
  status: FeasibilityTaskStatus;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: unknown;
  pause_requested?: boolean;
}

export interface FeasibilitySaveOutlineRequest {
  outlineData: OutlineData;
  reason: FeasibilitySaveOutlineReason;
  idMap?: Record<string, string>;
  affectedNodeIds?: string[];
}

export interface FeasibilityExportOptions {
  includeCover: boolean;
  includePreparationNotes: boolean;
  includeAppendixTables: boolean;
  preparationUnit: string;
  securityLevel: string;
  documentCode: string;
}

export interface FeasibilityReportState {
  step: FeasibilityReportStep;
  projectInfo: FeasibilityProjectInfo;
  sourceFiles: FeasibilitySourceFile[];
  analysisMarkdown: string;
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  referenceDocumentIds: string[];
  keyParametersMarkdown: string;
  outlineData: OutlineData | null;
  analysisTask?: FeasibilityBackgroundTaskState;
  outlineTask?: FeasibilityBackgroundTaskState;
  outlineAdjustmentTask?: FeasibilityBackgroundTaskState;
  parametersTask?: FeasibilityBackgroundTaskState;
  contentTask?: FeasibilityBackgroundTaskState;
  humanWritingTask?: FeasibilityBackgroundTaskState;
}

export const FEASIBILITY_STEPS: FeasibilityReportStep[] = ['materials', 'sources', 'analysis', 'outline', 'parameters', 'content'];

export const FEASIBILITY_STEP_LABELS: Record<FeasibilityReportStep, string> = {
  materials: '项目资料',
  sources: '项目资料文件',
  analysis: '资料分析',
  outline: '报告目录',
  parameters: '关键参数',
  content: '正文生成',
};

export const FEASIBILITY_OUTLINE_TEMPLATE_LABELS: Record<FeasibilityOutlineTemplate, string> = {
  government: '政府投资项目通用大纲（2023版标准）',
  enterprise: '企业投资项目参考大纲（2023版标准）',
  industrial: '工业与高端制造可行性研究大纲',
  hi_tech: '高新技术与数字化/信息化大纲',
  infrastructure: '基础设施与公用事业大纲',
  eco_environmental: '农业与生态环保项目大纲',
  commercial_realestate: '商业/园区与地产开发大纲',
};

export const DEFAULT_FEASIBILITY_PROJECT_INFO: FeasibilityProjectInfo = {
  projectName: '',
  projectType: 'government',
  industry: '',
  constructionUnit: '',
  location: '',
  constructionContent: '',
  constructionPeriodYears: '2',
  operationPeriodYears: '20',
  totalInvestment: '',
  fundingSource: '',
};

export const DEFAULT_FEASIBILITY_EXPORT_OPTIONS: FeasibilityExportOptions = {
  includeCover: true,
  includePreparationNotes: true,
  includeAppendixTables: true,
  preparationUnit: '可行性研究报告编制中心',
  securityLevel: '内部资料 / 普通',
  documentCode: '',
};

export function collectFeasibilityLeaves(items: OutlineItem[] = [], leaves: OutlineItem[] = []): OutlineItem[] {
  items.forEach((item) => {
    if (item.children?.length) {
      collectFeasibilityLeaves(item.children, leaves);
      return;
    }
    leaves.push(item);
  });
  return leaves;
}
