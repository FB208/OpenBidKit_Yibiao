import type { OutlineData } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'bid-analysis' | 'content-edit' | 'expand';

export interface TechnicalPlanState {
  step: TechnicalPlanStep;
  fileName: string;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
}
