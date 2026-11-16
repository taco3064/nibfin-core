import { constants } from 'node:fs';
import { lstat, open, realpath, link, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const unsafe = 'MANAGED_CREDENTIAL_PATH_UNSAFE';
export const managedBase = '/var/lib/nibfin/controller';
export const managedPaths = Object.freeze({
  stateRoot: join(managedBase, 'state'),
  tokenFile: join(managedBase, 'credentials/github-token'),
  authFile: join(managedBase, 'codex/auth.json'),
});

export function lifecyclePath(host) {
  return join(dirname(host.tokenFile), 'managed.json');
}

export async function privateResource(path, uid, directory = false) {
  requireThat(resolve(path) === path && await realpath(path) === path, unsafe);
  const stat = await lstat(path);
  requireThat(stat.uid === uid && (stat.mode & 0o777) ===
    (directory ? 0o700 : 0o600) && (directory ? stat.isDirectory() :
      stat.isFile() && stat.nlink === 1), unsafe);
  return stat;
}

export async function credentialDirectories(host) {
  for (const path of [host.stateRoot, dirname(host.tokenFile), dirname(host.authFile)])
    await privateResource(path, host.uid, true);
}

export async function readPrivate(path, host, limit = 65536) {
  await privateResource(dirname(path), host.uid, true);
  await privateResource(path, host.uid);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(stat.uid === host.uid && stat.isFile() && stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 && stat.size <= limit, unsafe);
    const bytes = await file.readFile('utf8');
    requireThat(Buffer.byteLength(bytes) <= limit, unsafe);
    return bytes;
  } finally { await file.close(); }
}

export async function lifecycleState(host) {
  try {
    const value = JSON.parse(await readPrivate(lifecyclePath(host), host));
    requireThat(value.schemaVersion === 1 && value.memberId === host.memberId &&
      ['installing', 'active', 'disconnecting', 'disconnected'].includes(value.phase),
    'MANAGED_CREDENTIAL_STATE_INVALID');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Exclusive publication for intake; replacement requires a verified owned inode.
export async function publishPrivate(path, bytes, host, previous) {
  await privateResource(dirname(path), host.uid, true);
  const temp = join(dirname(path), `.managed-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.chown(host.uid, host.gid);
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    if (previous) {
      await sameResource(path, host, previous);
      await rename(temp, path);
    } else await link(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await syncRecoveryDirectory(dirname(path));
  }
  return resourceIdentity(await privateResource(path, host.uid));
}

export function resourceIdentity(stat) { return { dev: stat.dev, ino: stat.ino }; }

export async function sameResource(path, host, expected) {
  const stat = await privateResource(path, host.uid);
  requireThat(expected && stat.dev === expected.dev && stat.ino === expected.ino,
    'MANAGED_CREDENTIAL_FILE_CONFLICT');
}

export async function writeLifecycle(host, state) {
  const path = lifecyclePath(host);
  let previous;
  try { previous = resourceIdentity(await privateResource(path, host.uid)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await publishPrivate(path, JSON.stringify(state) + '\n', host, previous);
}

export async function withCredentialLock(host, action) {
  await credentialDirectories(host);
  const path = join(dirname(host.tokenFile), 'managed.lock');
  const lock = await open(path, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST')
      throw Object.assign(new Error('Managed credential consumer unresolved'),
        { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
    throw error;
  });
  try {
    await lock.chown(host.uid, host.gid);
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    await lock.sync();
    await syncRecoveryDirectory(dirname(path));
    return await action();
  } finally {
    await lock.close();
    await unlink(path);
    await syncRecoveryDirectory(dirname(path));
  }
}
