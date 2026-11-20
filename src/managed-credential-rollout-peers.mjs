import { requireThat, digest } from './identity.mjs';
import { hostFile, boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { requireRolloutClosure, rolloutPlanPath } from './rollout-admission.mjs';

export async function credentialRolloutPeers(paths, verify, {
  plan = () => readRetirementFile(rolloutPlanPath), closure = requireRolloutClosure,
  read = async path => {
    await rootOwnedPath(path);
    return boundedHostFile(path, 262144);
  },
} = {}) {
  const rollout = await plan();
  const apply = rollout?.apply;
  requireThat(rollout?.schemaVersion === 2 && rollout.mode === 'core-only' &&
    rollout.phase === 'applying' && apply?.completed === false &&
    Array.isArray(apply.targets), 'MANAGED_CREDENTIAL_HOST_INVALID');
  await closure(rollout);
  // Only the fixed manager can borrow credentials while ordinary admission
  // remains closed. Every observed peer must be an exact side of this apply.
  for (const path of [hostFile, ...paths]) {
    const target = apply.targets.filter(item => item.path === path);
    requireThat(target.length === 1, 'MANAGED_CREDENTIAL_HOST_INVALID');
    const [{ current, next }] = target;
    const before = JSON.parse(current), after = JSON.parse(next);
    const actual = await read(path);
    requireThat((actual === current || actual === next) &&
      digest(before.installation?.pin) === digest(apply.oldPin) &&
      digest(after.installation?.pin) === digest(rollout.pin),
    'MANAGED_CREDENTIAL_HOST_INVALID');
  }
  await verify(apply.oldPin);
  await verify(rollout.pin);
  await closure(rollout);
}
