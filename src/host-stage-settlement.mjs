import { retryableHostPressure } from './host-memory-pressure.mjs';
import { pendingCIObservation } from './github-ci.mjs';
import { ciCorrectionWaiting } from './ci-recovery.mjs';
import { retryableWriterPressure } from './job-vm-pressure.mjs';
import {
  githubApiWaiting, githubReadWaiting, githubReadWait, observationFailureCode,
} from './observation-failure.mjs';

export async function settleHostStage(run, release, report, currentStage = () => null) {
  let result;
  try {
    result = await run();
  } catch (error) {
    const waiting = githubReadWait(error, undefined, { stage: true });
    const code = waiting?.code ?? observationFailureCode(error);
    report('execution', code);
    result = { schemaVersion: 1, ...(waiting ?? { status: 'denied', code }) };
  }
  // Continuation owns stage selection; the request name is not a terminal stage.
  const stage = result.stage ?? currentStage();
  if (!result.stage && stage) result = { ...result, stage };
  const retryableRead = result.status === 'pending' &&
    (result.code === githubReadWaiting || result.code === githubApiWaiting ||
      result.code === ciCorrectionWaiting ||
      pendingCIObservation(result.code));
  if (result.status === 'pending' && !retryableRead) return result;
  return settleResult(result, release, report, retryableRead);
}

// This closure belongs to the launcher, never to a Worker result or error.
// Its release closure captures the acquired fence and initialized journal.
export function hostPreparationSettlement(execution, release, report) {
  const original = structuredClone(execution);
  let entered = false;
  return {
    enterOwnedWork() { entered = true; },
    async settle(result) {
      if (entered) return result;
      const settled = await settleResult(result, release, report, false);
      return { ...settled, preparationSettlement: {
        execution: original, status: settled === result ? 'settled' : 'pending',
      } };
    },
  };
}

async function settleResult(result, release, report, retryableRead) {
  try {
    await release(result);
    if (retryableHostPressure(result) ||
      result.status === 'denied' && retryableWriterPressure(result.code))
      return { ...result, retrySettled: true };
    return retryableRead ? { ...result, retrySettled: true } : result;
  } catch (error) {
    const localReasons = [
      'EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED',
      'PREVIOUS_HOST_PROCESS_UNRESOLVED', 'HOST_FENCE_CHANGED', 'JOURNAL_CORRUPT',
    ];
    const code = localReasons.includes(error?.code)
      ? error.code : 'HOST_EXECUTION_UNRESOLVED';
    report('settlement', code);
    return { schemaVersion: 1, status: 'pending', code };
  }
}

export async function assertHostSettlement(journal, inspectContainers) {
  await journal.assertIdle();
  await inspectContainers();
}
