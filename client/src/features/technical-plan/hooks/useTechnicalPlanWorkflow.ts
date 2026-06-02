import { useEffect, useState } from 'react';
import { technicalPlanStorage } from '../services/technicalPlanStorage';
import type { TechnicalPlanState } from '../types';

const initialState: TechnicalPlanState = {
  step: 'document-analysis',
  tenderFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  outlineMode: 'aligned',
  referenceKnowledgeDocumentIds: [],
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  contentGenerationTask: undefined,
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentGenerationRuntime: undefined,
  outlineData: null,
};

export function useTechnicalPlanWorkflow() {
  const [state, setState] = useState<TechnicalPlanState>(initialState);
  const [hydrated, setHydrated] = useState(false);

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
          setHydrated(true);
        }
      }
    };

    loadCache();

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
