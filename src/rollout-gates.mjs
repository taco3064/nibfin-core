import { withPoolGate } from './retirement-admission.mjs';
import { withRelayGate } from './relay-state.mjs';
import { relayConfigFile, relayStateRoot } from './relay-host.mjs';
import { readRetirementFile, optionalStat } from './retirement-files.mjs';
import { requireThat } from './identity.mjs';

export async function rolloutHasRelay() {
  const configured = await readRetirementFile(relayConfigFile);
  const state = await optionalStat(relayStateRoot);
  if (!configured && !state) return false; // Legacy callers need no local relay.
  requireThat(configured && state?.isDirectory() && !state.isSymbolicLink(),
    'ROLLOUT_RELAY_STATE_UNKNOWN');
  return true;
}

// Lock order is shared by closure and release. The relay owns its gate across
// POST admission; Controllers own pool leases across the admitted operation.
export function withPoolAndDispatchGate(host, relayRoot, action) {
  return withRelayGate(relayRoot, () => withPoolGate(host, action));
}

export async function withRolloutGates(host, action) {
  return await rolloutHasRelay()
    ? withPoolAndDispatchGate(host, relayStateRoot, action)
    : withPoolGate(host, action);
}
