import { isId, requireThat } from './identity.mjs';
import { maintenanceTarget } from './core-maintenance-dispatch.mjs';
import { dispatchNativeWorkflow, rerunNativeWorkflow }
  from './native-workflow-dispatch.mjs';
import { observeUpgradeWorkflow, upgradeRepository }
  from './upgrade-continuation-proposals.mjs';
import { coreMaintenanceContract as contract } from './core-maintenance-contract.mjs';

function pending(repository, id) {
  return { schemaVersion: 1, status: 'pending', installation: 'pending',
    code: 'UPGRADE_CORE_ACTIVATION_QUEUED', coreRunId: id,
    coreRunURL: `https://github.com/${repository}/actions/runs/${id}` };
}

// The producer owns the activation. The adopted execution repository owns
// assignment, serialization and authenticated administration on this pool.
export async function scheduleCoreMaintenance(reader, token, execution,
  memberId, supplied, {
    dispatch = dispatchNativeWorkflow,
    rerun = rerunNativeWorkflow,
    admit = async () => {},
    installed = async () => false,
  } = {}) {
  const target = await maintenanceTarget(reader, supplied.runId, { includeSource: true });
  requireThat(target.status === 'ready' && target.artifactId === supplied.artifactId,
    'UPGRADE_CORE_ACTIVATION_CHANGED');
  const activeSource = await installed(target);
  if (activeSource)
    return { schemaVersion: 1, status: 'installed', installation: 'complete' };
  await admit();

  const repository = await upgradeRepository(reader, execution);
  requireThat(repository.protected, 'UPGRADE_EXECUTION_BRANCH_UNPROTECTED');
  const official = repository.name === contract.producer;
  let workflow;
  if (official) {
    workflow = await reader.get(`${repository.root}/actions/workflows/` +
      contract.workflowPath.split('/').at(-1));
    requireThat(workflow.path === contract.workflowPath && isId(workflow.id) &&
      workflow.state === 'active', 'UPGRADE_WORKFLOW_UNAVAILABLE');
  } else {
    workflow = await observeUpgradeWorkflow(reader, repository, 'execution', memberId);
    requireThat(workflow.maintenance, 'UPGRADE_CORE_EXECUTION_ROUTE_REQUIRED');
  }
  const path = `${repository.root}/actions/workflows/${workflow.id}`;
  const query = new URLSearchParams({ event: 'workflow_dispatch',
    branch: repository.branch });
  if (typeof target.since === 'string') query.set('created', `>=${target.since}`);
  const runs = await reader.list(`${path}/runs?${query}`, 'workflow_runs');
  const title = `Core maintenance · CD ${target.runId} · artifact ${target.artifactId}`;
  const same = runs.filter(run => isId(run.id) && isId(run.run_attempt) &&
    run.event === 'workflow_dispatch' && run.workflow_id === workflow.id &&
    run.repository?.id === repository.id && run.head_repository?.id === repository.id &&
    run.path === workflow.path && run.head_branch === repository.branch &&
    run.display_title === title);
  const active = same.find(run => run.status !== 'completed');
  if (active) return pending(repository.name, active.id);
  const failed = same.find(run => ['failure', 'timed_out', 'cancelled'].includes(
    run.conclusion) && run.status === 'completed');
  if (failed) {
    await rerun(repository.name, failed.id, token);
    return pending(repository.name, failed.id);
  }
  const run = await dispatch({ repository: repository.name, ref: repository.branch,
    id: workflow.id }, { cd_run_id: String(target.runId),
    activation_artifact_id: String(target.artifactId) }, token);
  requireThat(isId(run.runId), 'UPGRADE_WORKFLOW_DISPATCH_UNCONFIRMED');
  return pending(repository.name, run.runId);
}
