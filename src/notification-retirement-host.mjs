import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedHostFile, coreRoot } from './host-adoption.mjs';
import { loadAdoptedHost } from './adopted-host.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';
import { repoPath } from './github-read.mjs';
import { requireThat } from './identity.mjs';
import { notificationUnitContents } from './relay-unit-contents.mjs';
import { observeNativeNotificationRoutes } from './native-notification-route.mjs';
import { retireNotificationResources } from './notification-retirement.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { syncRecoveryDirectory, recoveryFile, inspectRecoveryFile }
  from './recovery-lock.mjs';
import { RelayJournal, withRelayGate } from './relay-state.mjs';
import { relayConfigFile, relayStateRoot, relayUnitDirectory, relayUnits,
  validateRelayConfiguration } from './relay-host.mjs';

const systemctl = '/usr/bin/systemctl';
const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' } };

async function ownedBytes(path) {
  try {
    await rootOwnedPath(path);
    const stat = await lstat(path);
    requireThat(stat.isFile() && stat.nlink === 1,
      'NOTIFICATION_RESOURCE_NOT_OWNED');
    return await boundedHostFile(path, 262144);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readNotificationUnit(name, run = command, inspect = rootOwnedPath) {
  requireThat(relayUnits.includes(name), 'NOTIFICATION_UNIT_NOT_OWNED');
  await inspect(systemctl);
  const { stdout } = await run(systemctl, ['show', name, '--all',
    '--property=Id,LoadState,FragmentPath,DropInPaths,ActiveState,UnitFileState',
    '--property=MainPID,ControlGroup,NeedDaemonReload'], options);
  const state = Object.fromEntries(stdout.toString().trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  requireThat(state.Id === name && state.DropInPaths === '' &&
    (state.LoadState === 'not-found' && state.FragmentPath === '' ||
      state.LoadState === 'loaded' &&
      state.FragmentPath === `${relayUnitDirectory}/${name}`),
  'NOTIFICATION_UNIT_NOT_OWNED');
  return state;
}

export function notificationUnitStopped(unit, name) {
  if (!['inactive', 'failed'].includes(unit.ActiveState)) return false;
  if (name.endsWith('.timer'))
    return ['disabled', '', 'not-found'].includes(unit.UnitFileState);
  return unit.LoadState === 'not-found' ||
    unit.MainPID === '0' && unit.ControlGroup === '';
}

// The old shared journal is not required to activate or retire a native pool.
// Here it is only optional cleanup: unknown operation evidence and Owner pause
// survive; confirmed terminal origin receipts and obsolete poll caches can go.
export async function pruneNotificationJournal(root, repositoryIds) {
  try { await lstat(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return withRelayGate(root, async () => {
    const retained = [];
    const journal = new RelayJournal(root);
    for (const name of await readdir(root)) {
      const path = join(root, name);
      try {
        const snapshot = await recoveryFile(path);
        const record = JSON.parse(snapshot.bytes);
        let disposable = false;
        const origin = /^origin-(\d+)-(\d+)-1\.json$/.exec(name);
        const poll = /^poll-(\d+)\.json$/.exec(name);
        if (origin && repositoryIds.includes(Number(origin[1]))) {
          const valid = await journal.read({ repositoryId: Number(origin[1]),
            runId: Number(origin[2]), attempt: 1 });
          disposable = ['consumed', 'skipped'].includes(valid?.status);
        } else if (poll && repositoryIds.includes(Number(poll[1]))) {
          disposable = record && typeof record === 'object';
        }
        if (!disposable) { retained.push(name); continue; }
        await inspectRecoveryFile(path, snapshot);
        await unlink(path);
      } catch { retained.push(name); }
    }
    await syncRecoveryDirectory(root);
    return retained;
  });
}

async function installedPorts(context) {
  const { host, reader } = context;
  const contents = await notificationUnitContents();
  const expected = new Map([...contents].map(([name, bytes]) =>
    [join(relayUnitDirectory, name), bytes]));
  const snapshots = new Map();
  const readPeer = async path => {
    const bytes = await ownedBytes(path);
    requireThat(bytes !== null, 'NOTIFICATION_ADOPTION_CHANGED');
    return JSON.parse(bytes);
  };
  const consumers = async () => {
    const adopted = await observeNativeNotificationRoutes(host, reader, readPeer);
    const bytes = await ownedBytes(relayConfigFile);
    if (bytes !== null) {
      const config = validateRelayConfiguration(JSON.parse(bytes));
      for (const origin of config.origins) {
        if (adopted.some(item => item.repositoryId === origin.repositoryId &&
          item.repository === origin.repository)) continue;
        // A removed adoption is not evidence that a live old consumer retired.
        const repo = await reader.get(repoPath(origin.repository));
        requireThat(repo.id === origin.repositoryId &&
          repo.full_name === origin.repository &&
          (repo.archived === true || repo.disabled === true),
        'NOTIFICATION_OTHER_CONSUMER_ACTIVE');
      }
      snapshots.set(relayConfigFile, bytes);
    }
    return adopted;
  };
  const resources = async () => {
    for (const [path, bytes] of expected) {
      const actual = await ownedBytes(path);
      requireThat(actual === null || actual === bytes,
        'NOTIFICATION_RESOURCE_NOT_OWNED');
      if (actual !== null) snapshots.set(path, actual);
    }
    for (const name of relayUnits) await readNotificationUnit(name);
  };
  return {
    inspect: context.inspect, consumers, resources,
    // Stop the scheduler before its currently running worker.
    units: [...relayUnits].reverse(),
    stopped: async name => {
      const unit = await readNotificationUnit(name);
      return notificationUnitStopped(unit, name);
    },
    stop: async name => {
      await rootOwnedPath(systemctl);
      const args = name.endsWith('.timer') ? ['disable', '--now', name] : ['stop', name];
      await command(systemctl, args, options);
    },
    removable: async () => [...snapshots.keys()],
    remove: async path => {
      const actual = await ownedBytes(path);
      if (actual === null) return;
      requireThat(actual === snapshots.get(path), 'NOTIFICATION_RESOURCE_CHANGED');
      await unlink(path);
      await syncRecoveryDirectory(dirname(path));
    },
    reload: () => command(systemctl, ['daemon-reload'], options),
    pruneJournal: async () => {
      const ids = host.sharedRunner.repositories;
      try { return await pruneNotificationJournal(relayStateRoot, ids); }
      catch { return ['notification-journal: recovery evidence retained']; }
    },
  };
}

export async function retireInstalledNotificationRelay() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'NOTIFICATION_REQUIRES_INSTALLED_ADMINISTRATOR');
  return withManagedAdmission(async () => {
    const context = await loadAdoptedHost({ verifyRemote: false });
    return retireNotificationResources(await installedPorts(context));
  });
}
