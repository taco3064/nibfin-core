// A cleanly finished verifier may report a fixture problem as blocked. Give
// its Candidate author the findings; this does not authorize host recovery or
// infer that an interrupted process or an external effect has settled.
export function candidateCorrectionRequired(receipt, stage = receipt?.stage) {
  if (!['accept', 'review-pr'].includes(stage)) return false;
  if (receipt?.outcome === 'changes_required') return true;
  const report = receipt?.report;
  const termination = report?.termination;
  return stage === 'accept' && receipt?.outcome === 'blocked' &&
    receipt.findings?.length > 0 && report?.producer === 'agent' &&
    ['implementation_defect', 'external_failure'].includes(report.failureClass) &&
    termination?.running === false && termination.exitCode === 0;
}
