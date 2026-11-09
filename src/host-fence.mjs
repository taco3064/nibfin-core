import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { digest, isId, requireThat } from './identity.mjs';

async function ownerIsRunning(root) {
  let file;
  try {
    file = await open(join(root, 'stage.lock'), constants.O_RDONLY |
      constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 || stat.size > 16384) return false;
    const { pid } = JSON.parse(await file.readFile('utf8'));
    if (!isId(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The holder may have released the fence between exclusive open and read.
    return error.code === 'ENOENT';
  } finally {
    await file?.close();
  }
}

// Wait for a live local holder to release voluntarily. PID status can only
// permit waiting. Acquiring the durable fence still requires exclusive create.
export async function waitForHostFence(root, binding, timeout, interval = 1000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      return await acquireHostFence(root, binding);
    } catch (error) {
      if (error.code !== 'HOST_EXECUTION_UNRESOLVED' ||
        performance.now() >= deadline) throw error;
      await setTimeout(Math.min(interval, Math.max(0, deadline - performance.now())));
      if (!await ownerIsRunning(root)) throw error;
    }
  }
}

export async function privateHostDirectory(path) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0 &&
    await realpath(path) === resolve(path), 'UNTRUSTED_HOST_STATE');
}

// One manually adopted host, one durable fence across all its Issue stages.
// Never recover from PID/job status: a crash may leave a container or write alive.
// This is not a distributed lease; moving the adopted host requires reconciliation.
export async function acquireHostFence(root, binding) {
  await privateHostDirectory(root);
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
  const bytes = JSON.stringify({ nonce, binding, pid: process.pid });
  const sync = async () => {
    const dir = await open(root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  };
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
