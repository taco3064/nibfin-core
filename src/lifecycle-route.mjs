import { relayUnits } from './relay-host.mjs';
import { callerRecipeVariants } from './caller-recipes.mjs';
import { readCallerContinuity } from './caller-source.mjs';
import { digest, gitBlob, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import {
  originalSharedRepository, sharedDestinationVariable, sharedDispatchWorkflow,
  sharedRepository, sharedRunner,
} from './shared-runner.mjs';
import { observePeer, verifyAdoptionAction } from './shared-peer-adoption.mjs';

export function lifecycleRoute(event, commit) {
  const matches = ['issue', 'issue-managed'].filter(kind => {
    return callerRecipeVariants(kind, commit).some(recipe =>
      [recipe, recipe.replaceAll('\n', '\r\n')].some(text =>
        gitBlob(text) === event?.workflowBlob));
  });
  requireThat(matches.length === 1, 'LIFECYCLE_ROUTE_UNKNOWN');
  return matches[0] === 'issue' ? 'native' : 'artifact';
}

// Observe effective repository configuration, never credential contents. Metadata
// proves configuration only; it does not attest a dispatch or its token permissions.
export async function observeNativeConfiguration(reader, repository, destination) {
  const root = repoPath(repository);
  const variables = await reader.list(root + '/actions/variables', 'variables');
  const secrets = await reader.list(root + '/actions/secrets', 'secrets');
  const values = name => variables.filter(item => item.name === name);
  requireThat(values('NIBFIN_SHARED_RUNNER_POOL').length === 1 &&
    values('NIBFIN_SHARED_RUNNER_POOL')[0].value === 'true' &&
    secrets.filter(item => item.name === 'NIBFIN_WAKE_TOKEN').length === 1,
  'LIFECYCLE_NATIVE_CONFIGURATION_UNKNOWN');
  const configured = values(sharedDestinationVariable);
  requireThat(configured.length <= 1, 'LIFECYCLE_DESTINATION_CONFLICT');
  if (!configured.length || !configured[0].value) {
    requireThat(destination.repository === originalSharedRepository &&
      destination.ref === 'main', 'LIFECYCLE_DESTINATION_CONFLICT');
    return;
  }
  let value;
  try { value = JSON.parse(configured[0].value); }
  catch { requireThat(false, 'LIFECYCLE_DESTINATION_CONFLICT'); }
  requireThat(value?.repository === destination.repository &&
    value.repositoryId === destination.repositoryId,
  'LIFECYCLE_DESTINATION_CONFLICT');
}

export async function observeLifecycleRoute(reader, host, target, source) {
  const { approval, runner, eventRunner } = target.repository;
  requireThat(approval.memberId === host.memberId &&
    runner.repositoryId === approval.repositoryId &&
    runner.repository === approval.repository &&
    eventRunner.repositoryId === approval.repositoryId &&
    eventRunner.repository === approval.repository &&
    eventRunner.reusable?.repository === source.repository &&
    eventRunner.reusable?.commit === source.commit &&
    runner.runnerId === host.runnerId &&
    runner.runnerName === host.sharedRunner.runner.runnerName &&
    eventRunner.runnerId === runner.runnerId &&
    eventRunner.runnerName === runner.runnerName &&
    digest(target.installation) === digest(host.installation),
  'RETIREMENT_REPOSITORY_CHANGED');
  await verifyAdoptionAction(reader, runner.actionCommit, host.installation.pin);
  const current = await observePeer(reader, approval.repository,
    approval.repositoryId, host.memberId, source, runner.actionCommit);
  for (const [recorded, observed] of [[runner, current.action],
    [eventRunner, current.issue]]) {
    requireThat(['workflowId', 'workflowPath', 'workflowBlob'].every(
      field => recorded[field] === observed[field]),
    'RETIREMENT_WAKE_BINDING_CHANGED');
    await readCallerContinuity(reader, approval.repository, {
      path: recorded.workflowPath, commit: recorded.sourceCommit,
      blob: recorded.workflowBlob,
    }, current.head);
  }
  const route = lifecycleRoute(eventRunner, source.commit);
  const { runner: destination } = sharedRunner(host, approval);
  const workflow = await sharedDispatchWorkflow(reader, destination);
  if (route === 'native')
    await observeNativeConfiguration(reader, approval.repository, workflow);
  return { repository: approval.repository, repositoryId: approval.repositoryId,
    route, destination: workflow, head: current.head };
}

export async function observeLifecycleConsumers(reader, host, source, readPeer) {
  const routes = [];
  const ids = host.sharedRunner.repositories;
  requireThat(Array.isArray(ids) && new Set(ids).size === ids.length && ids.length > 0,
    'LIFECYCLE_CONSUMERS_UNKNOWN');
  for (const id of ids) {
    const target = await sharedRepository(host, id, readPeer);
    requireThat(target.repository.approval.repositoryId === id,
      'RETIREMENT_REPOSITORY_CHANGED');
    routes.push(await observeLifecycleRoute(reader, host, target, source));
  }
  return routes;
}

export async function verifyLifecycleActivation(routes, inspectRelay) {
  if (!routes.some(value => value.route === 'artifact')) return;
  const relay = await inspectRelay();
  const timer = relay.service.units?.find(
    unit => unit.Id === relayUnits.find(name => name.endsWith('.timer')));
  requireThat(relay.github.status === 'verified' &&
    relay.recovery.status === 'observed' && relay.recovery.control.paused === false &&
    relay.resources.every(resource => resource.status === 'prepared') &&
    timer?.LoadState === 'loaded' && timer.ActiveState === 'active',
  'RETIREMENT_RELAY_UNVERIFIED');
}
