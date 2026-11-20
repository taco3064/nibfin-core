import { retryableHostPressure } from './host-memory-pressure.mjs';
import { pendingCIObservation } from './github-ci.mjs';
import { ciCorrectionWaiting } from './ci-recovery.mjs';
import { retryableWriterPressure } from './job-vm-pressure.mjs';
import { jobVmExecutorFailures } from './job-vm-exec-relay.mjs';
import {
  githubApiWaiting, githubReadWaiting, githubReadWait, observationFailureCode,
} from './observation-failure.mjs';

export async function settleHostStage(run, release, report, settleLocal) {
  let result;
  try {
    result = await run();
  } catch (error) {
    const waiting = githubReadWait(error, undefined, { stage: true });
    const code = waiting?.code ?? observationFailureCode(error);
    report('execution', code);
    result = { schemaVersion: 1, ...(waiting ?? { status: 'denied', code }) };
  }
  const retryableRead = result.status === 'pending' &&
    (result.code === githubReadWaiting || result.code === githubApiWaiting ||
      result.code === ciCorrectionWaiting ||
      pendingCIObservation(result.code));
  const local = result.status === 'pending' && result.stage === 'deliver' &&
    result.code === 'LOCAL_DELIVER_INTERRUPTED';
  if (local && settleLocal) {
    return settleResult(result, async settled => {
      await settleLocal();
      await release(settled);
    }, report, true);
  }
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
    const retry = retryableRead || retryableHostPressure(result) ||
      result.status === 'denied' && (retryableWriterPressure(result.code) ||
        jobVmExecutorFailures.includes(result.code));
    const settled = retry ? { ...result, retrySettled: true } : result;
    await release(settled);
    return settled;
  } catch (error) {
    const localReasons = [
      'EXTERNAL_EFFECT_UNKNOWN', 'WRITER_NOT_PROVEN_TERMINATED',
      'PREVIOUS_HOST_PROCESS_UNRESOLVED', 'HOST_FENCE_CHANGED', 'JOURNAL_CORRUPT',
      'LOCAL_DELIVER_HAND_BACK_UNPROVEN', 'MCP_JOB_TERMINATION_UNPROVEN',
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
