import { repoPath } from './github-read.mjs';
import { isId, requireThat } from './identity.mjs';

export const isNativeJobGuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Actions Job IDs and Check Run IDs are separate native identities.
export function jobCheckRunId(job, repository) {
  const prefix = `https://api.github.com${repoPath(repository)}/check-runs/`;
  const value = typeof job.check_run_url === 'string' &&
    job.check_run_url.startsWith(prefix) ? job.check_run_url.slice(prefix.length) : '';
  requireThat(/^[1-9][0-9]*$/.test(value) && isId(Number(value)),
    'JOB_CHECK_IDENTITY_REQUIRED');
  return Number(value);
}

// GitHub's documented maximum page size, not a job-count admission limit.
// https://docs.github.com/en/rest/actions/workflow-jobs
export async function listNativeAttemptJobs(reader, root, runId, attempt) {
  const jobs = [];
  let total;
  for (let page = 1; total === undefined || jobs.length < total; page++) {
    const path = `${root}/actions/runs/${runId}/attempts/${attempt}/jobs`;
    const response = await reader.get(`${path}?per_page=100&page=${page}`);
    requireThat(Number.isSafeInteger(response.total_count) && response.total_count >= 0 &&
      Array.isArray(response.jobs) &&
      (total === undefined || response.total_count === total),
    'NATIVE_JOB_LIST_CHANGED');
    total = response.total_count;
    requireThat((response.jobs.length > 0 || total === 0) &&
      jobs.length + response.jobs.length <= total, 'NATIVE_JOB_LIST_INCOMPLETE');
    jobs.push(...response.jobs);
  }
  requireThat(new Set(jobs.map(job => job.id)).size === jobs.length,
    'NATIVE_JOB_LIST_CHANGED');
  return jobs;
}

export async function assignedNativeJob(reader, expected, guid) {
  const { repository, runId, attempt, sourceCommit, runnerId, runnerName, jobName } =
    expected;
  requireThat([runId, attempt, runnerId].every(isId) && isNativeJobGuid(guid),
  'NATIVE_JOB_FRAME_INVALID');
  const root = repoPath(repository);
  const jobs = await listNativeAttemptJobs(reader, root, runId, attempt);
  const matches = jobs.filter(job => job.runner_id === runnerId &&
    job.runner_name === runnerName && job.name === jobName &&
    job.status === 'in_progress');
  requireThat(matches.length === 1 && isId(matches[0].id),
    'SHARED_WORKER_JOB_NOT_ASSIGNED');
  const job = matches[0];
  requireThat(job.run_id === runId && job.run_attempt === attempt &&
    job.head_sha === sourceCommit && job.conclusion === null,
  'SHARED_WORKER_JOB_NOT_ASSIGNED');
  const checkRunId = jobCheckRunId(job, repository);
  const check = await reader.get(`${root}/check-runs/${checkRunId}`);
  requireThat(check.id === checkRunId && check.head_sha === sourceCommit &&
    check.app?.slug === 'github-actions' && check.name === jobName &&
    check.status === 'in_progress' && check.conclusion === null &&
    typeof check.external_id === 'string' &&
    check.external_id.toLowerCase() === guid.toLowerCase(),
  'SHARED_WORKER_JOB_IDENTITY_MISMATCH');
  return job;
}
