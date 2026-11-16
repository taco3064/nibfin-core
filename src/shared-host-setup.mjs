import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { engine } from './engine-contract.mjs';
import { ownedDirectory } from './engine-files.mjs';
import { verifyManagedEngine } from './engine-verify.mjs';
import { controllerProgram } from './controller-contract.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

import { managedBase as base, managedPaths } from './managed-credential-files.mjs';

const controller = engine.controller;
const runners = engine.runners;
const sudoers = '/etc/sudoers.d';
const env = { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C' };

async function rootCommand(path, args, allowedExitCodes = [0]) {
  await rootOwnedPath(path);
  return command(path, args, { env, allowedExitCodes, limit: 4096 });
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

export async function prepareSharedAccounts(profile, { preparation = false } = {}) {
  requireThat(Object.entries(managedPaths).every(
    ([key, path]) => profile[key] === path),
  'SHARED_MANAGED_CONTROLLER_PATH_CONFLICT');
  const verified = await verifyManagedEngine();
  const owner = verified.accounts.accounts[controller];
  await rootOwnedPath(dirname(dirname(base)));
  await ownedDirectory(dirname(base), 0o755);
  await privateDirectory(base, 0, owner);
  for (const folder of ['state', 'credentials', 'codex'])
    await privateDirectory(join(base, folder), owner.uid, owner);
  if (!preparation) return;
  for (const slot of [1, 2]) {
    const parent = join(base, `slot-${slot}`);
    await privateDirectory(parent, owner.uid, owner);
    const path = join(parent, 'egress');
    await rootCommand('/usr/sbin/runuser', [
      '-u', controller, '--', '/usr/bin/mkdir', '-p', '-m', '0755', '--', path,
    ]);
    const stat = await lstat(path);
    requireThat(stat.isDirectory() && stat.uid === owner.uid &&
      stat.gid === owner.gid && (stat.mode & 0o7777) === 0o755,
    'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
  }
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
