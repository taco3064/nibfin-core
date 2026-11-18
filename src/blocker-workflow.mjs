import { isId, isSha } from './identity.mjs';

// Only the existing Core CI observer supplies this input. Candidate-controlled
// job/step names and private log diagnostics are deliberately excluded.
export function workflowObservation(value, issue) {
  if (!value || !isId(value.runId) || !isId(value.jobId) || !isId(value.attempt) ||
      !isId(value.number) || !isSha(value.head) || !isSha(value.base) ||
      !['success', 'failure', 'timed_out', 'cancelled', 'action_required',
        'neutral', 'skipped', 'stale', 'startup_failure'].includes(value.conclusion))
    return null;
  const url = `https://github.com/${issue.repository}/actions/runs/` +
    `${value.runId}/job/${value.jobId}`;
  if (value.url !== url) return null;
  return { owner: 'github-workflow', repository: issue.repository,
    repositoryId: issue.repositoryId, runId: value.runId, attempt: value.attempt,
    jobId: value.jobId, number: value.number, head: value.head, base: value.base,
    conclusion: value.conclusion, url, logsUnavailable: value.logsUnavailable === true };
}
