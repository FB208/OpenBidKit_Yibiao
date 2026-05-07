import { useEffect, useRef, useState } from 'react';
import { technicalPlanStorage } from '../services/technicalPlanStorage';
import type { TechnicalPlanState } from '../types';

const initialState: TechnicalPlanState = {
  step: 'document-analysis',
  fileName: '',
  fileContent: '',
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  outlineMode: 'free',
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  contentGenerationTask: undefined,
  contentGenerationSections: {},
  outlineData: null,
};

function hasRunningTask(state: TechnicalPlanState) {
  return state.bidAnalysisTask?.status === 'running'
    || state.outlineGenerationTask?.status === 'running'
    || state.contentGenerationTask?.status === 'running';
}

export function useTechnicalPlanWorkflow() {
  const [state, setState] = useState<TechnicalPlanState>(initialState);
  const [cacheReady, setCacheReady] = useState(false);
  const latestStateRef = useRef(state);
  const cacheReadyRef = useRef(false);

  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  useEffect(() => {
    cacheReadyRef.current = cacheReady;
  }, [cacheReady]);

  useEffect(() => {
    let mounted = true;

    const loadCache = async () => {
      try {
        const cachedState = await technicalPlanStorage.load();
        if (mounted && cachedState) {
          setState({ ...initialState, ...cachedState });
        }
      } catch (error) {
        console.warn('技术方案缓存读取失败', error);
      } finally {
        if (mounted) {
          setCacheReady(true);
        }
      }
    };

    loadCache();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!cacheReady) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (hasRunningTask(state)) {
        return;
      }

      technicalPlanStorage.save(state).catch((error) => {
        console.warn('技术方案缓存保存失败', error);
      });
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [cacheReady, state]);

  useEffect(() => () => {
    if (!cacheReadyRef.current) {
      return;
    }

    if (hasRunningTask(latestStateRef.current)) {
      return;
    }

    technicalPlanStorage.save(latestStateRef.current).catch((error) => {
      console.warn('技术方案缓存保存失败', error);
    });
  }, []);

  return {
    state,
    setState,
  };
}
