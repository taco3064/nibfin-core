import { constants } from 'node:fs';
import { privateResource } from './managed-credential-files.mjs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withKernelGate } from './kernel-gate.mjs';
import { randomUUID } from 'node:crypto';
import { recoveryFile, syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';

const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

// Kernel locks die with their file descriptions: restart needs no stale-lock theft.
// The parent retains the same open description until the entire callback finishes.
export async function withPrivateStateGate(root, use, {
  uid = process.getuid(), name = 'relay.lock',
} = {}) {
  requireThat(/^[a-z-]+\.lock$/.test(name), 'UNTRUSTED_RELAY_LOCK');
  await privateResource(root, uid, true);
  let handle;
  try {
    handle = await open(join(root, name), flags | constants.O_EXCL, 0o600);
    await handle.chown(uid, -1);
  } catch (error) {
    await handle?.close();
    if (error.code !== 'EEXIST') throw error;
    handle = await open(join(root, name), flags & ~constants.O_CREAT);
  }
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === uid &&
      (stat.mode & 0o077) === 0, 'UNTRUSTED_RELAY_LOCK');
    return await withKernelGate(handle, use);
  } finally { await handle.close(); }
}

export async function writePrivateState(root, name, value, uid = process.getuid()) {
  await privateResource(root, uid, true);
  requireThat(/^[A-Za-z0-9_-]+\.json$/.test(name), 'INVALID_RELAY_STATE');
  const bytes = JSON.stringify(value) + '\n';
  requireThat(Buffer.byteLength(bytes) <= 16384, 'RELAY_STATE_TOO_LARGE');
  const temp = join(root, `${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.chown(uid, -1);
      await handle.writeFile(bytes);
      await handle.sync();
    }
    finally { await handle.close(); }
    await rename(temp, join(root, name));
    await syncRecoveryDirectory(root);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readPrivateState(root, name, uid = process.getuid()) {
  await privateResource(root, uid, true);
  try { return JSON.parse((await recoveryFile(join(root, name), 16384, uid)).bytes); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

