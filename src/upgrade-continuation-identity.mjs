import { isDeepStrictEqual } from 'node:util';
import { requestActionsIdentity, verifyActionsIdentity } from './actions-identity.mjs';
import { requireThat, isId, isSha } from './identity.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { maintenanceInvoker } from './core-maintenance-request.mjs';
import { nativeWorkerFrame } from './native-worker-frame.mjs';
import { assignedNativeJob, listNativeAttemptJobs, jobCheckRunId }
  from './native-job-check.mjs';
import { upgradeRepository, observeUpgradeWorkflow, upgradeWorkflowSource }
  from './upgrade-continuation-proposals.mjs';
import { exactUpgradeFields, upgradeExecutionTarget }
  from './upgrade-continuation-contract.mjs';
import contract from './upgrade-continuation-contract.json' with { type: 'json' };

const { event, job: jobName, audience } = contract.execution;
const path = contract.recipes.execution;
const labels = ['self-hosted', 'nibfin-shared'];
const scopes = new WeakMap();

export function requireUpgradeInvocation(scope, context) {
  const value = scopes.get(scope);
  requireThat(value && value.context === context, 'UPGRADE_EXECUTION_NOT_ADMITTED');
  return value;
}

export async function observeUpgradeExecutionRun(reader, pool, host, invocation) {
  const repo = await upgradeRepository(reader, pool);
  const workflow = await observeUpgradeWorkflow(reader, repo, 'execution', pool.memberId);
  const run = await reader.get(
    `${repo.root}/actions/runs/${invocation.runId}/attempts/${invocation.attempt}`,
  );
  const ref = repo.ref;
  requireThat(repo.protected && host.sharedRunner.caller.ref === ref &&
    repo.ownerId === host.sharedRunner.caller.ownerId && run.path === path &&
    run.id === invocation.runId && run.run_attempt === invocation.attempt &&
    run.repository?.id === repo.id && run.head_repository?.id === repo.id &&
    run.workflow_id === workflow.id && run.event === event &&
    run.head_branch === repo.branch && isSha(run.head_sha) &&
    run.status === 'in_progress' && run.conclusion === null &&
    isId(run.actor?.id) && isId(run.triggering_actor?.id) &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 0,
  'UPGRADE_EXECUTION_RUN_UNTRUSTED');
  if (repo.head !== run.head_sha) {
    const comparison = `${repo.root}/compare/${run.head_sha}...${repo.head}`;
    const earlier = await reader.get(comparison);
    requireThat(earlier.status === 'ahead' && earlier.merge_base_commit?.sha ===
      run.head_sha, 'UPGRADE_EXECUTION_SOURCE_CHANGED');
    await upgradeWorkflowSource(reader, repo, run.head_sha, 'execution', pool.memberId);
  }
  return { repository: repo.name, repositoryId: repo.id, ownerId: repo.ownerId,
    sourceCommit: run.head_sha, ref, runId: run.id, attempt: run.run_attempt,
    actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
    workflowId: workflow.id, workflowRef: `${repo.name}/${path}@${ref}`,
    subject: host.sharedRunner.caller.subject };
}

export async function observeUpgradeWorker(context, host, message, uid, reader) {
  const frame = nativeWorkerFrame(message);
  const pool = managerHostRegistrations(host, context);
  const selected = pool.runners[maintenanceInvoker(host, uid)];
  const observed = await observeUpgradeExecutionRun(reader, pool, host, frame);
  requireThat(frame.commit === observed.sourceCommit &&
    frame.github.get('repository') === observed.repository &&
    frame.number('repository_id') === observed.repositoryId &&
    frame.number('actor_id') === observed.actorId &&
    frame.github.get('ref') === observed.ref &&
    frame.github.get('event_name') === event &&
    frame.github.get('workflow_ref') === observed.workflowRef &&
    frame.jobName === jobName, 'UPGRADE_EXECUTION_FRAME_CHANGED');
  await assignedNativeJob(reader, { ...observed, jobName,
    runnerId: selected.id, runnerName: selected.name }, frame.guid);
  return observed;
}

async function observeInvocation(reader, pool, host, supplied, selected, checkRunId) {
  const observed = await observeUpgradeExecutionRun(reader, pool, host, supplied);
  const root = `/repos/${observed.repository}`;
  const jobs = await listNativeAttemptJobs(
    reader, root, supplied.runId, supplied.attempt);
  const assigned = jobs.filter(job => job.runner_id === selected.id &&
    job.runner_name === selected.name && job.name === jobName &&
    job.status === 'in_progress' && jobCheckRunId(job, pool.repository) === checkRunId);
  requireThat(assigned.length === 1, 'UPGRADE_EXECUTION_JOB_UNTRUSTED');
  const [job] = assigned;
  const [check, runner] = await Promise.all([
    reader.get(`${root}/check-runs/${checkRunId}`),
    reader.get(`${root}/actions/runners/${selected.id}`),
  ]);
  requireThat(isId(job.id) && job.run_id === observed.runId &&
    job.run_attempt === observed.attempt && job.head_sha === observed.sourceCommit &&
    job.conclusion === null && labels.every(label => job.labels?.includes(label)) &&
    check.id === checkRunId && check.head_sha === observed.sourceCommit &&
    check.app?.slug === 'github-actions' && check.name === jobName &&
    check.status === 'in_progress' && check.conclusion === null &&
    runner.id === selected.id && runner.name === selected.name && runner.busy === true &&
    runner.status === 'online' && runner.os?.toLowerCase() === 'linux' &&
    [...labels, `nibfin-user-${pool.memberId}`].every(label =>
      runner.labels?.some(value => value.name === label)),
  'UPGRADE_EXECUTION_ASSIGNMENT_CHANGED');
  return { ...observed, jobId: job.id, checkRunId, runnerId: selected.id };
}

export async function admitUpgradeInvocation(context, host, supplied, uid, reader,
  { identity = requestActionsIdentity, verify = verifyActionsIdentity } = {}) {
  exactUpgradeFields(supplied, ['kind', 'target', 'repository', 'runId', 'attempt',
    'requestUrl', 'requestToken']);
  const target = upgradeExecutionTarget(supplied.target);
  const pool = managerHostRegistrations(host, context);
  const selected = pool.runners[maintenanceInvoker(host, uid)];
  requireThat(supplied.repository === pool.repository &&
    [supplied.runId, supplied.attempt].every(isId), 'UPGRADE_EXECUTION_REQUEST_INVALID');
  const token = await identity({ requestUrl: supplied.requestUrl,
    requestToken: supplied.requestToken, audience });
  const parts = token.split('.');
  requireThat(parts.length === 3, 'UPGRADE_EXECUTION_IDENTITY_UNAVAILABLE');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const checkRunId = Number(claims.check_run_id);
  requireThat(isId(checkRunId), 'UPGRADE_EXECUTION_CHECK_UNAVAILABLE');
  const observe = () => observeInvocation(reader, pool, host, supplied,
    selected, checkRunId);
  const observed = await observe();
  await verify(token, { ...observed, audience, eventName: event });
  requireThat(isDeepStrictEqual(await observe(), observed),
    'UPGRADE_EXECUTION_ASSIGNMENT_CHANGED');
  const scope = Object.freeze({});
  scopes.set(scope, { context, target: Object.freeze({ ...target }),
    observed: Object.freeze(observed) });
  return scope;
}
