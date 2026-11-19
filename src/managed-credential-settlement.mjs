import { inspectLegacyWakeEntry } from './legacy-wake-state.mjs';
import { blockerReportsName } from './blocker-report-store.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat, digest } from './identity.mjs';
import { readPrivate, privateResource } from './managed-credential-files.mjs';

// Existing stage fences survive until both containers and journal effects settle.
// Inspect only Controller state, never workspaces or untrusted repository files.
export async function managedSettlement(host, { legacyReplacement } = {}) {
  const inspectJournal = async (directory, wake = false, reports = false) => {
    await privateResource(directory, host.uid, true);
    for (const name of await readdir(directory)) {
      if (reports && name === blockerReportsName) {
        // Immutable diagnostics are not operation journals. Existing pool leases
        // settle their producer; preserve the private directory boundary.
        await privateResource(join(directory, name), host.uid, true);
        continue;
      }
      if (wake && await inspectLegacyWakeEntry(directory, name, host.uid,
        legacyReplacement, inspectJournal)) continue;
      if (/^evidence-[a-f0-9]{64}$/.test(name)) {
        const evidence = join(directory, name);
        await privateResource(evidence, host.uid, true);
        requireThat(!(await readdir(evidence)).includes('append.lock'),
          'MANAGED_CREDENTIAL_EFFECTS_PENDING');
        continue;
      }
      requireThat(/^[a-f0-9]{64}$/.test(name), 'MANAGED_CREDENTIAL_EFFECTS_PENDING');
      const subject = join(directory, name);
      await privateResource(subject, host.uid, true);
      const entries = await readdir(subject);
      requireThat(!entries.includes('execution.lock'),
        'MANAGED_CREDENTIAL_EFFECTS_PENDING');
      if (entries.includes('receipts.json')) {
        const record = JSON.parse(await readPrivate(join(subject, 'receipts.json'),
          host, 8 * 1024 * 1024));
        requireThat(record.hash === digest(record.payload) &&
          record.payload?.pending === null, 'MANAGED_CREDENTIAL_EFFECTS_PENDING');
      }
    }
  };
  const entries = await readdir(host.stateRoot);
  requireThat(!entries.includes('stage.lock') && !entries.includes('recovery.lock'),
    'MANAGED_CREDENTIAL_EFFECTS_PENDING');
  if (entries.includes('receipts'))
    await inspectJournal(join(host.stateRoot, 'receipts'));
  for (const name of entries) {
    if (name === 'wake') await inspectJournal(join(host.stateRoot, name), true);
    if (!/^issue-[1-9][0-9]*-[1-9][0-9]*$/.test(name)) continue;
    const root = join(host.stateRoot, name);
    await privateResource(root, host.uid, true);
    const files = await readdir(root);
    requireThat(!files.includes('stage.lock') && !files.includes('recovery.lock'),
      'MANAGED_CREDENTIAL_EFFECTS_PENDING');
    if (files.includes('receipts'))
      await inspectJournal(join(root, 'receipts'), false, true);
  }
}
