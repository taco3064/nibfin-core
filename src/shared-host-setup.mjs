import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { rootfulSocket } from './docker-backend.mjs';
import { controllerProgram } from './controller-contract.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const controller = 'nibfin-controller';
const runners = ['nibfin-runner-1', 'nibfin-runner-2'];
const engineGroup = 'nibfin-engine';
const shell = '/usr/sbin/nologin';
const sudoers = '/etc/sudoers.d';
const base = '/var/lib/nibfin/controller';
const env = { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C' };

async function rootCommand(path, args, allowedExitCodes = [0]) {
  await rootOwnedPath(path);
  return command(path, args, { env, allowedExitCodes, limit: 4096 });
}

async function getent(database, name) {
  const result = await rootCommand('/usr/bin/getent', [database, name], [0, 2]);
  return result.exitCode === 0 ? result.stdout.toString().trim().split(':') : null;
}

async function account(name, supplement) {
  let row = await getent('passwd', name);
  if (!row) {
    requireThat(!await getent('group', name), 'SHARED_HOST_ACCOUNT_CONFLICT');
    const groups = supplement ? ['--groups', engineGroup] : [];
    await rootCommand('/usr/sbin/useradd', [
      '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
      '--shell', shell, ...groups, name,
    ]).catch(() => {});
    row = await getent('passwd', name);
  }
  const group = await getent('group', name);
  const shadow = await getent('shadow', name);
  const uid = Number(row?.[2]);
  const gid = Number(row?.[3]);
  requireThat(row?.[0] === name && row[6] === shell &&
    uid > 0 && uid < 65536 && Number.isSafeInteger(uid) &&
    gid > 0 && gid < 65536 && Number.isSafeInteger(gid) &&
    group?.[0] === name && Number(group[2]) === gid && !group[3] &&
    shadow?.[0] === name && /^[!*]/.test(shadow[1]), 'SHARED_HOST_ACCOUNT_CONFLICT');
  const { stdout } = await rootCommand('/usr/bin/id', ['-G', name]);
  const groups = stdout.toString().trim().split(/\s+/).map(Number);
  requireThat(groups.length === (supplement ? 2 : 1) && groups.includes(gid) &&
    (!supplement || groups.includes(supplement)), 'SHARED_HOST_ACCOUNT_CONFLICT');
  return { uid, gid };
}

async function privateDirectory(path, parentUid, { uid, gid }) {
  const parent = await lstat(dirname(path));
  requireThat(parent.isDirectory() && parent.uid === parentUid &&
    (parent.mode & 0o022) === 0, 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
  if (parentUid === 0) {
    await mkdir(path, { mode: 0o700 }).then(async () => {
      const directory = await open(path, constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.chown(uid, gid); }
      finally { await directory.close(); }
    }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  } else {
    await rootOwnedPath('/usr/bin/mkdir');
    await rootCommand('/usr/sbin/runuser', [
      '-u', controller, '--', '/usr/bin/mkdir', '-p', '-m', '0700', '--', path,
    ]);
  }
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && stat.uid === uid && stat.gid === gid &&
    (stat.mode & 0o777) === 0o700, 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
}

export async function prepareSharedAccounts(profile) {
  requireThat(profile.stateRoot === join(base, 'state') &&
    profile.tokenFile === join(base, 'credentials/github-token') &&
    profile.authFile === join(base, 'codex/auth.json'),
  'SHARED_MANAGED_CONTROLLER_PATH_CONFLICT');
  await rootOwnedPath(dirname(rootfulSocket));
  const socket = await lstat(rootfulSocket);
  const group = await getent('group', engineGroup);
  requireThat(socket.isSocket() && socket.uid === 0 && (socket.mode & 0o777) === 0o660 &&
    socket.gid > 0 && group?.[0] === engineGroup && Number(group[2]) === socket.gid &&
    (!group[3] || group[3] === controller), 'SHARED_DEDICATED_ENGINE_GROUP_REQUIRED');
  const owner = await account(controller, socket.gid);
  for (const name of runners) await account(name);
  await rootOwnedPath(dirname(dirname(base)));
  await mkdir(dirname(base), { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath(dirname(base));
  await privateDirectory(base, 0, owner);
  for (const folder of ['state', 'credentials', 'codex'])
    await privateDirectory(join(base, folder), owner.uid, owner);
}

export async function installSharedRelay() {
  await rootOwnedPath(sudoers);
  const target = join(sudoers, 'nibfin-shared-runner');
  const temp = join(sudoers, `.nibfin-relay-${randomUUID()}`);
  const policy = runners.map(name =>
    `${name} ALL=(${controller}) NOPASSWD: ${controllerProgram} ""\n`).join('');
  const validate = async path => {
    await rootOwnedPath(path);
    const stat = await lstat(path);
    requireThat(stat.isFile() && stat.uid === 0 && stat.gid === 0 &&
      (stat.mode & 0o777) === 0o440 &&
      await boundedHostFile(path, 4096) === policy, 'SHARED_RELAY_CONFLICT');
    await rootCommand('/usr/sbin/visudo', ['-cf', path]);
  };
  const readBack = async () => {
    await validate(target);
    await rootOwnedPath('/usr/bin/sudo');
    await rootOwnedPath(controllerProgram);
    for (const name of runners)
      await rootCommand('/usr/sbin/runuser', [
        '-u', name, '--', '/usr/bin/sudo', '-n', '-l',
        '-u', controller, '--', controllerProgram,
      ]);
  };
  try {
    await lstat(target);
    return readBack();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const file = await open(temp, 'wx', 0o440);
    try {
      await file.chown(0, 0);
      await file.chmod(0o440);
      await file.writeFile(policy);
      await file.sync();
    } finally { await file.close(); }
    await validate(temp);
    await link(temp, target);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await syncRecoveryDirectory(sudoers);
  }
  await readBack();
}
