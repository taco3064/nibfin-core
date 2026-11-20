import { digest } from './identity.mjs';
import { stages } from './stages.mjs';

export function hostExecution(runner, stage, iteration = 0) {
  return nativeExecution(runner, stage, stages[stage].role, iteration);
}

export function hostWakeExecution(runner) {
  return nativeExecution(runner, 'wake', 'publisher');
}

function nativeExecution(runner, stage, role, iteration = 0) {
  const native = {
    repositoryId: runner.repositoryId,
    runId: runner.runId,
    attempt: runner.attempt,
    jobId: runner.jobId,
    memberId: runner.memberId,
    sourceCommit: runner.sourceCommit,
    stage,
    ...(iteration ? { iteration } : {}),
  };
  const uuid = (kind) => {
    const hash = digest({ kind, native });
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-');
  };
  return {
    id: uuid('execution'),
    sessionId: uuid('session'),
    role,
    actorId: runner.memberId,
    runId: runner.runId,
    attempt: runner.attempt,
    jobId: runner.jobId,
  };
}
