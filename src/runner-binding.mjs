import { repoPath } from './github-read.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readMemberPermission, readPinnedFile } from './github-approval.mjs';
import { readCallerSource, readCallerContinuity } from './caller-source.mjs';
import { wakeRecipe } from './caller-recipes.mjs';

// Provider-side binding only. The caller is trusted Core, executing from an
// installed pinned workflow outside the candidate. No event payload, environment
// variable, runner label or JSON object is sufficient to authenticate that caller.
// Host isolation and a cross-run single-writer proof remain separate gates.
export async function readRunnerBinding(reader, expected) {
  requireThat(
    expected &&
      [
        'repositoryId',
        'runId',
        'attempt',
        'jobId',
        'runnerId',
        'memberId',
        'actorId',
        'workflowId',
      ].every((key) => isId(expected[key])) &&
      isSha(expected.sourceCommit) &&
      (expected.sourceAnchor !== undefined || isSha(expected.workflowBlob)) &&
      typeof expected.runnerName === 'string' &&
      expected.runnerName &&
      typeof expected.jobName === 'string' &&
      expected.jobName &&
      ['workflow_dispatch', 'issues'].includes(
        expected.eventName ?? 'workflow_dispatch',
      ) &&
      /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expected.workflowPath),
    'INVALID_RUNNER_BINDING',
  );
  const root = repoPath(expected.repository);
  const reusablePins = expected.reusable ? [expected.reusable] : [];
  if (expected.wakeWorkflow !== undefined) {
    const wake = expected.wakeWorkflow;
    requireThat(
      expected.reusable?.repository === 'taco3064/nibfin-core' &&
        expected.reusable.path === '.github/workflows/stage.yml' &&
        wake.repository === expected.reusable.repository &&
        wake.commit === expected.reusable.commit &&
        wake.path === '.github/workflows/wake.yml',
      'INVALID_WAKE_WORKFLOW_CHAIN',
    );
    reusablePins.push(wake);
  }
  const repository = await reader.repository(expected.repository);
  requireThat(
    repository?.id === expected.repositoryId &&
      repository.full_name === expected.repository &&
      repository.private === false &&
      repository.archived === false &&
      repository.disabled === false &&
      typeof repository.default_branch === 'string' &&
      repository.default_branch,
    'RUNNER_REPOSITORY_CHANGED',
  );
  const runPath = `${root}/actions/runs/${expected.runId}`;
  const jobPath = `${root}/actions/jobs/${expected.jobId}`;
  const runnerPath = `${root}/actions/runners/${expected.runnerId}`;
  const run = await reader.get(runPath);
  if (expected.sourceAnchor !== undefined) {
    const pin = {
      commit: expected.sourceAnchor,
      path: expected.workflowPath,
      blob: expected.workflowBlob,
    };
    const branch = await reader.get(
      `${root}/branches/${encodeURIComponent(repository.default_branch)}`,
    );
    requireThat(expected.nativePolicy || branch.protected === true,
      'CALLER_BRANCH_UNPROTECTED');
    const recipe =
      expected.actionCommit !== undefined
        ? wakeRecipe(expected.actionCoreCommit, expected, expected.memberId)
        : expected.wakeWorkflow
          ? {
              kind: 'wake',
              coreCommit: expected.wakeWorkflow.commit,
            }
          : expected.eventName === 'issues' &&
              expected.reusable?.path === '.github/workflows/issue.yml'
            ? {
                kind: 'issue',
                coreCommit: expected.reusable.commit,
              }
            : undefined;
    await readCallerSource(reader, expected.repository, pin, run.head_sha, recipe);
    const latest = branch.commit?.sha;
    if (recipe)
      await readCallerSource(reader, expected.repository, pin, latest, recipe);
    else await readCallerContinuity(reader, expected.repository, pin, latest);
  }
  requireThat(
    run?.id === expected.runId &&
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
        reusablePins.length,
    'UNTRUSTED_ACTIONS_RUN',
  );
  for (const pinned of reusablePins) {
    const actual = run.referenced_workflows.find((item) => item.path === pinned.ref);
    requireThat(
      isSha(pinned.commit) &&
        isSha(pinned.blob) &&
        /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(pinned.path) &&
        pinned.ref === `${pinned.repository}/${pinned.path}@${pinned.commit}` &&
        actual?.path === pinned.ref &&
        actual.sha === pinned.commit,
      'REUSABLE_WORKFLOW_SOURCE_CHANGED',
    );
    const source = await reader.repository(pinned.repository);
    requireThat(
      source.full_name === pinned.repository && source.private === false,
      'REUSABLE_SOURCE_NOT_PUBLIC',
    );
    await readPinnedFile(
      reader,
      pinned.repository,
      pinned.path,
      pinned.commit,
      pinned.blob,
    );
  }
  if (!expected.nativePolicy) {
    await readMemberPermission(reader, expected.repository, run.actor);
    await readMemberPermission(reader, expected.repository, run.triggering_actor);
  }
  const workflowPath = `${root}/actions/workflows/${expected.workflowId}`;
  const workflow = await reader.get(workflowPath);
  requireThat(
    workflow?.id === expected.workflowId &&
      workflow.path === expected.workflowPath &&
      workflow.state === 'active',
    'WORKFLOW_DISABLED_OR_CHANGED',
  );
  if (expected.sourceAnchor === undefined) await readPinnedFile(
    reader,
    expected.repository,
    expected.workflowPath,
    expected.sourceCommit,
    expected.workflowBlob,
  );
  const job = await reader.get(jobPath);
  const label = `nibfin-user-${expected.memberId}`;
  requireThat(
    job?.id === expected.jobId &&
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
      job.labels.includes(label),
    'ACTIONS_JOB_BINDING_MISMATCH',
  );
  const checkPrefix = `https://api.github.com${root}/check-runs/`;
  const checkId =
    typeof job.check_run_url === 'string' && job.check_run_url.startsWith(checkPrefix)
      ? job.check_run_url.slice(checkPrefix.length)
      : '';
  requireThat(
    /^[1-9][0-9]*$/.test(checkId) && isId(Number(checkId)),
    'JOB_CHECK_IDENTITY_REQUIRED',
  );
  const runner = await reader.get(runnerPath);
  const runnerOS = typeof runner?.os === 'string' ? runner.os.toLowerCase() : '';
  requireThat(
    runner?.id === expected.runnerId &&
      runner.name === expected.runnerName &&
      /^[a-z][a-z0-9-]{0,31}$/.test(runnerOS) &&
      (expected.os === undefined || runnerOS === expected.os) &&
      runner.status === 'online' &&
      runner.busy === true &&
      Array.isArray(runner.labels) &&
      runner.labels.some((item) => item.name === label) &&
      runner.labels.some((item) => item.name === 'self-hosted'),
    'ACTUAL_RUNNER_BINDING_MISMATCH',
  );
  // Member authorization is independent of workflow initiator and routing label.
  requireThat(expected.member?.id === expected.memberId, 'MEMBER_BINDING_MISMATCH');
  if (!expected.nativePolicy)
    await readMemberPermission(reader, expected.repository, expected.member);
  const [latestRun, latestJob, latestRunner, latestWorkflow] = await Promise.all([
    reader.get(runPath), reader.get(jobPath), reader.get(runnerPath),
    reader.get(workflowPath),
  ]);
  requireThat(
    latestRun.id === run.id && latestRun.run_attempt === run.run_attempt &&
      latestRun.status === run.status && latestRun.head_sha === run.head_sha &&
      latestRun.actor?.id === run.actor.id &&
      latestRun.triggering_actor?.id === run.triggering_actor.id &&
      latestJob.id === job.id && latestJob.run_id === job.run_id &&
      latestJob.run_attempt === job.run_attempt && latestJob.status === job.status &&
      latestJob.runner_id === job.runner_id && latestJob.name === job.name &&
      latestJob.labels?.includes(label) && latestJob.labels.includes('self-hosted') &&
      latestRunner.id === runner.id && latestRunner.status === runner.status &&
      latestRunner.busy === runner.busy && latestRunner.name === runner.name &&
      typeof latestRunner.os === 'string' &&
      latestRunner.os.toLowerCase() === runnerOS &&
      latestRunner.labels?.some(item => item.name === label) &&
      latestRunner.labels.some(item => item.name === 'self-hosted') &&
      latestWorkflow.id === workflow.id && latestWorkflow.path === workflow.path &&
      latestWorkflow.state === workflow.state &&
      (await reader.repository(expected.repository)).default_branch ===
        repository.default_branch,
    'RUNNER_BINDING_CHANGED_DURING_READ',
  );
  return {
    repositoryId: expected.repositoryId,
    runId: run.id,
    attempt: run.run_attempt,
    jobId: job.id,
    checkRunId: Number(checkId),
    actorId: run.actor.id,
    runnerId: runner.id,
    os: runnerOS,
    memberId: expected.memberId,
    sourceCommit: expected.sourceCommit,
    workflowBlob: expected.workflowBlob,
    observationHash: digest({ run: run.id, attempt: run.run_attempt, job: job.id,
      runner: runner.id, workflow: workflow.id }),
  };
}
