import { RelayJournal, withRelayGate } from './relay-state.mjs';
import { relayStateRoot } from './relay-host.mjs';
import { optionalStat } from './retirement-files.mjs';
import { reconcileRelayRun } from './relay-observe.mjs';
import { requireThat } from './identity.mjs';

export function notificationAffectsPool(record, binding) {
  if (record.status !== 'pending') return false;
  const destination = record.intent?.destination;
  // A malformed unresolved effect cannot be declared unrelated.
  if (!destination) return true;
  return destination.repositoryId === binding.pool.repositoryId ||
    binding.repositories.some(item => item.repositoryId === record.origin.repositoryId);
}

// Native retirement never needs an obsolete control file. Actual unresolved
// dispatches into this pool still require their original recovery path.
export async function settleLifecycleNotifications(binding, artifact, ports = {}) {
  const root = ports.root ?? relayStateRoot;
  const journal = ports.journal ?? new RelayJournal(root);
  if (artifact) return journal.requireSettled(record =>
    notificationAffectsPool(record, binding));
  const exists = ports.exists ?? (() => optionalStat(root));
  if (!await exists()) return;
  const gate = ports.gate ?? (action => withRelayGate(root, action));
  const result = await gate(async () => {
    await journal.requireReplacementEffectsSettled({ inspect: true,
      affects: record => notificationAffectsPool({ ...record, status: 'pending' },
        binding) });
    requireThat(!(await journal.records()).some(record =>
      notificationAffectsPool(record, binding)), 'RETIREMENT_RELAY_EFFECT_PENDING');
    return { settled: true };
  });
  requireThat(result?.settled === true, 'RETIREMENT_RELAY_BUSY');
}


// Cleanup reuses relay's exact-run recovery, without discovery or another POST.
// Caller holds the existing relay kernel gate. Missing run IDs stay unresolved.
export async function reconcileLifecycleNotifications(journal, reader) {
  for (const record of await journal.records()) {
    if (record.status !== 'pending' || !record.runId) continue;
    try {
      await reconcileRelayRun(reader, record.intent, record.runId);
      await journal.write({ ...record, status: 'consumed' });
    } catch { /* Preserve original evidence on unavailable or conflicting readback. */ }
  }
}
