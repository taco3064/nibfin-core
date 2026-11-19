import { digest, requireThat } from './identity.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';

// Existing root-owned peer views may include a Core view used by slot two.
// Carry source fields into those views while retaining their own identities,
// credentials, isolation and routes. Only the installed adoption selects paths.
export async function rolloutPeerTargets(
  binding, targets, validate, pin, source, action,
) {
  const extra = [];
  for (const adopted of binding.adoptions) {
    if (targets.some(target => target.path === adopted.path)) continue;
    requireThat(/^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(adopted.path),
      'ROLLOUT_PEER_PATH_CHANGED');
    await rootOwnedPath(adopted.path);
    const bytes = await boundedHostFile(adopted.path, 262144);
    requireThat(bytes === adopted.bytes, 'ROLLOUT_ADOPTION_CHANGED');
    const current = JSON.parse(bytes);
    const repo = current.repository.approval.repository;
    const canonical = targets.map(target => JSON.parse(target.next))
      .find(host => host.repository.approval.repository === repo);
    requireThat(canonical && digest(current.installation.pin) ===
      digest(JSON.parse(targets[0].current).installation.pin),
    'ROLLOUT_PEER_BINDING_CHANGED');
    const updated = refreshRolloutPeer(current, canonical, pin, source, action, validate);
    extra.push({ path: adopted.path, current: bytes,
      next: JSON.stringify(updated) + '\n' });
  }
  return extra;
}

export function refreshRolloutPeer(current, canonical, pin, source, action, validate) {
  const next = structuredClone(current);
  next.installation = structuredClone(canonical.installation);
  if (next.providerBinding)
    next.providerBinding.components.source = structuredClone(pin);
  next.repository.approval.source = structuredClone(source);
  for (const key of ['runner', 'eventRunner']) {
    const from = canonical.repository[key], to = next.repository[key];
    requireThat(from.workflowId === to.workflowId &&
      from.workflowPath === to.workflowPath,
      'ROLLOUT_PEER_WORKFLOW_CHANGED');
    for (const field of ['sourceCommit', 'workflowBlob', 'actionCommit',
      'actionCoreCommit', 'reusable']) {
      if (Object.hasOwn(from, field)) to[field] = structuredClone(from[field]);
    }
  }
  next.repository.eventCaller = structuredClone(canonical.repository.eventCaller);
  validate(current.repository.approval.repository.split('/')[1],
    current, next, pin, source, action);
  return next;
}
