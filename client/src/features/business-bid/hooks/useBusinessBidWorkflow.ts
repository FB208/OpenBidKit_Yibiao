import { useEffect, useState } from 'react';
import { businessBidStorage } from '../services/businessBidStorage';
import { initialBusinessBidState } from '../types';
import type { BusinessBidState } from '../types';

export function useBusinessBidWorkflow() {
  const [state, setState] = useState<BusinessBidState>(initialBusinessBidState);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadCache = async () => {
      try {
        const cachedState = await businessBidStorage.load();
        if (mounted && cachedState) {
          setState({ ...initialBusinessBidState, ...cachedState });
        }
      } catch (error) {
        console.warn('商务标缓存读取失败', error);
      } finally {
        if (mounted) {
          setHydrated(true);
        }
      }
    };

    void loadCache();

    return () => {
      mounted = false;
    };
  }, []);

  return {
    hydrated,
    state,
    setState,
  };
}
