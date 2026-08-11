import type { BusinessBidState } from '../types';
import { initialBusinessBidState } from '../types';

const VALID_STEPS = ['document-analysis', 'bid-analysis', 'outline-generation', 'global-facts', 'content-edit', 'expand'];

function isBusinessBidState(state: BusinessBidState | null): state is BusinessBidState {
  return Boolean(state && VALID_STEPS.includes(state.step));
}

export const businessBidStorage = {
  async load(): Promise<BusinessBidState | null> {
    const state = await window.yibiao?.businessBid.loadState();
    if (!isBusinessBidState(state || null)) {
      return null;
    }
    return { ...initialBusinessBidState, ...state };
  },
};
