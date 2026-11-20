import { isDeepStrictEqual } from 'node:util';
import { requireThat, isId, isSha } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { verifyActionsIdentity } from './actions-identity.mjs';
import { jobCheckRunId, assignedNativeJob } from './native-job-check.mjs';
import { nativeWorkerFrame } from './native-worker-frame.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { coreMaintenanceContract as contract } from './core-maintenance-contract.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { rolloutPlanPath } from './rollout-admission.mjs';
import { upgradeContinuationContract } from './upgrade-continuation-contract.mjs';
import { requireAdoptedMaintenanceSource } from './upgrade-continuation-proposals.mjs';

const scopes = new WeakMap();
const requiredLabels = ['self-hosted', 'nibfin-shared'];

export function requireCoreMaintenance(scope, context, target) {
  const value = scopes.get(scope);
  requireThat(value && value.context === requireManagerContext(context),
    'CORE_MAINTENANCE_NOT_ADMITTED');
  if (target !== undefined) requireThat(isDeepStrictEqual(value.target, target),
    'CORE_MAINTENANCE_TARGET_CHANGED');
  return value;
}

export function coreMaintenanceProvenance(scope, context) {
  return structuredClone(requireCoreMaintenance(scope, context).provenance);
}

function nativeIds(request) {
  requireThat(request && ['runId', 'attempt', 'jobId', 'runnerId']
    .every(key => isId(request[key])), 'CORE_MAINTENANCE_IDENTITY_REQUIRED');
}

function invokerRunner(pool, host, uid) {
  const index = uid === host.runnerUid ? 0 :
    uid === host.sharedRunner.additionalRunner.uid ? 1 : -1;
  requireThat(index >= 0 && isId(uid), 'CORE_MAINTENANCE_INVOKER_CHANGED');
  return pool.runners[index];
}

