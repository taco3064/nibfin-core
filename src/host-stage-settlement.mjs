import { pendingCIObservation } from './github-ci.mjs';
import { observationFailureCode } from './observation-failure.mjs';

export async function settleHostStage(run, release, report) {
  let result;
  try {
    result = await run();
  } catch (error) {
    const code = observationFailureCode(error);
    report('execution', code);
    result = { schemaVersion: 1, status: 'denied', code };
  }
  if (result.status === 'pending' && !pendingCIObservation(result.code)) return result;
  try {
    await release();
    return result;
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
