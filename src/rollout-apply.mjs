import { rename, realpath } from 'node:fs/promises';
import { digest, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { readRetirementFile, writeRetirementFile, optionalStat }
  from './retirement-files.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { rolloutPlanPath } from './rollout-admission.mjs';
import { command } from './process.mjs';
import { prepareStorageReclamation } from './storage-reclamation-install.mjs';
import { reclamationEnvironment } from './storage-reclamation.mjs';

// Maintained filesystem transaction seam. Each interruption point has a positive
// readback; unknown contents stop the transaction without overwriting evidence.
export async function applyRolloutTransaction(plan, ports) {
  const apply = plan.apply;
  requireThat(apply && Array.isArray(apply.targets), 'ROLLOUT_APPLY_INTENT_MISSING');
  const targets = [...apply.targets, ...(apply.resources ?? [])];
  let live = await ports.package('live'), backup = await ports.package('backup');
  const staged = await ports.package('staged');
  requireThat(['old', 'new', 'absent'].includes(live) &&
    ['old', 'absent'].includes(backup) && ['new', 'absent'].includes(staged),
  'ROLLOUT_PACKAGE_STATE_UNKNOWN');
  if (live === 'old') {
    requireThat(backup === 'absent' && staged === 'new',
      'ROLLOUT_PACKAGE_STATE_UNKNOWN');
    await ports.move('live', 'backup');
    live = 'absent'; backup = 'old';
  }
  if (live === 'absent') {
    requireThat(backup === 'old' && staged === 'new', 'ROLLOUT_PACKAGE_STATE_UNKNOWN');
    await ports.move('staged', 'live');
  } else requireThat(live === 'new' && backup === 'old' && staged === 'absent',
    'ROLLOUT_PACKAGE_STATE_UNKNOWN');
  for (const target of targets) {
    const current = await ports.read(target.path);
    requireThat(current === target.current || current === target.next,
      'ROLLOUT_HOST_STATE_UNKNOWN');
    if (current !== target.next) await ports.replace(target.path, target.next);
  }
  requireThat(await ports.package('live') === 'new' &&
    await ports.package('backup') === 'old', 'ROLLOUT_PACKAGE_READBACK_REQUIRED');
  for (const target of targets)
    requireThat(await ports.read(target.path) === target.next,
      'ROLLOUT_HOST_READBACK_MISMATCH');
  await prepareStorageReclamation(ports.installReclamation);
  await ports.save({ ...plan, apply: { ...apply, completed: true },
    phase: 'verifying', pending: 'ROLLOUT_RESTART_REQUIRED' });
  return { status: 'installed', source: apply.source,
    actionCommit: plan.actionCommit, backup: ports.backup,
    repositories: apply.targets.map(target =>
      JSON.parse(target.next).repository.runner.repository) };
}

export async function resumeHostApply(plan, { beforeMutation } = {}) {
  requireThat(digest(await readRetirementFile(rolloutPlanPath)) === digest(plan),
    'ROLLOUT_PLAN_CHANGED');
  const paths = { live: '/opt/nibfin/core',
    staged: `/opt/nibfin/core-staged-${plan.pin.commit}`,
    backup: `/opt/nibfin/core-before-${plan.pin.commit}` };
  return applyRolloutTransaction(plan, {
    backup: paths.backup,
    installReclamation: async () => {
      // Execute the promoted package, not modules cached from the old package.
      const python = '/usr/bin/python3';
      const runtime = paths.live + '/src/security/shared-runtime.py';
      await rootOwnedPath('/usr/bin');
      await rootOwnedPath(await realpath(python));
      await rootOwnedPath(runtime);
      await command(python, ['-I', runtime, 'reclaim-install'],
        { env: reclamationEnvironment });
    },
    package: async name => {
      const path = paths[name];
      if (!await optionalStat(path)) return 'absent';
      await rootOwnedPath(path);
      const manifest = JSON.parse(await boundedHostFile(path + '/nibfin-manifest.json',
        4 * 1024 * 1024));
      const pin = manifest.commit === plan.pin.commit ? plan.pin : plan.apply.oldPin;
      await verifyInstalledSource(path, pin);
      return digest(pin) === digest(plan.pin) ? 'new' : 'old';
    },
    move: async (from, to) => {
      await beforeMutation?.();
      requireThat(!await optionalStat(paths[to]), 'ROLLOUT_PACKAGE_STATE_UNKNOWN');
      await rename(paths[from], paths[to]);
      await syncRecoveryDirectory('/opt/nibfin');
    },
    read: async path => {
      if (!await optionalStat(path)) return null;
      await rootOwnedPath(path);
      return boundedHostFile(path, 262144);
    },
    replace: async (path, bytes) => {
      await beforeMutation?.();
      // Reuse the crash-durable host-owned publisher. It accepts JSON values.
      await writeRetirementFile(path, JSON.parse(bytes));
      // Store its canonical representation in the intent before any mutation.
      requireThat(await boundedHostFile(path, 262144) === bytes,
        'ROLLOUT_HOST_READBACK_MISMATCH');
    },
    save: value => writeRetirementFile(rolloutPlanPath, value),
  });
}

