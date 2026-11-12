import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isId, requireThat } from './identity.mjs';

const fileIdentity = stat =>
  `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;

export async function syncRecoveryDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY |
    constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Snapshot both identity and bytes. Identical replacement files are changes too.
export async function recoveryFile(path, limit = 16384) {
  requireThat(await realpath(path) === resolve(path), 'UNSAFE_RECOVERY_LOCK');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 && stat.size <= limit, 'UNSAFE_RECOVERY_LOCK');
    const before = fileIdentity(await handle.stat({ bigint: true }));
    const bytes = await handle.readFile('utf8');
    requireThat(Buffer.byteLength(bytes) <= limit, 'UNSAFE_RECOVERY_LOCK');
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    requireThat(identity === before, 'RECOVERY_LOCK_CHANGED');
    return { bytes, identity };
  } finally { await handle.close(); }
}

export async function inspectRecoveryFile(path, snapshot, limit = 16384) {
  const current = await recoveryFile(path, limit);
  requireThat(current.bytes === snapshot.bytes && current.identity === snapshot.identity,
    'RECOVERY_LOCK_CHANGED');
}

// A crashed recovery retains this guard. Never steal a guard on PID/age evidence.
export async function exclusiveRecovery(directory, use) {
  const path = join(directory, 'recovery.lock');
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      return { status: 'pending', code: 'RECOVERY_ALREADY_PENDING' };
    throw error;
  }
  let snapshot;
  try {
    const bytes = JSON.stringify({ nonce: randomUUID(), pid: process.pid });
    await file.writeFile(bytes);
    await file.sync();
    await syncRecoveryDirectory(directory);
    const identity = fileIdentity(await file.stat({ bigint: true }));
    const current = await recoveryFile(path);
    requireThat(current.bytes === bytes && current.identity === identity,
      'RECOVERY_LOCK_CHANGED');
    snapshot = current;
    return await use();
  } finally {
    await file.close();
    if (snapshot) {
      await inspectRecoveryFile(path, snapshot);
      await unlink(path);
      await syncRecoveryDirectory(directory);
    }
  }
}

// Ordinary acquisition never calls this. A retained execution lock stays in place
// throughout read-back and is removed only after durable, exact reconciliation.
export async function retainedRecovery(directory, decision, proof, use) {
  return exclusiveRecovery(directory, async () => {
    const path = join(directory, 'execution.lock');
    const snapshot = await recoveryFile(path);
    const lock = JSON.parse(snapshot.bytes);
    requireThat(isId(lock.pid) && lock.pid === proof.pid &&
      lock.decision === decision, 'RECOVERY_DECISION_MISMATCH');
    const inspect = async () => {
      await proof.prove();
      await inspectRecoveryFile(path, snapshot);
    };
    await inspect();
    const result = await use(inspect);
    await inspect();
    await unlink(path);
    await syncRecoveryDirectory(directory);
    return result;
  });
}
