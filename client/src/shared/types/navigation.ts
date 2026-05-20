export type SectionId =
  | 'technical-plan'
  | 'business-bid'
  | 'knowledge-base'
  | 'duplicate-check'
  | 'rejection-check'
  | 'bid-opportunity'
  | 'developer-test'
  | 'settings';

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
}
