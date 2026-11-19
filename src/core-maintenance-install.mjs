import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { managerRecoveryPackages, cleanupManagerRecovery }
  from './core-manager-recovery.mjs';
import { currentPoolRuntime, prepareCoreOnlyRunnerIdentity }
  from './core-only-runtime.mjs';
import { inspectManagerHost } from './shared-host-inspect.mjs';
import { sharedPoolSlots } from './shared-pool-slots.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { publishMaintenanceFile, maintenanceFile } from './core-maintenance-files.mjs';
import { requireThat } from './identity.mjs';
import { engine } from './engine-contract.mjs';
import { command } from './process.mjs';
import contract from './core-maintenance-installation.json' with { type: 'json' };
import { retireInstalledRolloutTimer } from './rollout-timer-retirement-host.mjs';
import { observeMaintenanceOperation } from './core-maintenance-observation.mjs';

const programs = new Map([
  [contract.bridge, 'scripts/core-maintenance-bridge.py'],
  [contract.client, 'scripts/core-maintenance-client.py'],
  [contract.dispatcher, 'src/security/shared-worker-dispatch.py'],
]);
const shim = 'src/security/shared-worker-dispatcher.sh';
const options = { env: { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C' } };

export function maintenanceSudoers() {
  return Buffer.from(engine.runners.map(name =>
    `${name} ALL=(root) NOPASSWD: ${contract.bridge} ""\n`).join(''));
}

async function requireProgram(path, expected, mode) {
  requireThat((await maintenanceFile(path))?.equals(expected) &&
    ((await lstat(path)).mode & 0o777) === mode, 'CORE_MAINTENANCE_ENTRY_PENDING');
}

export async function observeMaintenancePrograms(context, slots = []) {
  const admitted = requireManagerContext(context);
  for (const [path, source] of programs)
    await requireProgram(path, await readFile(join(admitted.codeRoot, source)), 0o755);
  await requireProgram(contract.sudoers, maintenanceSudoers(), 0o440);
  const bytes = await readFile(join(admitted.codeRoot, shim));
  for (const slot of slots)
    await requireProgram(join(slot, 'bin/Runner.Worker'), bytes, 0o755);
}

async function knownBytes(roots, path) {
  const result = [];
  for (const root of roots) {
    try {
      const source = join(root, path);
      await rootOwnedPath(source);
      result.push(await readFile(source));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

// Runs in the admitted manager under the existing exclusive management gate.
// This changes Nibfin entry programs only, never official runtime or registration.
export async function installCoreMaintenanceEntries(context,
  { inspectOnly = false } = {}) {
  const admitted = requireManagerContext(context);
  const runtime = await currentPoolRuntime(context);
  const hostPath = '/etc/nibfin/host.json';
  await rootOwnedPath(hostPath);
  const host = JSON.parse(await readFile(hostPath, 'utf8'));
  const pool = await inspectManagerHost(context);
  const binding = { pool, slots: sharedPoolSlots(pool, host) };
  await prepareCoreOnlyRunnerIdentity(binding, runtime, { inspectOnly });
  const recovery = await managerRecoveryPackages();
  const sources = [admitted.codeRoot, ...recovery.packages.map(pair => pair.root)];
  const published = [];
  for (const [destination, source] of programs) {
    const expected = await readFile(join(admitted.codeRoot, source));
    const old = await knownBytes(sources.slice(1), source);
    if (inspectOnly) await requireProgram(destination, expected, 0o755);
    else await publishMaintenanceFile(destination, expected, old, 0o755);
    published.push(destination);
  }
  const validate = async path => {
    await rootOwnedPath('/usr/sbin/visudo');
    await command('/usr/sbin/visudo', ['-cf', path], options);
  };
  if (inspectOnly) await requireProgram(contract.sudoers, maintenanceSudoers(), 0o440);
  else await publishMaintenanceFile(contract.sudoers, maintenanceSudoers(), [], 0o440,
    validate);
  for (const slot of binding.slots) {
    const expected = await knownBytes([admitted.codeRoot], shim);
    const old = await knownBytes([...sources, runtime.directory], shim);
    old.push(...await knownBytes([admitted.codeRoot],
      'src/security/shared-worker-dispatcher-legacy.sh'));
    const path = join(slot.path, 'bin/Runner.Worker');
    if (inspectOnly) await requireProgram(path, expected[0], 0o755);
    else await publishMaintenanceFile(path, expected[0], old, 0o755);
  }
  await observeMaintenancePrograms(context, binding.slots.map(slot => slot.path));
  const cleanup = inspectOnly ? undefined :
    await retireInstalledRolloutTimer([...sources, runtime.directory]);
  // Every owned entry now agrees with the current complete management package.
  // No reader can still use the predecessor while this exclusive gate is held.
  const retained = [...recovery.retained, ...(inspectOnly ? [] :
    await cleanupManagerRecovery(recovery.packages))];
  return { schemaVersion: 1, status: 'installed', capability: contract.kind,
    source: admitted.pin, programs: published, ...await observeMaintenanceOperation(),
    ...(retained.length ? { recoveryRetained: retained } : {}),
    ...(cleanup ? { cleanup } : {}) };
}