// Root-owned host adoption selects the pool and repository. Request fields can
// locate a native object but cannot select a workflow, mode, UID or executable.
async function observeNativeJob(context, host, request, invokerUid, reader) {
  requireManagerContext(context);
  nativeIds(request);
  const pool = managerHostRegistrations(host, context);
  const selected = invokerRunner(pool, host, invokerUid);
  requireThat(selected.id === request.runnerId,
    'CORE_MAINTENANCE_INVOKER_CHANGED');
  const root = repoPath(pool.repository);
  const [repository, run, job] = await Promise.all([
    reader.get(root),
    reader.get(`${root}/actions/runs/${request.runId}/attempts/${request.attempt}`),
    reader.get(`${root}/actions/jobs/${request.jobId}`),
  ]);
  const adoptedRoute = run.path === upgradeContinuationContract.recipes.execution;
  requireThat(adoptedRoute ||
    pool.repository === contract.producer && run.path === contract.workflowPath,
  'CORE_MAINTENANCE_RUN_UNTRUSTED');
  const workflowPath = adoptedRoute
    ? upgradeContinuationContract.recipes.execution : contract.workflowPath;
  const filename = workflowPath.split('/').at(-1);
  const workflow = await reader.get(`${root}/actions/workflows/${filename}`);
  const branch = repository.default_branch;
  const ref = `refs/heads/${branch}`;
  const adopted = host.sharedRunner.caller;
  requireThat(repository.id === pool.repositoryId &&
    repository.full_name === pool.repository && repository.private === false &&
    repository.archived === false && repository.disabled === false &&
    repository.owner?.id === adopted.ownerId && adopted.ref === ref,
  'CORE_MAINTENANCE_REPOSITORY_CHANGED');
  const head = await reader.get(`${root}/branches/${encodeURIComponent(branch)}`);
  requireThat(head.protected === true && isSha(head.commit?.sha),
    'CORE_MAINTENANCE_SOURCE_UNTRUSTED');
  requireThat(isId(run.actor?.id) && isId(run.triggering_actor?.id) &&
    run.id === request.runId && run.run_attempt === request.attempt &&
    run.status === 'in_progress' && run.conclusion === null &&
    run.event === contract.eventName && run.path === workflowPath &&
    run.head_branch === branch && isSha(run.head_sha) &&
    run.repository?.id === pool.repositoryId &&
    run.head_repository?.id === pool.repositoryId &&
    run.workflow_id === workflow.id && workflow.path === workflowPath &&
    workflow.state === 'active' && isId(workflow.id) &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 0,
  'CORE_MAINTENANCE_RUN_UNTRUSTED');
  if (head.commit.sha !== run.head_sha) {
    const comparison = await reader.get(`${root}/compare/${run.head_sha}...` +
      head.commit.sha);
    requireThat(['identical', 'ahead'].includes(comparison.status),
      'CORE_MAINTENANCE_SOURCE_UNTRUSTED');
  }
  if (adoptedRoute) {
    const observed = { root };
    await requireAdoptedMaintenanceSource(reader, observed, run.head_sha, pool.memberId);
    if (run.head_sha !== head.commit.sha)
      await requireAdoptedMaintenanceSource(reader, observed, head.commit.sha,
        pool.memberId);
  }
  requireThat(job.id === request.jobId && job.run_id === request.runId &&
    job.run_attempt === request.attempt && job.head_sha === run.head_sha &&
    job.status === 'in_progress' && job.conclusion === null &&
    job.name === contract.jobName && job.runner_id === selected.id &&
    job.runner_name === selected.name && requiredLabels.every(label =>
      job.labels?.includes(label)), 'CORE_MAINTENANCE_JOB_UNTRUSTED');
  const checkRunId = jobCheckRunId(job, pool.repository);
  const check = await reader.get(`${root}/check-runs/${checkRunId}`);
  requireThat(check.id === checkRunId && check.head_sha === run.head_sha &&
    check.app?.slug === 'github-actions' && check.name === contract.jobName &&
    check.status === 'in_progress' && check.conclusion === null,
  'CORE_MAINTENANCE_CHECK_CHANGED');
  return { repository: pool.repository, repositoryId: pool.repositoryId,
    ownerId: repository.owner.id, runId: run.id, attempt: run.run_attempt,
    jobId: job.id, runnerId: selected.id, runnerName: selected.name, invokerUid,
    actorId: run.actor.id, triggeringActorId: run.triggering_actor.id,
    sourceCommit: run.head_sha, workflowId: workflow.id, checkRunId,
    ...(adoptedRoute ? { workflowPath } : {}),
    ref, subject: adopted.subject };
}

// The workflow's read-only token observes its assigned job. Privileged Root
// admission separately uses the managed reader's Runner administration access.
async function observeAuthorizedRunner(context, host, request, invokerUid, reader) {
  const provenance = await observeNativeJob(context, host, request, invokerUid,
    reader);
  const pool = managerHostRegistrations(host, context);
  const runner = await reader.get(`${repoPath(pool.repository)}/actions/runners/` +
    provenance.runnerId);
  requireThat(runner.id === provenance.runnerId &&
    runner.name === provenance.runnerName &&
    runner.os?.toLowerCase() === 'linux' && runner.status === 'online' &&
    runner.busy === true && requiredLabels.every(label =>
      runner.labels?.some(value => value.name === label)) &&
    runner.labels?.some(value => value.name === `nibfin-user-${pool.memberId}`),
  'CORE_MAINTENANCE_RUNNER_CHANGED');
  return provenance;
}

// Pre-Worker may identify a native maintenance Job before requesting OIDC.
// This read-only observation never creates a promotion/settlement scope.
export async function observeCoreMaintenanceJob(context, host, request,
  actualInvokerUid, reader) {
  return observeNativeJob(context, host, request, actualInvokerUid, reader);
}

