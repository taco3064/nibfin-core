import { digest, isDigest, isId } from './identity.mjs';
import { stages } from './stages.mjs';
import { controllerResponse } from './controller-result.mjs';

const knownStage = stage => Object.hasOwn(stages, stage);

// Internal Controller dispositions are not stage results or execution permission.
export function unfinishedObservation(stage) {
  return { schemaVersion: 1, stage, status: 'pending',
    code: 'CONTROLLER_WORK_UNFINISHED', disposition: 'unfinished' };
}

export function isUnfinishedObservation(value, stage) {
  return (stage === 'continue' || knownStage(stage)) &&
    value?.schemaVersion === 1 && value.stage === stage &&
    value.status === 'pending' && value.code === 'CONTROLLER_WORK_UNFINISHED' &&
    value.disposition === 'unfinished' &&
    Object.keys(value).sort().join(',') ===
      'code,disposition,schemaVersion,stage,status';
}

export function isReconciledResult(value, stage) {
  if (value?.schemaVersion !== 1 || value.stage !== stage) return false;
  const terminal = stage === 'continue' ? value.terminalStage : stage;
  if (!knownStage(terminal)) return false;
  // Closure is produced only by the existing full delivery proof.
  if (terminal === 'close') return value.disposition === undefined &&
    value.status === 'completed' && isDigest(value.receiptHash);
  if (value.disposition !== 'recovered-result' || !isDigest(value.resultReference) ||
    value.terminalStage !== terminal) return false;
  const { schemaVersion, terminalStage, disposition, resultReference, retryRun,
    retryAttempt, ...result } = value;
  const projected = controllerResponse({ ...result, stage: terminalStage });
  return projected !== null &&
    digest(projected) === digest({ ...result, stage: terminalStage }) &&
    (retryRun === undefined && retryAttempt === undefined ||
      projected.retrySettled === true && isId(retryRun) && isId(retryAttempt));
}

const reasons = new Set([
  'HOST_EXECUTION_UNRESOLVED', 'HOST_FENCE_CHANGED', 'PREVIOUS_HOST_PROCESS_UNRESOLVED',
  'EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED', 'JOURNAL_CORRUPT',
  'CONTROLLER_RESULT_CORRUPT', 'CONTROLLER_RESULT_CONTRADICTORY',
  'CONTROLLER_RESULT_EVIDENCE_MISSING', 'CONTROLLER_RESULT_EVIDENCE_CHANGED',
  'CONTROLLER_RESULT_REQUIREMENTS_CHANGED', 'CONTROLLER_RESULT_PUBLICATION_UNPROVEN',
  'CONTROLLER_RESULT_PUBLICATION_CHANGED', 'EVIDENCE_OBJECT_CORRUPT',
]);

export function reconciliationReason(error) {
  return reasons.has(error?.code) ? error.code : 'COMPLETION_UNPROVEN';
}

export function reconciledFailure(value, stage) {
  return value.schemaVersion === 1 && value.stage === stage &&
    value.status === 'pending' && value.code === 'CONTROLLER_RECONCILIATION_UNPROVEN'
    ? reconciliationReason({ code: value.reason }) : 'COMPLETION_UNPROVEN';
}
