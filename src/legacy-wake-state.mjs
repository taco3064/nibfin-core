import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat } from './identity.mjs';
import { readRelayState } from './relay-state.mjs';

const association = /^legacy-[a-f0-9]{64}\.json$/;

async function requireReplacement(root, name, except, uid) {
  const record = await readRelayState(root, name, uid);
  requireThat(record && (record.status === 'scheduled' ||
    name === except && record.status === 'pending'), 'ROLLOUT_REPLACEMENT_PENDING');
}

export async function requireLegacyReplacementsSettled(
  root, except, uid = process.getuid(),
) {
  for (const name of await readdir(root)) {
    if (association.test(name)) await requireReplacement(root, name, except, uid);
  }
}

// Only the wake root admits recovery metadata. Nested replacement journals
// retain the ordinary private-directory, lock and pending-effect checks.
export async function inspectLegacyWakeEntry(root, name, uid, except, inspect) {
  if (name === 'legacy-poll.json') {
    const cursor = await readRelayState(root, name, uid);
    requireThat(Number.isSafeInteger(cursor?.position) && cursor.position >= 0,
      'MANAGED_CREDENTIAL_EFFECTS_PENDING');
  } else if (association.test(name)) {
    await requireReplacement(root, name, except, uid);
  } else if (/^legacy-[a-f0-9]{64}$/.test(name)) {
    await inspect(join(root, name));
  } else return false;
  return true;
}
