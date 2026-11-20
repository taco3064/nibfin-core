import { isSha, requireThat } from './identity.mjs';

// Backup suffix names the deployment target, not the old package's source.
export function rolloutPackagePaths(plan, parent = '/opt/nibfin') {
  requireThat(isSha(plan?.pin?.commit), 'ROLLOUT_APPLY_INTENT_INVALID');
  return { live: `${parent}/core`,
    staged: `${parent}/core-staged-${plan.pin.commit}`,
    backup: `${parent}/core-before-${plan.pin.commit}` };
}
