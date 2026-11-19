import { bindRelayOrigin, validateRelayConfiguration, relayConfigFile }
  from './relay-host.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { digest, requireThat } from './identity.mjs';

// Source refresh only: never add an origin, switch caller kind or change a recipe.
export function rolloutRelayConfiguration(config, targets) {
  validateRelayConfiguration(config);
  const hosts = targets.map(target => ({ current: JSON.parse(target.current),
    next: JSON.parse(target.next) }));
  const primary = hosts.find(item => item.current.repository.approval.repository ===
    'taco3064/nibfin-core');
  const origins = config.origins.map(origin => {
    const peer = hosts.find(item => item.current.repository.approval.repositoryId ===
      origin.repositoryId);
    requireThat(peer, 'ROLLOUT_RELAY_ORIGIN_CHANGED');
    bindRelayOrigin(primary.current, peer.current, origin);
    const event = peer.next.repository.eventRunner;
    const next = { ...origin, workflow: { id: event.workflowId,
      path: event.workflowPath, commit: event.sourceCommit, blob: event.workflowBlob } };
    bindRelayOrigin(primary.next, peer.next, next);
    return next;
  });
  return { ...config, origins };
}

export async function prepareRolloutRelay(targets) {
  const config = await readRetirementFile(relayConfigFile);
  if (!config) return [];
  const current = await boundedHostFile(relayConfigFile, 262144);
  return [{ path: relayConfigFile, current,
    next: JSON.stringify(rolloutRelayConfiguration(config, targets)) + '\n' }];
}

export function validateRolloutRelay(apply) {
  requireThat(Array.isArray(apply.resources) && apply.resources.length <= 1,
    'ROLLOUT_APPLY_INTENT_INVALID');
  for (const item of apply.resources) {
    requireThat(item.path === relayConfigFile && digest(JSON.parse(item.next)) ===
      digest(rolloutRelayConfiguration(JSON.parse(item.current), apply.targets)),
    'ROLLOUT_RELAY_ORIGIN_CHANGED');
  }
}
