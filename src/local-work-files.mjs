import { constants } from 'node:fs';
import { open, lstat, realpath, opendir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireThat } from './identity.mjs';
import { limits } from './local-work-values.mjs';

// Expected owner is the installed Controller UID, never the observer's UID.
// Every ancestor must be owned by that Controller or root and not writable by
// others. No file is created, locked, synchronized, repaired or removed.
export async function safePath(path, uid) {
  requireThat(typeof path === 'string' && resolve(path) === path &&
    await realpath(path) === path, 'UNTRUSTED_EVIDENCE');
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    const stickyRoot = current !== path && stat.isDirectory() && stat.uid === 0 &&
      (stat.mode & 0o1000) !== 0;
    requireThat(!stat.isSymbolicLink() && [0, uid].includes(stat.uid) &&
      ((stat.mode & 0o022) === 0 || stickyRoot), 'UNTRUSTED_EVIDENCE');
    if (current === '/') break;
  }
}
export async function readObservationFile(path, uid, limit = limits.fileBytes) {
  await safePath(path, uid);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    requireThat(before.isFile() && before.uid === uid && before.nlink === 1 &&
      before.size <= limit && (before.mode & 0o022) === 0,
    'UNTRUSTED_EVIDENCE');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireThat(bytesRead <= limit, 'OBSERVATION_LIMIT');
    const after = await file.stat();
    await safePath(path, uid);
    const current = await lstat(path);
    requireThat(before.ino === current.ino && before.dev === current.dev &&
      before.size === after.size && before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs, 'OBSERVATION_CHANGED');
    return { bytes: buffer.subarray(0, bytesRead).toString('utf8'),
      sourceTime: before.mtime.toISOString() };
  } finally { await file.close(); }
}
export async function observationEntries(path, uid) {
  await safePath(path, uid);
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && stat.uid === uid, 'UNTRUSTED_EVIDENCE');
  const entries = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    requireThat(entries.length < limits.entries, 'OBSERVATION_LIMIT');
    entries.push(entry.name);
  }
  await safePath(path, uid);
  return entries.sort();
}
