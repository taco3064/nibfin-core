import { isDigest } from './identity.mjs';
import { stages } from './stages.mjs';

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
  if (value?.schemaVersion !== 1 || value.stage !== stage ||
    !isDigest(value.receiptHash)) return false;
  const terminal = stage === 'continue' ? value.terminalStage : stage;
  if (!knownStage(terminal)) return false;
  // Closure is produced only by the existing full delivery proof. A retained
  // pre-merge native result, when available, must keep its real outcome/stage.
  if (terminal === 'close') return value.status === 'completed';
  return value.status === 'completed' && value.code === 'STAGE_COMPLETED' ||
    value.status === 'denied' && value.code === 'STAGE_REQUIRES_CORRECTION';
}
