// Shared native identity predicates. These check observations, never event authority.
export function matchesActionsRun(expected, run, repository, reusablePins = []) {
  return run?.id === expected.runId &&
    run.run_attempt === expected.attempt &&
    run.status === 'in_progress' &&
    run.conclusion === null &&
    run.event === (expected.eventName ?? 'workflow_dispatch') &&
    run.repository?.id === expected.repositoryId &&
    run.repository.full_name === expected.repository &&
    run.head_repository?.id === expected.repositoryId &&
    run.head_repository.full_name === expected.repository &&
    run.head_branch === repository.default_branch &&
    run.head_sha === expected.sourceCommit &&
    run.path === expected.workflowPath &&
    run.workflow_id === expected.workflowId &&
    run.actor?.id === expected.actorId &&
    run.triggering_actor?.id === expected.actorId &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.length === 0 &&
    Array.isArray(run.referenced_workflows) &&
    run.referenced_workflows.length === reusablePins.length &&
    new Set(run.referenced_workflows.map((item) => item.path)).size ===
      reusablePins.length;
}

export function matchesActionsJob(expected, job) {
  const label = expected.target ? 'nibfin-shared' : `nibfin-user-${expected.memberId}`;
  return job?.id === expected.jobId &&
    job.run_id === expected.runId &&
    job.run_attempt === expected.attempt &&
    job.head_sha === expected.sourceCommit &&
    job.status === 'in_progress' &&
    job.conclusion === null &&
    job.name === expected.jobName &&
    job.runner_id === expected.runnerId &&
    job.runner_name === expected.runnerName &&
    Array.isArray(job.labels) &&
    job.labels.includes('self-hosted') &&
    job.labels.includes(label);
}
