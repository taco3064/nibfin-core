import { repoPath } from './github-read.mjs';
import { isId, isSha, requireThat } from './identity.mjs';
import { boundedList } from './local-work-native.mjs';
import { reason } from './local-work-values.mjs';

export async function readLocalBindings(reader, bindings) {
  const errors = [];
  const get = path => reader.get(path);
  const repositories = new Map();
  const registration = new Map();
  const jobs = [];
  const currentRuns = [];
  for (const binding of bindings) {
    const { expected } = binding;
    const key = `${expected.repositoryId}:${expected.workflowId}`;
    if (repositories.has(key)) continue;
    try {
      const repository = await get(repoPath(expected.repository));
      requireThat(repository.id === expected.repositoryId &&
        repository.full_name === expected.repository &&
        repository.private === false && repository.archived === false &&
        repository.disabled === false, 'UNVERIFIED_BINDING');
      const root = repoPath(expected.repository);
      const workflow = await get(`${root}/actions/workflows/${expected.workflowId}`);
      requireThat(workflow.id === expected.workflowId &&
        workflow.path === expected.workflowPath && workflow.state === 'active',
      'UNVERIFIED_BINDING');
      const discovered = [];
      for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
        const runs = await boundedList(reader,
          `${root}/actions/workflows/${workflow.id}/runs?status=${status}`,
          'workflow_runs');
        for (const listed of runs) {
          requireThat(isId(listed.id), 'UNVERIFIED_BINDING');
          if (discovered.some(item => item.id === listed.id)) continue;
          const run = await get(`${root}/actions/runs/${listed.id}`);
          requireThat(run.id === listed.id &&
            isId(run.run_attempt) && isSha(run.head_sha) &&
            run.repository?.id === expected.repositoryId &&
            run.repository.full_name === expected.repository &&
            run.head_repository?.id === expected.repositoryId &&
            run.head_repository.full_name === expected.repository &&
            run.workflow_id === workflow.id && run.path === expected.workflowPath &&
            run.head_branch === repository.default_branch && run.conclusion === null &&
            ['in_progress', 'queued', 'waiting', 'pending', 'requested']
              .includes(run.status),
          'UNVERIFIED_BINDING');
          discovered.push(run);
          currentRuns.push({ run, repositoryId: expected.repositoryId });
          const runJobs = await boundedList(reader,
            `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
          for (const listedJob of runJobs) {
            if (!['in_progress', 'queued', 'waiting', 'pending']
              .includes(listedJob.status))
              continue;
            requireThat(isId(listedJob.id), 'UNVERIFIED_BINDING');
            const job = await get(`${root}/actions/jobs/${listedJob.id}`);
            requireThat(job.id === listedJob.id && job.run_id === run.id &&
              job.run_attempt === run.run_attempt && job.head_sha === run.head_sha &&
              job.status === listedJob.status && job.conclusion === null &&
              job.name === expected.jobName && Array.isArray(job.labels) &&
              job.labels.includes('self-hosted') &&
              job.labels.includes(binding.shared ? 'nibfin-shared'
                : `nibfin-user-${expected.memberId}`),
            'UNVERIFIED_BINDING');
            const url = `https://github.com/${expected.repository}/actions/runs/` +
              `${run.id}/job/${job.id}`;
            requireThat(job.html_url === url, 'UNVERIFIED_BINDING');
            jobs.push({ run, job, repository: expected.repository,
              repositoryId: expected.repositoryId,
              url, observedAt: new Date().toISOString() });
          }
        }
      }
      repositories.set(key, { complete: true });
    } catch (error) {
      repositories.set(key, { complete: false }); errors.push(reason(error));
    }
  }
  for (const binding of bindings) {
    const expected = binding.expected;
    const key = `${expected.repositoryId}:${expected.runnerId}`;
    try {
      const root = repoPath(expected.repository);
      const path = `${root}/actions/runners/${expected.runnerId}`;
      const value = await get(path);
      requireThat(value.id === expected.runnerId && value.name === expected.runnerName &&
        ['online', 'offline'].includes(value.status) && typeof value.busy === 'boolean' &&
        value.labels?.some(label => label.name === `nibfin-user-${expected.memberId}`) &&
        value.labels.some(label => label.name === 'self-hosted'), 'UNVERIFIED_BINDING');
      registration.set(key, { value, observedAt: new Date().toISOString() });
    } catch (error) { errors.push(reason(error)); }
  }
  return { registration, repositories, jobs, runs: currentRuns, errors };
}

export function correlates(candidate, native, binding, subjectId) {
  const { runner, execution } = candidate.context;
  const { run, job } = native;
  return runner?.repositoryId === binding.expected.repositoryId &&
    runner.runnerId === binding.expected.runnerId && runner.memberId === subjectId &&
    runner.runId === run.id && runner.attempt === run.run_attempt &&
    runner.jobId === job.id && runner.sourceCommit === run.head_sha &&
    execution?.runId === run.id && execution.attempt === run.run_attempt &&
    execution.jobId === job.id && execution.actorId === subjectId &&
    run.actor?.id === subjectId && run.triggering_actor?.id === subjectId &&
    job.runner_id === binding.expected.runnerId &&
    job.runner_name === binding.expected.runnerName;
}

export function dispatchMatches(issue, native, bindings, subjectId) {
  return (issue.local.wake?.dispatchRunId === native.run.id ||
    issue.local.wake?.dispatchRunIds?.includes(native.run.id)) &&
    native.run.actor?.id === subjectId &&
    native.run.triggering_actor?.id === subjectId &&
    bindings.some(binding =>
      binding.expected.repositoryId === native.repositoryId &&
      binding.routes.some(route => route.repositoryId === issue.identity.repositoryId));
}
