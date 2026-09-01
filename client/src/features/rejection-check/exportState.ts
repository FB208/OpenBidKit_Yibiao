import type { LogicCheckResultState, RejectionCheckResultState, TypoCheckResultState } from './types';

type ExportableResultState = RejectionCheckResultState | TypoCheckResultState | LogicCheckResultState;

function isCurrentExportableResult(result: ExportableResultState, expectedSignature: string) {
  return Boolean(
    expectedSignature
    && result.inputSignature === expectedSignature
    && (result.status === 'success' || result.findings.length > 0),
  );
}

export function hasExportableRejectionResults({
  rejectionCheckResult,
  typoCheckResult,
  logicCheckResult,
  rejectionInputSignature,
  bidSignature,
}: {
  rejectionCheckResult: RejectionCheckResultState;
  typoCheckResult: TypoCheckResultState;
  logicCheckResult: LogicCheckResultState;
  rejectionInputSignature: string;
  bidSignature: string;
}) {
  return isCurrentExportableResult(rejectionCheckResult, rejectionInputSignature)
    || isCurrentExportableResult(typoCheckResult, bidSignature)
    || isCurrentExportableResult(logicCheckResult, bidSignature);
}
