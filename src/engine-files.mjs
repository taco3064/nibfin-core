import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink, rename, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';

const nativeFiles = {
  lstat, mkdir, open, link, unlink, rename, readdir,
  rootOwnedPath, boundedHostFile, syncRecoveryDirectory,
};

// The installed composition always uses nativeFiles; tests supply local doubles.
export function engineFileStore(operations = nativeFiles) {
  const { lstat, mkdir, open, link, unlink, rename, readdir,
    rootOwnedPath, boundedHostFile, syncRecoveryDirectory } = operations;
  async function optionalStat(path) {
    return lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  async function exactFile(path, bytes, mode = 0o600) {
    await rootOwnedPath(path);
    const stat = await lstat(path);
    requireThat(stat.isFile() && stat.nlink === 1 && stat.gid === 0 &&
      (stat.mode & 0o7777) === mode &&
      await boundedHostFile(path, 1024 * 1024) === bytes, 'ENGINE_FILE_CONFLICT');
  }

  async function ownedDirectory(path, mode = 0o700, gid = 0) {
    await rootOwnedPath(dirname(path));
    try {
      await mkdir(path, { mode });
      const file = await open(path, constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await file.chown(0, gid); } finally { await file.close(); }
      await syncRecoveryDirectory(dirname(path));
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await rootOwnedPath(path);
    const stat = await lstat(path);
    requireThat(stat.isDirectory() && stat.gid === gid &&
      (stat.mode & 0o7777) === mode, 'ENGINE_DIRECTORY_CONFLICT');
  }

  // Creation never replaces a conflicting target, including a symlink.
  async function installEngineFile(path, bytes, mode = 0o600) {
    await rootOwnedPath(dirname(path));
    if (await optionalStat(path)) return exactFile(path, bytes, mode);
    const temp = `${path}.${randomUUID()}`;
    try {
      const file = await open(temp, 'wx', mode);
      try {
        await file.chown(0, 0);
        await file.chmod(mode);
        await file.writeFile(bytes);
        await file.sync();
      } finally { await file.close(); }
      await link(temp, path).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await syncRecoveryDirectory(dirname(path));
    }
    await exactFile(path, bytes, mode);
  }

  async function readEngineState(path) {
    if (!await optionalStat(path)) return null;
    await rootOwnedPath(path);
    const bytes = await boundedHostFile(path, 1024 * 1024, true);
    await exactFile(path, bytes);
    return JSON.parse(bytes);
  }

  // A durable intent precedes every privileged effect. Atomic replacement is only
  // allowed for the private journal whose exact previous contents were read back.
  async function saveEngineState(path, state, previous) {
    const bytes = JSON.stringify(state, null, 2) + '\n';
    if (!previous) return installEngineFile(path, bytes);
    await exactFile(path, JSON.stringify(previous, null, 2) + '\n');
    const temp = `${path}.${randomUUID()}`;
    try {
      await installEngineFile(temp, bytes);
      await rename(temp, path);
      await syncRecoveryDirectory(dirname(path));
      await exactFile(path, bytes);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function requireEmptyDirectory(path) {
    requireThat((await readdir(path)).length === 0, 'ENGINE_UNOWNED_RESOURCES');
  }
  async function requireDirectoryEntries(path, allowed) {
    requireThat((await readdir(path)).every(name => allowed.includes(name)),
      'ENGINE_UNEXPECTED_RESOURCE');
  }
  return {
    requireDirectoryEntries,
    optionalStat, exactFile, ownedDirectory, installEngineFile,
    readEngineState, saveEngineState, requireEmptyDirectory,
  };
}

export const {
  requireDirectoryEntries,
  optionalStat, exactFile, ownedDirectory, installEngineFile,
  readEngineState, saveEngineState, requireEmptyDirectory,
} = engineFileStore();
