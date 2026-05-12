export type SectionId = 'technical-plan' | 'knowledge-base' | 'duplicate-check' | 'rejection-check' | 'developer-test' | 'settings';

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
}
