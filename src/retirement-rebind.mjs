import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { requireThat } from './identity.mjs';
import { hostFile, boundedHostFile } from './host-adoption.mjs';
import { requireRetiredReplacement } from './managed-retirement.mjs';
import { drainPath, retirementPath, withPoolGate } from './retirement-admission.mjs';
import { readRetirementFile, writeRetirementFile } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

// Called under the adoption/rollout lock, after live native/source verification.
// The old adopted peers remain bounded historical identities in the retirement
// record. They are not copied into the new executable adoption.
export async function retiredReplacement(pool) {
  const state = await readRetirementFile(retirementPath);
  requireRetiredReplacement(state, pool);
  return state;
}

export async function releaseRetiredReplacement(state, host, publish) {
  const pool = { repository: host.sharedRunner.runner.repository,
    repositoryId: host.sharedRunner.runner.repositoryId, memberId: host.memberId,
    runners: [
      { id: host.sharedRunner.runner.runnerId,
        name: host.sharedRunner.runner.runnerName },
      { id: host.sharedRunner.additionalRunner.id,
        name: host.sharedRunner.additionalRunner.name },
    ] };
  requireRetiredReplacement(state, pool);
  const bytes = JSON.stringify(host) + '\n';
  const existing = await readRetirementFile(retirementPath);
  requireThat(isDeepStrictEqual(existing, state), 'RETIREMENT_ADOPTION_CHANGED');
  const replacement = { pool, bytes, phase: 'publishing' };
  requireThat(!state.replacement || state.replacement.bytes === bytes,
    'RETIREMENT_REPLACEMENT_CHANGED');
  // Intent precedes replacement of the old primary file. If interrupted, the
  // marker remains closed and only the exact successor can finish publication.
  await writeRetirementFile(retirementPath, { ...state, replacement });
  await publish();
  requireThat(await boundedHostFile(hostFile, 262144) === bytes,
    'RETIREMENT_REPLACEMENT_READBACK_REQUIRED');
  const result = await withPoolGate(host, async () => {
    const drain = await readRetirementFile(drainPath);
    requireThat(drain ? drain.retirementId === state.id &&
      isDeepStrictEqual(drain.pool, state.binding.pool) :
      state.replacement?.bytes === bytes, 'RETIREMENT_DRAIN_CHANGED');
    await unlink(drainPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await syncRecoveryDirectory(dirname(drainPath));
    await writeRetirementFile(retirementPath,
      { ...state, replacement: { ...replacement, phase: 'released' } });
    return { released: true };
  });
  requireThat(result.released === true, 'RETIREMENT_RELEASE_PENDING');
}

export async function retiredPeerReplaceable(path, existing) {
  const state = await readRetirementFile(retirementPath);
  if (state?.replacement?.phase !== 'released') return false;
  const snapshot = state.binding.adoptions.find(value => value.path === path);
  return snapshot !== undefined &&
    isDeepStrictEqual(JSON.parse(snapshot.bytes), existing);
}
