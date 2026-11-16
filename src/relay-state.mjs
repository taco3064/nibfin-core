import { constants } from 'node:fs';
import { privateResource } from './managed-credential-files.mjs';
import { mkdir, open, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateHostDirectory } from './host-fence.mjs';
import { recoveryFile, syncRecoveryDirectory } from './recovery-lock.mjs';
import { digest, isId, requireThat } from './identity.mjs';

const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

// Kernel locks die with their file descriptions: restart needs no stale-lock theft.
// The parent retains the same open description until the entire callback finishes.
export async function withRelayGate(root, use, {
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
    const child = spawn('/usr/bin/flock', ['-n', '-E', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      env: { PATH: '/usr/bin:/bin' },
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', value => { clearTimeout(timer); resolve(value); });
    });
    if (code === 75) return { status: 'pending', code: 'RELAY_BUSY' };
    requireThat(code === 0, 'RELAY_LOCK_UNAVAILABLE');
    // flock(2) attaches to this inherited open file description. The parent
    // retains the lock after the short-lived helper exits; close releases it.
    return await use();
  } finally { await handle.close(); }
}

export async function writeRelayState(root, name, value) {
  await privateHostDirectory(root);
  requireThat(/^[A-Za-z0-9_-]+\.json$/.test(name), 'INVALID_RELAY_STATE');
  const bytes = JSON.stringify(value) + '\n';
  requireThat(Buffer.byteLength(bytes) <= 16384, 'RELAY_STATE_TOO_LARGE');
  const temp = join(root, `${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, join(root, name));
    await syncRecoveryDirectory(root);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readRelayState(root, name) {
  await privateHostDirectory(root);
  try { return JSON.parse((await recoveryFile(join(root, name))).bytes); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function relayOriginKey(origin) {
  requireThat(isId(origin?.repositoryId) && isId(origin.runId) && origin.attempt === 1,
    'INVALID_RELAY_ORIGIN');
  return `origin-${origin.repositoryId}-${origin.runId}-1.json`;
}

export class RelayJournal {
  constructor(root) { this.root = root; }
  async prepare() {
    await mkdir(this.root, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(this.root);
    await syncRecoveryDirectory(this.root);
  }
  async read(origin) {
    const record = await readRelayState(this.root, relayOriginKey(origin));
    if (record) requireThat(record.schemaVersion === 1 &&
      digest(record.origin) === digest(origin) &&
      ['pending', 'consumed', 'skipped'].includes(record.status) &&
      (record.runId === undefined || isId(record.runId)) &&
      (record.status === 'skipped' || record.intent?.origin &&
        digest(record.intent.origin) === digest(origin)), 'RELAY_JOURNAL_CORRUPT');
    return record;
  }
  async write(record) {
    const name = relayOriginKey(record.origin);
    const previous = await this.read(record.origin);
    requireThat(!previous || previous.status === 'pending' &&
      digest(previous.intent) === digest(record.intent) &&
      (!previous.runId || record.runId === previous.runId),
    'RELAY_IMMUTABLE_INTENT');
    await writeRelayState(this.root, name, { schemaVersion: 1, ...record });
  }
  async records() {
    const names = (await readdir(this.root)).filter(name =>
      /^origin-\d+-\d+-1\.json$/.test(name));
    requireThat(names.length <= 4096, 'RELAY_JOURNAL_CAPACITY');
    const result = [];
    for (const name of names) {
      const record = await readRelayState(this.root, name);
      requireThat(record && name === relayOriginKey(record.origin),
        'RELAY_JOURNAL_CORRUPT');
      result.push(await this.read(record.origin));
    }
    return result;
  }
  async control() {
    const value = await readRelayState(this.root, 'control.json');
    requireThat(value?.schemaVersion === 1 && typeof value.paused === 'boolean',
      'RELAY_CONTROL_UNKNOWN');
    return value;
  }
  async requireSettled() {
    const result = await withRelayGate(this.root, async () => {
      requireThat((await this.control()).paused, 'RETIREMENT_RELAY_NOT_PAUSED');
      // A lost dispatch response remains an external effect even if no active
      // Job or registration is visible. Recovery owns reconciliation; retirement
      // must neither clear the receipt nor repeat the POST.
      requireThat((await this.records()).every(record => record.status !== 'pending'),
        'RETIREMENT_RELAY_EFFECT_PENDING');
      return { settled: true };
    });
    requireThat(result?.settled === true, 'RETIREMENT_RELAY_BUSY');
  }
  async setPaused(paused) {
    return withRelayGate(this.root, async () => {
      await this.control();
      await writeRelayState(this.root, 'control.json', { schemaVersion: 1, paused });
      return { status: paused ? 'paused' : 'resumed', stageAdmitted: false };
    });
  }
}
