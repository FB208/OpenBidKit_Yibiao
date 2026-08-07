import type { OutlineData, SourceReferenceTag } from '../../shared/types/outline';

export type { SourceReferenceTag };

export type FeasibilityReportStep = 'materials' | 'analysis' | 'outline' | 'parameters' | 'content' | 'financial';

export interface FeasibilityInvestmentData {
  buildingCost: number;       // 建筑工程费 (万元)
  equipmentCost: number;      // 设备及工器具购置费 (万元)
  installationCost: number;   // 安装工程费 (万元)
  otherCost: number;          // 工程建设其他费用 (万元)
  reserveRate: number;        // 基本预备费率 (%)
  constructionInterest: number; // 建设期利息 (万元)
  workingCapital: number;     // 铺底流动资金 (万元)
}

export interface FeasibilityOperatingData {
  annualRevenue: number;     // 年均营业收入 (万元)
  taxRate: number;           // 增值税及附加税率 (%)
  materialCost: number;      // 原辅材料与动力费用 (万元/年)
  laborCost: number;         // 人工及福利费 (万元/年)
  repairCost: number;        // 修理及维护费 (万元/年)
  otherExpense: number;      // 其他制造/管理费用 (万元/年)
  depreciationYears: number; // 固定资产折旧年限 (年)
  salvageRate: number;       // 残值率 (%)
  discountRate: number;      // 行业基准折现率 (%)
}

export interface CashFlowYearRow {
  year: number;
  phase: 'construction' | 'operation';
  revenue: number;
  cashInflow: number;
  investmentOutflow: number;
  operatingOutflow: number;
  taxOutflow: number;
  cashOutflow: number;
  netCashFlow: number;       // 当年净现金流量
  cumNetCashFlow: number;    // 累计净现金流量
  discountedCashFlow: number; // 折现净现金流量
}

export interface SensitivityPoint {
  changePct: number; // -20%, -10%, 0, +10%, +20%
  investmentIrr: number;
  investmentNpv: number;
  revenueIrr: number;
  revenueNpv: number;
  costIrr: number;
  costNpv: number;
}

export interface FeasibilityFinancialEvaluation {
  totalInvestment: number;    // 建设总投资估算 (万元)
  basicReserve: number;       // 基本预备费 (万元)
  annualOperatingCost: number; // 年经营成本 (万元)
  annualDepreciation: number;  // 年折旧费 (万元)
  annualProfit: number;       // 年平均利润总额 (万元)
  npv: number;                // 财务净现值 (万元)
  irr: number;                // 财务内部收益率 (%)
  staticPayback: number;      // 静态投资回收期 (年)
  dynamicPayback: number;     // 动态投资回收期 (年)
  bep: number;                // 盈亏平衡点 (%)
  cashFlows: CashFlowYearRow[];
  sensitivity: SensitivityPoint[];
}

export interface FeasibilityFinancialState {
  investment: FeasibilityInvestmentData;
  operating: FeasibilityOperatingData;
  evaluation: FeasibilityFinancialEvaluation;
}

export interface FeasibilityReportState {
  step: FeasibilityReportStep;
  projectInfo: FeasibilityProjectInfo;
  sourceFiles: FeasibilitySourceFile[];
  analysisMarkdown: string;
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  referenceKnowledgeDocumentIds: string[];
  keyParametersMarkdown: string;
  outlineData: OutlineData | null;
  financialData?: FeasibilityFinancialState;
  analysisTask?: FeasibilityTaskState;
  outlineTask?: FeasibilityTaskState;
  parametersTask?: FeasibilityTaskState;
  contentTask?: FeasibilityTaskState;
  humanWritingTask?: FeasibilityTaskState;
}
export type FeasibilityProjectType = 'government' | 'enterprise';
export type FeasibilityOutlineTemplate =
  | 'government'
  | 'enterprise'
  | 'industrial'
  | 'hi_tech'
  | 'infrastructure'
  | 'eco_environmental'
  | 'commercial_realestate';

export interface FeasibilityProjectInfo {
  projectName: string;
  projectType: FeasibilityProjectType;
  industry: string;
  constructionLocation: string;
  constructionScale: string;
  constructionPeriod: number;
  operationPeriod: number;
  totalInvestment: string;
  fundingSource: string;
  projectUnit: string;
}

export interface FeasibilitySourceFile {
  id: string;
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string;
  importedAt: string;
}

export interface FeasibilityTaskState {
  task_id: string;
  type: string;
  status: 'running' | 'success' | 'error';
  progress: number;
  logs: string[];
  error?: string;
  started_at: string;
  updated_at: string;
}

export interface FeasibilityMissingParameter {
  field: keyof FeasibilityProjectInfo;
  label: string;
  suggestion: string;
}

export interface FeasibilityUncertainParameter {
  id: string;
  source: string;
  parameterName: string;
  expression: string;
  riskLevel: 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface FeasibilityValidationReport {
  score: number;
  missingParameters: FeasibilityMissingParameter[];
  missingMaterials: string[];
  uncertainParameters: FeasibilityUncertainParameter[];
}

export interface FeasibilityConsistencyIssue {
  id: string;
  nodeId: string;
  nodeTitle: string;
  category: 'investment' | 'scale' | 'period' | 'entity_location' | 'unit';
  masterValue: string;
  foundValue: string;
  excerpt: string;
  recommendation: string;
}

export interface FeasibilityConsistencyReport {
  totalCheckedNodes: number;
  issueCount: number;
  issues: FeasibilityConsistencyIssue[];
}

export interface FeasibilityWordExportOptions {
  includeCover?: boolean;
  includePreparationNotes?: boolean;
  includeAppendixTables?: boolean;
  preparationUnit?: string;
  documentCode?: string;
  securityLevel?: string;
}

export interface FeasibilityReportState {
  step: FeasibilityReportStep;
  projectInfo: FeasibilityProjectInfo;
  sourceFiles: FeasibilitySourceFile[];
  analysisMarkdown: string;
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  referenceKnowledgeDocumentIds: string[];
  keyParametersMarkdown: string;
  outlineData: OutlineData | null;
  analysisTask?: FeasibilityTaskState;
  outlineTask?: FeasibilityTaskState;
  parametersTask?: FeasibilityTaskState;
  contentTask?: FeasibilityTaskState;
  humanWritingTask?: FeasibilityTaskState;
}

