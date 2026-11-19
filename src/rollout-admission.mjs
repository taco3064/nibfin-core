import { verifyInstalledSource } from './source-package.mjs';
import { lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { readRetirementFile, writeRetirementFile } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export const rolloutClosurePath = '/etc/nibfin/rollout-admission.json';
export const rolloutPlanPath = '/etc/nibfin/rollout-plan.json';

// Presence, including an unreadable or malformed marker, always closes admission.
export async function requireNoRollout(path = rolloutClosurePath) {
  try {
    await lstat(path);
    requireThat(false, 'MANAGED_POOL_ROLLOUT_PENDING');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function rolloutMarker(plan) {
  return { schemaVersion: 1, pin: plan.pin, binding: plan.binding };
}

export async function requireRolloutClosure(plan) {
  requireThat(digest(await readRetirementFile(rolloutClosurePath)) ===
    digest(rolloutMarker(plan)), 'ROLLOUT_CLOSURE_CHANGED');
}

export async function publishRolloutClosure(plan) {
  const previous = await readRetirementFile(rolloutClosurePath);
  requireThat(!previous || digest(previous) === digest(rolloutMarker(plan)),
    'ROLLOUT_CLOSURE_CHANGED');
  await writeRetirementFile(rolloutClosurePath, rolloutMarker(plan));
}

export async function removeRolloutClosure(plan) {
  await requireRolloutClosure(plan);
  await unlink(rolloutClosurePath);
  await syncRecoveryDirectory(dirname(rolloutClosurePath));
}

// Listener readiness is the sole exception. This does not admit a Worker or a
// Controller, and requires the exact package AND every installed binding readback.
export async function rolloutListenerReady(host) {
  const marker = await readRetirementFile(rolloutClosurePath);
  if (!marker) return false;
  const plan = await readRetirementFile(rolloutPlanPath);
  validateListenerRollout(host, plan, marker);
  for (const target of [...plan.apply.targets, ...(plan.apply.resources ?? [])]) {
    await rootOwnedPath(target.path);
    requireThat(await boundedHostFile(target.path, 262144) === target.next,
      'ROLLOUT_HOST_READBACK_MISMATCH');
  }
  await verifyInstalledSource('/opt/nibfin/core', plan.pin);
  return true;
}

export function validateListenerRollout(host, plan, marker) {
  requireThat(plan?.schemaVersion === 2 &&
    ['verifying', 'complete'].includes(plan.phase) &&
    digest(marker) === digest(rolloutMarker(plan)) &&
    digest(host.installation.pin) === digest(plan.pin) && plan.apply?.completed,
  'ROLLOUT_LISTENER_NOT_READY');
}
