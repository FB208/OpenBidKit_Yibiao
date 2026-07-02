import { useEffect, useState } from 'react';
import { technicalPlanStorage } from '../services/technicalPlanStorage';
import type { TechnicalPlanState } from '../types';

const initialState: TechnicalPlanState = {
  workflowKind: 'technical-plan',
  step: 'document-analysis',
  tenderFile: null,
  originalPlanFile: null,
  customOutlineFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisSelectedTaskIds: [],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  bidSectionMode: 'single',
  bidSections: [],
  bidSectionExtractionStatus: 'idle',
  bidSectionExtractionError: undefined,
  outlineMode: 'aligned',
  outlineExpansionMode: 'ai-complement',
  referenceKnowledgeDocumentIds: [],
  bidSectionExtractionTask: undefined,
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  globalFactsTask: undefined,
  globalFacts: [],
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
          setState({ ...initialState, ...cachedState, outlineExpansionMode: cachedState.outlineExpansionMode || 'ai-complement' });
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
