import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isId, requireThat } from './identity.mjs';
import { isBootId, linuxBootId } from './linux-boot.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export function issueStatePath(stateRoot, issue) {
  requireThat(isId(issue?.repositoryId) && isId(issue.number), 'INVALID_HOST_ISSUE');
  return join(stateRoot, `issue-${issue.repositoryId}-${issue.number}`);
}

export async function privateHostDirectory(path) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0 &&
    await realpath(path) === resolve(path), 'UNTRUSTED_HOST_STATE');
}

// GitHub schedules the Job. Keep local recovery evidence for this Issue until
// its containers and external effects are settled.
export async function acquireHostFence(root, binding, observeBoot = linuxBootId) {
  await privateHostDirectory(root);
  const bootId = await observeBoot();
  requireThat(isBootId(bootId), 'INVALID_BOOT_OBSERVATION');
  const path = join(root, 'stage.lock'), nonce = randomUUID();
  let handle;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    constants.O_NOFOLLOW;
  try { handle = await open(path, flags, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') {
      requireThat(false, 'HOST_EXECUTION_UNRESOLVED');
    }
    throw error;
  }
  const bytes = JSON.stringify({ nonce, binding, pid: process.pid, bootId });
  const sync = () => syncRecoveryDirectory(root);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await sync();
  const inspect = async () => {
    await privateHostDirectory(root);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 && stat.size === Buffer.byteLength(bytes) &&
        await file.readFile('utf8') === bytes, 'HOST_FENCE_CHANGED');
    } finally { await file.close(); }
    // The nonce verifies ownership, but must not change the operation identity
    // when the same native job is invoked again after a completed stage.
    return digest(binding);
  };
  return {
    inspect,
    async release() { await inspect(); await unlink(path); await sync(); },
  };
}
