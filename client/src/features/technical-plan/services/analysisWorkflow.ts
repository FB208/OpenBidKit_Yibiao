import { buildAnalysisMessages } from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { AnalysisType } from '../../../shared/types';

export async function requestDocumentAnalysis(fileContent: string, analysisType: AnalysisType) {
  const messages = buildAnalysisMessages({ fileContent, analysisType });
  return aiClient.chat({ messages, temperature: 0.3, logTitle: `文档解析-${analysisType}` });
}
