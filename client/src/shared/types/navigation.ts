export type SectionId =
  | 'technical-plan'
  | 'business-bid'
  | 'knowledge-base'
  | 'duplicate-check'
  | 'rejection-check'
  | 'bid-opportunity'
  | 'developer-test'
  | 'developer-json-test'
  | 'developer-prompt-lab'
  | 'developer-parser-sandbox'
  | 'developer-export-preview'
  | 'settings';

export interface AppSubMenuItem {
  id: SectionId;
  label: string;
  description: string;
  icon?: 'code' | 'prompt' | 'file' | 'export' | 'tool';
}

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
  children?: AppSubMenuItem[];
}
