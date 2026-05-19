/**
 * 类型定义
 */

export interface ConfigData {
  api_key: string;
  base_url?: string;
  model_name: string;
}

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  children?: OutlineItem[];
  content?: string;
}

export type OutlineMode = 'free' | 'aligned';

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
}

export interface AppState {
  currentStep: number;
  config: ConfigData;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
}
