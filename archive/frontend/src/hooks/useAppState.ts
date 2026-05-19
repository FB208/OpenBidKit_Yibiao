/**
 * 应用状态管理Hook
 */
import { useState, useCallback } from 'react';
import { AppState, ConfigData, OutlineData } from '../types';
import { draftStorage } from '../utils/draftStorage';

const initialState: AppState = {
  currentStep: 0,
  config: {
    api_key: '',
    base_url: '',
    model_name: 'gpt-3.5-turbo',
  },
  fileContent: '',
  projectOverview: '',
  techRequirements: '',
  outlineData: null,
};

export const useAppState = () => {
  const [state, setState] = useState<AppState>(() => {
    const draft = draftStorage.loadDraft();
    return {
      ...initialState,
      ...(draft || {}),
    };
  });

  const updateConfig = useCallback((config: ConfigData) => {
    setState(prev => ({ ...prev, config }));
  }, []);

  const updateStep = useCallback((step: number) => {
    setState(prev => {
      const next = { ...prev, currentStep: step };
      draftStorage.saveDraft({ currentStep: step });
      return next;
    });
  }, []);

  const updateFileContent = useCallback((fileContent: string) => {
    setState(prev => {
      const next = { ...prev, fileContent };
      draftStorage.saveDraft({ fileContent });
      return next;
    });
  }, []);

  const updateAnalysisResults = useCallback((overview: string, requirements: string) => {
    setState(prev => {
      const next = {
        ...prev,
        projectOverview: overview,
        techRequirements: requirements,
      };
      draftStorage.saveDraft({
        projectOverview: overview,
        techRequirements: requirements,
      });
      return next;
    });
  }, []);

  const updateOutline = useCallback((outlineData: OutlineData) => {
    setState(prev => {
      const next = { ...prev, outlineData };
      draftStorage.saveDraft({ outlineData });
      return next;
    });
  }, []);

  const nextStep = useCallback(() => {
    setState(prev => {
      const nextStepValue = Math.min(prev.currentStep + 1, 2);
      const next = { ...prev, currentStep: nextStepValue };
      draftStorage.saveDraft({ currentStep: nextStepValue });
      return next;
    });
  }, []);

  const prevStep = useCallback(() => {
    setState(prev => {
      const prevStepValue = Math.max(prev.currentStep - 1, 0);
      const next = { ...prev, currentStep: prevStepValue };
      draftStorage.saveDraft({ currentStep: prevStepValue });
      return next;
    });
  }, []);

  const resetState = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    state,
    updateConfig,
    updateStep,
    updateFileContent,
    updateAnalysisResults,
    updateOutline,
    nextStep,
    prevStep,
    resetState,
  };
};
