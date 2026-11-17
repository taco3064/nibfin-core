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

function replacementPool(host) {
  return { repository: host.sharedRunner.runner.repository,
    repositoryId: host.sharedRunner.runner.repositoryId, memberId: host.memberId,
    runners: [
      { id: host.sharedRunner.runner.runnerId,
        name: host.sharedRunner.runner.runnerName },
      { id: host.sharedRunner.additionalRunner.id,
        name: host.sharedRunner.additionalRunner.name },
    ] };
}

async function requireReplacementDrain(state) {
  requireThat(isDeepStrictEqual(await readRetirementFile(drainPath),
    { schemaVersion: 1, retirementId: state.id, pool: state.binding.pool }),
  'RETIREMENT_DRAIN_CHANGED');
}

export async function pendingReplacement(host) {
  const state = await readRetirementFile(retirementPath);
  const phase = state?.replacement?.phase;
  if (!['prepared', 'released'].includes(phase) ||
    phase === 'released' && await readRetirementFile(drainPath) === null) return null;
  const pool = replacementPool(host);
  requireRetiredReplacement(state, pool);
  requireThat(isDeepStrictEqual(pool, state.replacement.pool),
    'RETIREMENT_REPLACEMENT_CHANGED');
  await requireReplacementDrain(state);
  return state;
}

export async function prepareRetiredReplacement(state, host, publish) {
  const pool = replacementPool(host);
  requireRetiredReplacement(state, pool);
  await requireReplacementDrain(state);
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
  await writeRetirementFile(retirementPath,
    { ...state, replacement: { ...replacement, phase: 'prepared' } });
}

export async function releaseRetiredReplacement(state, host, verify) {
  const pool = replacementPool(host);
  requireRetiredReplacement(state, pool);
  requireThat(isDeepStrictEqual(pool, state.replacement?.pool) &&
    ['prepared', 'released'].includes(state.replacement.phase),
  'RETIREMENT_REPLACEMENT_CHANGED');
  const result = await withPoolGate(host, async () => {
    requireThat(isDeepStrictEqual(await readRetirementFile(retirementPath), state),
      'RETIREMENT_ADOPTION_CHANGED');
    return commitReplacementAdmission(state, {
      readDrain: () => readRetirementFile(drainPath),
      verify,
      write: value => writeRetirementFile(retirementPath, value),
      open: async () => {
        await unlink(drainPath);
        await syncRecoveryDirectory(dirname(drainPath));
      },
    });
  });
  requireThat(result.released === true, 'RETIREMENT_RELEASE_PENDING');
}

// The marker is the commit point. Workers and the Controller stay closed if
// durable publication succeeds but removing the marker is interrupted.
export async function commitReplacementAdmission(state, ports) {
  const marker = await ports.readDrain();
  if (state.replacement.phase === 'released' && marker === null) {
    requireThat(state.replacement.activationVerified === true,
      'RETIREMENT_REPLACEMENT_VERIFICATION_MISSING');
    return { released: true };
  }
  requireThat(isDeepStrictEqual(marker,
    { schemaVersion: 1, retirementId: state.id, pool: state.binding.pool }),
  'RETIREMENT_DRAIN_CHANGED');
  await ports.verify();
  await ports.write({ ...state, replacement: {
    ...state.replacement, phase: 'released', activationVerified: true,
  } });
  await ports.open();
  return { released: true };
}

export async function retiredPeerReplaceable(path, existing) {
  const state = await readRetirementFile(retirementPath);
  if (!['prepared', 'released'].includes(state?.replacement?.phase)) return false;
  const snapshot = state.binding.adoptions.find(value => value.path === path);
  return snapshot !== undefined &&
    isDeepStrictEqual(JSON.parse(snapshot.bytes), existing);
}
