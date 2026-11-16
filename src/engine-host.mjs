import { lstat, realpath, readFile, readlink, readdir } from 'node:fs/promises';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile, coreRoot } from './host-adoption.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { engine, engineConfiguration, engineUnit } from './engine-contract.mjs';
import {
  optionalStat, exactFile, ownedDirectory, installEngineFile,
  requireEmptyDirectory, requireDirectoryEntries, readEngineState, saveEngineState,
} from './engine-files.mjs';
import { requirePlainAcl } from './controller-separation.mjs';
import { engineAccess, engineAccountAccess } from './engine-access.mjs';
import {
  engineAccounts, subordinatePlan, installSubordinates,
} from './engine-accounts.mjs';

const env = { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent' };
const utilities = [
  '/usr/bin/systemctl', '/usr/bin/docker', engine.daemon, '/usr/bin/getent',
  '/usr/bin/getfacl', '/usr/bin/id', '/usr/sbin/groupadd', '/usr/sbin/useradd',
  '/usr/bin/ldd', '/usr/bin/sleep', '/usr/sbin/nologin',
  '/usr/sbin/apparmor_parser', '/usr/bin/containerd', '/usr/bin/runc',
  '/usr/bin/containerd-shim-runc-v2',
  '/usr/sbin/usermod', '/usr/bin/dpkg-query', '/usr/bin/dpkg', '/usr/bin/chmod',
];

export async function verifyEngineUtilities(inspect = async path => {
  await rootOwnedPath(path);
  const stat = await lstat(path);
  requireThat(stat.isFile() && (stat.mode & 0o111) !== 0,
    'ENGINE_UTILITY_NOT_EXECUTABLE');
}) {
  for (const utility of utilities) {
    try { await inspect(utility); }
    catch (cause) {
      const name = utility.split('/').at(-1).replaceAll('-', '_').toUpperCase();
      throw Object.assign(new Error(`Required utility: ${utility}`, { cause }), {
        code: `ENGINE_REQUIRED_${name}_UNAVAILABLE`, utility,
      });
    }
  }
}

export function requireEngineAdministrator(platform, arch, uid, consent) {
  requireThat(linuxArchitecture(platform, arch) && uid === 0,
    'ENGINE_REQUIRES_SUPPORTED_LINUX_ADMINISTRATOR');
  requireThat(consent === true, 'ENGINE_DEDICATED_HOST_ACKNOWLEDGEMENT_REQUIRED');
}

export async function engineAdmission(consent) {
  requireEngineAdministrator(process.platform, process.arch, process.getuid?.(), consent);
  requireThat(coreRoot === '/opt/nibfin/core', 'ENGINE_REQUIRES_INSTALLED_CORE');
  await rootOwnedPath(coreRoot);
  await rootOwnedPath(engine.plan);
  const bytes = await boundedHostFile(engine.plan, 16384);
  const plan = JSON.parse(bytes);
  requireThat(Object.keys(plan).join(',') === 'pin', 'ENGINE_INVALID_INSTALL_PLAN');
  await verifyInstalledSource(coreRoot, plan.pin);
  await verifyEngineUtilities();
  await rootOwnedPath('/run/systemd/system');
  try {
    const controllers = (await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8'))
      .trim().split(/\s+/);
    const init = (await readFile('/proc/1/comm', 'utf8')).trim();
    const apparmor = '/sys/module/apparmor/parameters/enabled';
    requireThat(init === 'systemd' &&
      (await readFile(apparmor, 'utf8')).trim() === 'Y' &&
      ['cpu', 'memory', 'pids'].every(name => controllers.includes(name)) &&
      Number(await readFile('/proc/sys/user/max_user_namespaces', 'utf8')) > 0,
    'ENGINE_UNSUPPORTED_HOST');
    for (const table of ['uid_map', 'gid_map']) {
      const map = (await readFile(`/proc/self/${table}`, 'utf8')).trim();
      requireThat(/^0\s+0\s+4294967295$/.test(map), 'ENGINE_UNSUPPORTED_HOST');
    }
  } catch (cause) {
    throw Object.assign(new Error('Unsupported Engine host', { cause }),
      { code: 'ENGINE_UNSUPPORTED_HOST' });
  }
  return async () => {
    requireThat(await boundedHostFile(engine.plan, 16384) === bytes,
      'ENGINE_INSTALL_PLAN_CHANGED');
    await verifyInstalledSource(coreRoot, plan.pin);
  };
}

export function engineHost() {
  const run = async (path, args, options = {}) => {
    await rootOwnedPath(path);
    return (await command(path, args, { env, ...options })).stdout.toString();
  };
  const io = {
    architecture: linuxArchitecture(process.platform, process.arch),
    run,
    async docker(managed, args, options) {
      return run('/usr/bin/docker', [
        '--config', '/etc/nibfin/engine/client', '--host',
        `unix://${managed ? engine.socket : '/run/docker.sock'}`, ...args,
      ], options);
    },
    async initialize() {
      await ownedDirectory(engine.state);
      await requireDirectoryEntries(engine.state, ['state.json', 'recovery.lock']);
    },
    load: () => readEngineState(`${engine.state}/state.json`),
    save: (state, previous) =>
      saveEngineState(`${engine.state}/state.json`, state, previous),
    async pristine() {
      for (const path of [engine.config, engine.unitPath, engine.data, engine.exec,
        engine.runtime, '/etc/nibfin/engine']) {
        requireThat(!await optionalStat(path), 'ENGINE_UNOWNED_RESOURCES');
      }
      for (const database of ['passwd', 'group']) {
        const rows = (await run('/usr/bin/getent', [database])).split('\n');
        requireThat(rows.every(row => ![engine.remap, engine.group]
          .includes(row.split(':')[0])), 'ENGINE_UNOWNED_RESOURCES');
      }
    },
    async vendorUnit(path, name) {
      const canonical = await realpath(path);
      await rootOwnedPath(canonical);
      const owner = (await run('/usr/bin/dpkg-query', ['-S', path])).trim();
      requireThat(owner === `docker-ce: ${path}`, 'ENGINE_STOCK_PACKAGE_UNPROVEN');
      requireThat((await run('/usr/bin/dpkg', ['--verify', 'docker-ce'])).trim() === '',
        'ENGINE_STOCK_PACKAGE_MODIFIED');
      const content = await boundedHostFile(canonical, 16384);
      requireThat(name === 'docker.service' ?
        content.includes('ExecStart=/usr/bin/dockerd -H fd:// ' +
          '--containerd=/run/containerd/containerd.sock\n') :
        /ListenStream=\/(?:var\/)?run\/docker.sock\n/.test(content),
      'ENGINE_STOCK_CUSTOM_CONFIGURATION');
    },
    async stockConfiguration() {
      if (await optionalStat('/etc/docker')) {
        await rootOwnedPath('/etc/docker');
        requireThat((await readdir('/etc/docker')).every(name => name === 'daemon.json'),
          'ENGINE_STOCK_CUSTOM_CONFIGURATION');
      }
      if (await optionalStat('/run/docker.sock')) {
        requireThat(await realpath('/run/docker.sock') === '/run/docker.sock',
          'ENGINE_STOCK_SOCKET_UNPROVEN');
        const stat = await lstat('/run/docker.sock');
        requireThat(stat.isSocket() && stat.uid === 0 && stat.gid > 0 &&
          (stat.mode & 0o7777) === 0o660, 'ENGINE_STOCK_SOCKET_UNPROVEN');
        const group = (await run('/usr/bin/getent', ['group', 'docker'])).split(':');
        requireThat(group[0] === 'docker' && Number(group[2]) === stat.gid,
          'ENGINE_STOCK_SOCKET_UNPROVEN');
        requirePlainAcl(await run('/usr/bin/getfacl', ['-cp', '/run/docker.sock']));
      }
      if (await optionalStat('/etc/docker/daemon.json')) {
        await rootOwnedPath('/etc/docker/daemon.json');
        const bytes = await boundedHostFile('/etc/docker/daemon.json', 16384);
        const config = JSON.parse(bytes);
        requireThat(config && !Array.isArray(config) &&
          Object.keys(config).length === 0, 'ENGINE_STOCK_CUSTOM_CONFIGURATION');
      }
    },
    async emptyStockData() {
      for (const path of ['/var/lib/docker', '/run/docker']) {
        if (await optionalStat(path)) {
          await rootOwnedPath(path);
          await requireEmptyDirectory(path);
        }
      }
    },
    async verifyMask(name) {
      const path = `/etc/systemd/system/${name}`;
      await rootOwnedPath('/etc/systemd/system');
      const stat = await lstat(path);
      requireThat(stat.isSymbolicLink() && stat.uid === 0 &&
        await readlink(path) === '/dev/null', 'ENGINE_STOCK_RECONCILIATION_REQUIRED');
    },
    async daemonProcesses(allowed) {
      for (const pid of (await readdir('/proc')).filter(name => /^[0-9]+$/.test(name))) {
        try {
          const executable = await readlink(`/proc/${pid}/exe`);
          if (executable.split('/').at(-1).replace(/ \(deleted\)$/, '') === 'dockerd') {
            requireThat(executable === engine.daemon && allowed.includes(pid),
              'ENGINE_OTHER_DAEMON_PRESENT');
          }
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
        }
      }
    },
    async subordinate(name) {
      requireThat(['subuid', 'subgid'].includes(name), 'ENGINE_INVALID_SUBID_TABLE');
      const path = `/etc/${name}`;
      if (!await optionalStat(path)) return '';
      await rootOwnedPath(path);
      const stat = await lstat(path);
      requireThat(stat.isFile() && stat.nlink === 1 && stat.gid === 0 &&
        (stat.mode & 0o022) === 0, 'ENGINE_SUBID_FILE_CONFLICT');
      return boundedHostFile(path, 1024 * 1024);
    },
    accounts: (observe, expected) => engineAccounts(io, observe, expected),
    subordinatePlan: (accounts, previous) => subordinatePlan(io, accounts, previous),
    installSubordinates: (plan, observe) => installSubordinates(io, plan, observe),
    access: accounts => engineAccess(io, accounts),
    beforeStart: accounts => engineAccountAccess(io, accounts),
    async resources(accounts, observeOnly) {
      const directories = [
        ['/etc/nibfin', 0o755, 0], ['/etc/nibfin/engine', 0o700, 0],
        ['/etc/nibfin/engine/client', 0o700, 0], [engine.data, 0o700, 0],
        [engine.runtime, 0o710, accounts.gid], [engine.exec, 0o700, accounts.gid],
      ];
      for (const [path, mode, gid] of directories) {
        if (observeOnly) requireThat(await optionalStat(path),
          'ENGINE_RESOURCE_RECONCILIATION_REQUIRED');
        await ownedDirectory(path, mode, gid);
      }
      const files = [[engine.config, engineConfiguration(), 0o600],
        [engine.unitPath, engineUnit(), 0o644]];
      for (const [path, bytes, mode] of files) {
        if (observeOnly) await exactFile(path, bytes, mode);
        else await installEngineFile(path, bytes, mode);
      }
      await requireDirectoryEntries('/etc/nibfin/engine', ['client', 'daemon.json']);
      await requireDirectoryEntries(engine.runtime, ['docker.sock']);
      await requireEmptyDirectory('/etc/nibfin/engine/client');
    },
    async verifyEnabled() {
      const directory = '/etc/systemd/system/multi-user.target.wants';
      await rootOwnedPath(directory);
      const path = `${directory}/${engine.unit}`;
      const stat = await lstat(path);
      requireThat(stat.isSymbolicLink() && stat.uid === 0 &&
        await realpath(path) === engine.unitPath, 'ENGINE_ENABLE_CONFLICT');
    },
    async kernelProof(pid) {
      return {
        uidMap: await readFile(`/proc/${pid}/uid_map`, 'utf8'),
        gidMap: await readFile(`/proc/${pid}/gid_map`, 'utf8'),
        label: await readFile(`/proc/${pid}/attr/current`, 'utf8'),
      };
    },
    async stockIdentity(unit) {
      if (unit.MainPID === '0') return;
      const pid = unit.MainPID;
      requireThat(/^[1-9][0-9]*$/.test(pid) &&
        await readlink(`/proc/${pid}/exe`) === engine.daemon,
      'ENGINE_STOCK_DAEMON_UNPROVEN');
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      requireThat(JSON.stringify(argv) === JSON.stringify([
        engine.daemon, '-H', 'fd://',
        '--containerd=/run/containerd/containerd.sock', '',
      ]), 'ENGINE_STOCK_CUSTOM_CONFIGURATION');
    },
    async daemonIdentity(unit) {
      const pid = unit.MainPID;
      requireThat(/^[1-9][0-9]*$/.test(pid) &&
        await readlink(`/proc/${pid}/exe`) === engine.daemon,
      'ENGINE_DAEMON_IDENTITY_UNPROVEN');
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      requireThat(JSON.stringify(argv) === JSON.stringify([
        engine.daemon, `--config-file=${engine.config}`, '',
      ]), 'ENGINE_DAEMON_CONFIGURATION_CHANGED');
      const sockets = (await readFile('/proc/net/unix', 'utf8')).split('\n')
        .map(line => line.trim().split(/\s+/)).filter(row => row[7] === engine.socket);
      requireThat(sockets.length === 1 && sockets[0][3] === '00010000',
        'ENGINE_SOCKET_LISTENER_UNPROVEN');
      let owns = false;
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try {
          if (await readlink(`/proc/${pid}/fd/${fd}`) === `socket:[${sockets[0][6]}]`)
            owns = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      requireThat(owns, 'ENGINE_SOCKET_LISTENER_UNPROVEN');
      await io.daemonProcesses([pid]);
    },
  };
  return io;
}
