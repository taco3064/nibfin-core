import { readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { maintenanceFile } from './core-maintenance-files.mjs';
import { legacyRolloutUnits, retireRolloutTimer } from './rollout-timer-retirement.mjs';
import { readOwnedSystemdUnit, ownedSystemdUnitStopped } from './owned-systemd-unit.mjs';
import { requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const unitRoot = '/etc/systemd/system';
const oldProgram = '/usr/local/libexec/nibfin/host-auto-rollout.py';
const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' } };

// Native entries have already been published and verified by the caller. Old
// operation plans, closure, credentials and Owner pause are not cleanup targets.
export async function retireInstalledRolloutTimer(sourceRoots) {
  const expected = new Map([...legacyRolloutUnits].map(([name, bytes]) =>
    [join(unitRoot, name), bytes]));
  const sources = [];
  for (const root of sourceRoots) {
    const path = join(root, 'scripts/host-auto-rollout.py');
    try { await rootOwnedPath(path); sources.push(await readFile(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const snapshots = new Map();
  let retained = [];
  const unit = name => readOwnedSystemdUnit(name, join(unitRoot, name),
    { code: 'CORE_ROLLOUT_UNIT_UNKNOWN' });
  const resources = async () => {
    for (const [path, bytes] of expected) {
      const actual = await maintenanceFile(path);
      requireThat(actual === null || actual.equals(bytes), 'CORE_ROLLOUT_UNIT_UNKNOWN');
      if (actual) snapshots.set(path, actual);
    }
    for (const name of legacyRolloutUnits.keys()) {
      const state = await unit(name);
      requireThat(!state.RequiredBy && !state.BoundBy && !state.ConsistsOf &&
        (!state.WantedBy || state.WantedBy === 'timers.target') &&
        (!state.TriggeredBy || state.TriggeredBy === 'nibfin-rollout.timer'),
      'CORE_ROLLOUT_UNIT_OTHER_CONSUMER');
    }
    const program = await maintenanceFile(oldProgram).catch(() => {
      retained = [oldProgram];
      return null;
    });
    if (program && sources.some(bytes => bytes.equals(program)))
      snapshots.set(oldProgram, program);
    else if (program) retained = [oldProgram];
  };
  return retireRolloutTimer({
    ready: async () => {}, resources,
    stopped: async name => ownedSystemdUnitStopped(await unit(name), name),
    safeToStop: async name => {
      requireThat(name.endsWith('.timer') || retained.length === 0,
        'CORE_ROLLOUT_ACTIVE_PROGRAM_UNKNOWN');
    },
    stop: async name => {
      await rootOwnedPath('/usr/bin/systemctl');
      await command('/usr/bin/systemctl', name.endsWith('.timer') ?
        ['disable', '--now', name] : ['stop', name], options);
    },
    removable: async () => [...snapshots.keys()],
    remove: async path => {
      const actual = await maintenanceFile(path);
      if (actual === null) return;
      requireThat(actual.equals(snapshots.get(path)), 'CORE_ROLLOUT_RESOURCE_CHANGED');
      await unlink(path);
      await syncRecoveryDirectory(dirname(path));
    },
    reload: () => command('/usr/bin/systemctl', ['daemon-reload'], options),
    retained: async () => retained,
  });
}
