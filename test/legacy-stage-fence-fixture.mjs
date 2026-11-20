import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateHostDirectory } from '../src/host-fence.mjs';
import { digest, requireThat } from '../src/identity.mjs';
import { processIdentityNow } from '../src/host-memory-pressure.mjs';
import { isBootId, linuxBootId } from '../src/linux-boot.mjs';
import { syncRecoveryDirectory } from '../src/recovery-lock.mjs';
// Build the historical on-disk stage fence for compatibility tests.

export async function acquireHostFence(root, binding, observeBoot = linuxBootId) {
  await privateHostDirectory(root);
  const bootId = await observeBoot();
  requireThat(isBootId(bootId), 'INVALID_BOOT_OBSERVATION');
  const identity = processIdentityNow(process.pid);
  requireThat(identity, 'HOST_PROCESS_IDENTITY_UNAVAILABLE');
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
  const bytes = JSON.stringify({ nonce, binding, ...identity, bootId });
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
