import type { TechnicalPlanState, TechnicalPlanStep } from '../types';

const validSteps: TechnicalPlanStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'content-edit',
  'expand',
];

function isTechnicalPlanState(state: TechnicalPlanState | null): state is TechnicalPlanState {
  return Boolean(state && validSteps.includes(state.step));
}

export const technicalPlanStorage = {
  async load(): Promise<TechnicalPlanState | null> {
    const state = await window.yibiao?.workspace.loadTechnicalPlan<TechnicalPlanState>();

    if (!isTechnicalPlanState(state || null)) {
      return null;
    }

    return state || null;
  },

  async save(state: TechnicalPlanState) {
    await window.yibiao?.workspace.saveTechnicalPlan(state);
  },
};