export async function observeCoreMaintenanceFrame(context, host, message,
  actualInvokerUid, reader) {
  const pool = managerHostRegistrations(host, context);
  const selected = invokerRunner(pool, host, actualInvokerUid);
  const frame = nativeWorkerFrame(message);
  const job = await assignedNativeJob(reader, { repository: pool.repository,
    runId: frame.runId, attempt: frame.attempt, sourceCommit: frame.commit,
    runnerId: selected.id, runnerName: selected.name, jobName: contract.jobName },
  frame.guid);
  const provenance = await observeNativeJob(context, host, { runId: frame.runId,
    attempt: frame.attempt, jobId: job.id, runnerId: selected.id },
  actualInvokerUid, reader);
  requireThat(frame.commit === provenance.sourceCommit &&
    frame.github.get('repository') === provenance.repository &&
    frame.number('repository_id') === provenance.repositoryId &&
    frame.number('actor_id') === provenance.actorId &&
    frame.github.get('ref') === provenance.ref &&
    frame.github.get('event_name') === contract.eventName &&
    frame.github.get('workflow_ref') ===
      workflowReference(provenance) &&
    frame.jobName === contract.jobName, 'CORE_MAINTENANCE_FRAME_CHANGED');
  return provenance;
}

function workflowReference(provenance) {
  const path = provenance.workflowPath ?? contract.workflowPath;
  return `${provenance.repository}/${path}@${provenance.ref}`;
}

function mint(context, provenance, target) {
  const scope = Object.freeze({});
  scopes.set(scope, Object.freeze({ context,
    provenance: Object.freeze(structuredClone(provenance)),
    target: Object.freeze(structuredClone(target)) }));
  return scope;
}

export async function admitCoreMaintenance(context, host, request, invokerUid, reader,
  identityOptions) {
  requireThat(request && Object.keys(request).sort().join(',') ===
    'attempt,jobId,runId,runnerId,target,token' && request.target &&
    Object.keys(request.target).sort().join(',') === 'artifactId,runId',
  'CORE_MAINTENANCE_REQUEST_INVALID');
  requireThat(isId(request.target?.runId) && isId(request.target?.artifactId),
    'CORE_MAINTENANCE_TARGET_REQUIRED');
  const provenance = await observeAuthorizedRunner(context, host, request, invokerUid,
    reader);
  await verifyActionsIdentity(request.token, { ...provenance,
    audience: contract.audience, eventName: contract.eventName,
    workflowRef: workflowReference(provenance),
  }, identityOptions);
  const confirmed = await observeAuthorizedRunner(context, host, request, invokerUid,
    reader);
  requireThat(isDeepStrictEqual(provenance, confirmed),
    'CORE_MAINTENANCE_CHANGED_DURING_ADMISSION');
  return mint(context, provenance, request.target);
}

// Only fixed, root-owned rollout-plan provenance reaches this re-entry path.
// It is not an alternate public authentication input. Native state is fresh.
export async function reobserveCoreMaintenance(context, host, reader,
  read = readRetirementFile) {
  requireManagerContext(context);
  const plan = await read(rolloutPlanPath);
  requireThat(plan?.mode === contract.mode && plan.maintenanceInvocation &&
    isId(plan.administratorTarget?.runId) && isId(plan.administratorTarget?.artifactId),
  'CORE_MAINTENANCE_PROVENANCE_REQUIRED');
  const provenance = plan.maintenanceInvocation;
  const current = await observeAuthorizedRunner(context, host, provenance,
    provenance.invokerUid, reader);
  requireThat(isDeepStrictEqual(current, provenance),
    'CORE_MAINTENANCE_PROVENANCE_CHANGED');
  return mint(context, current, plan.administratorTarget);
}

export function isOwnMaintenanceJob(scope, context, repository, run, job) {
  const { provenance: p } = requireCoreMaintenance(scope, context);
  return repository === p.repository && run.id === p.runId &&
    run.run_attempt === p.attempt && job.id === p.jobId &&
    job.run_id === p.runId && job.run_attempt === p.attempt &&
    job.runner_id === p.runnerId && job.runner_name === p.runnerName &&
    job.head_sha === p.sourceCommit && job.name === contract.jobName;
}
