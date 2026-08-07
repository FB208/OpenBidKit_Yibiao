export interface SourceReferenceTag {
  id: string;
  name: string;
  type?: 'knowledge_base' | 'key_parameter' | string;
}

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
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

export interface TechnicalRequirementGroup {
  requirement_id: string;
  title: string;
  description: string;
  detail_points: string[];
}
