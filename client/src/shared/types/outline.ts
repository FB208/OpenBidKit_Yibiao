export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'rule-page' | 'directory-generate' | 'manual-fill' | 'other';

export const OUTLINE_CONTENT_MODE_LABELS: Record<OutlineContentMode, string> = {
  'ai-generate': 'AI生成',
  'template-fill': '模板填写',
  'rule-page': '规则和页码',
  'directory-generate': '目录生成',
  'manual-fill': '人工填写',
  other: '其他模式',
};

/** 规则和页码叶子的应答依据：程序据此给规则和页码 Agent 对应的评分要求。 */
export type OutlineRuleBasis = 'technical' | 'business' | 'both';

export const OUTLINE_RULE_BASIS_LABELS: Record<OutlineRuleBasis, string> = {
  technical: '技术',
  business: '商务',
  both: '技术和商务',
};

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  attr?: '通用' | '商务/资信' | '技术' | '其他' | '目录' | '报价' | '业绩';
  content_mode?: OutlineContentMode;
  content_mode_note?: string;
  rule_basis?: OutlineRuleBasis;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  children?: OutlineItem[];
  content?: string;
}

export type OutlineMode = 'response-file' | 'standalone-technical' | 'standalone-business';
export type OutlineExpansionMode = 'original-only' | 'ai-complement';

export interface OutlineWordControlOptions {
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
}

export const DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS: OutlineWordControlOptions = {
  minimumWords: 0,
  maximumWords: 0,
  sectionWords: 0,
};

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
}

/** 技术方案节点：身份固定，编号由当前树顺序计算。 */
export interface TechnicalPlanOutlineItem extends OutlineItem {
  number: string;
  children?: TechnicalPlanOutlineItem[];
}

export interface TechnicalPlanOutlineData extends OutlineData {
  outline: TechnicalPlanOutlineItem[];
}
