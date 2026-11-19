import { callerRecipeVariants } from './caller-recipes.mjs';
import { gitBlob, requireThat } from './identity.mjs';
import { observePeer } from './shared-peer-adoption.mjs';
import { sharedRepository } from './shared-runner.mjs';
import { repoPath } from './github-read.mjs';

// Reuse the maintained caller verifier. A local configuration flag or the
// existence of a secret cannot establish which route GitHub actually executes.
export async function observeNativeNotificationRoutes(host, reader, readPeer) {
  const actor = await reader.get('/user');
  requireThat(actor.id === host.memberId && actor.type === 'User',
    'NOTIFICATION_CONTROLLER_CHANGED');
  const consumers = [];
  for (const id of host.sharedRunner.repositories) {
    const { repository } = await sharedRepository(host, id, readPeer);
    const { approval, runner, eventRunner } = repository;
    const native = await reader.get(repoPath(approval.repository));
    requireThat(native.id === id && native.full_name === approval.repository,
      'NOTIFICATION_CONSUMER_IDENTITY_CHANGED');
    if (native.archived === true || native.disabled === true) {
      consumers.push({ repository: approval.repository, repositoryId: id,
        retired: true });
      continue;
    }
    const commit = host.installation.pin.commit;
    const observed = await observePeer(reader, approval.repository, id,
      host.memberId, { commit }, runner.actionCommit);
    const recipes = callerRecipeVariants('issue', commit).flatMap(bytes =>
      [gitBlob(bytes), gitBlob(bytes.replaceAll('\n', '\r\n'))]);
    requireThat(recipes.includes(observed.issue.workflowBlob),
      'NOTIFICATION_ARTIFACT_CONSUMER_ACTIVE');
    requireThat([[runner, observed.action], [eventRunner, observed.issue]].every(
      ([adopted, actual]) => ['workflowId', 'workflowPath', 'workflowBlob'].every(
        key => adopted[key] === actual[key])), 'NOTIFICATION_ADOPTION_CHANGED');
    consumers.push({ repository: approval.repository, repositoryId: id });
  }
  requireThat(consumers.length > 0, 'NOTIFICATION_CONSUMERS_UNKNOWN');
  return consumers;
}
