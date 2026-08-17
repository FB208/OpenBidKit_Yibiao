export interface SourceReferenceTag {
  id: string;
  name: string;
  type?: 'knowledge_base' | 'key_parameter' | string;
}
export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'point-to-point' | 'other';

export const OUTLINE_CONTENT_MODE_LABELS: Record<OutlineContentMode, string> = {
  'ai-generate': 'AI生成',
  'template-fill': '模板填写',
  'point-to-point': '点对点应答表',
  other: '其他模式',
};

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  attr?: '通用' | '商务' | '资信' | '技术' | '其他';
  content_mode?: OutlineContentMode;
  content_mode_note?: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  source_references?: SourceReferenceTag[];
  children?: OutlineItem[];
  content?: string;
}

export type OutlineMode = 'aligned' | 'response-file';
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
