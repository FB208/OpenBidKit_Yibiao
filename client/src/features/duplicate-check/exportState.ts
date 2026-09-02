import type { DuplicateContentAnalysisState, DuplicateImageAnalysisState, DuplicateMetadataAnalysisState, DuplicateOutlineAnalysisState } from '../../shared/types';

function hasCurrentAnalysisResult(
  analysis: DuplicateMetadataAnalysisState | DuplicateOutlineAnalysisState | DuplicateContentAnalysisState | DuplicateImageAnalysisState | undefined,
  signature: string,
  resultCount: number,
) {
  return Boolean(
    signature
    && analysis?.signature === signature
    && (analysis.status === 'success' || resultCount > 0),
  );
}

export function hasExportableDuplicateResults({
  metadataAnalysis,
  outlineAnalysis,
  contentAnalysis,
  imageAnalysis,
  signature,
}: {
  metadataAnalysis?: DuplicateMetadataAnalysisState;
  outlineAnalysis?: DuplicateOutlineAnalysisState;
  contentAnalysis?: DuplicateContentAnalysisState;
  imageAnalysis?: DuplicateImageAnalysisState;
  signature: string;
}) {
  return hasCurrentAnalysisResult(metadataAnalysis, signature, metadataAnalysis?.rows?.length || 0)
    || hasCurrentAnalysisResult(
      outlineAnalysis,
      signature,
      (outlineAnalysis?.duplicateGroups?.length || 0) + (outlineAnalysis?.pairwiseSimilarities?.length || 0),
    )
    || hasCurrentAnalysisResult(contentAnalysis, signature, contentAnalysis?.duplicateSentences?.length || 0)
    || hasCurrentAnalysisResult(imageAnalysis, signature, imageAnalysis?.duplicateImages?.length || 0);
}
