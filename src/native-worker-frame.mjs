import { isId, isSha, requireThat } from './identity.mjs';
import { isNativeJobGuid } from './native-job-check.mjs';

// Caller verifies that this is the actual Listener frame in the assigned slot.
// Parsing alone establishes no authorization or privileged execution scope.
export function nativeWorkerFrame(message) {
  const entries = message?.contextData?.github?.d;
  requireThat(message?.contextData?.github?.t === 2 && Array.isArray(entries) &&
    entries.every(entry => typeof entry?.k === 'string'),
  'SHARED_WORKER_CONTEXT_INVALID');
  const github = new Map(entries.map(({ k, v }) => [k, v]));
  const number = key => {
    const value = github.get(key);
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  };
  const runId = number('run_id'), attempt = number('run_attempt');
  const commit = github.get('workflow_sha');
  requireThat(github.size === entries.length && isId(runId) && isId(attempt) &&
    isSha(commit) && github.get('sha') === commit &&
    isNativeJobGuid(message.jobId),
  'SHARED_WORKER_CONTEXT_INVALID');
  return { github, number, runId, attempt, commit, guid: message.jobId,
    jobName: message.jobDisplayName };
}
