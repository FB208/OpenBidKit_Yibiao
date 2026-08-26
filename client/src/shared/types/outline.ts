export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'directory-generate' | 'manual-fill' | 'other';

export const OUTLINE_CONTENT_MODE_LABELS: Record<OutlineContentMode, string> = {
  'ai-generate': 'AI生成',
  'template-fill': '模板填写',
  'directory-generate': '目录生成',
  'manual-fill': '人工填写',
  other: '其他模式',
};

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  attr?: '通用' | '商务/资信' | '技术' | '其他' | '目录' | '报价' | '业绩';
  content_mode?: OutlineContentMode;
  content_mode_note?: string;
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
  strictSectionWords: boolean;
}

export const DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS: OutlineWordControlOptions = {
  minimumWords: 0,
  maximumWords: 0,
  sectionWords: 0,
  strictSectionWords: false,
};

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
}
