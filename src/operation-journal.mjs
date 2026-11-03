import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isDigest, requireThat } from './identity.mjs';
import { operations } from './approval-record.mjs';

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0 && await realpath(path) === resolve(path), 'UNTRUSTED_JOURNAL_DIRECTORY');
}

// Durable local execution receipts, never a copy of Issue/dependency state.
// Adapted from the reference's exclusive lease and pending-before-effect model.
// This is NOT a distributed lock. Trusted admission must separately prove no
// live/unknown previous writer on another host before invoking this component.
export class OperationJournal {
  #directory;
  constructor(root, issue) {
    requireThat(process.platform === 'linux' && typeof process.getuid === 'function', 'UNSUPPORTED_JOURNAL_HOST');
    requireThat(typeof issue?.id === 'string' && issue.id && Number.isSafeInteger(issue.repositoryId) && issue.repositoryId > 0,
      'INVALID_JOURNAL_SUBJECT');
    this.#directory = join(resolve(root), digest({ issueId: issue.id, repositoryId: issue.repositoryId }));
    this.root = resolve(root);
  }
  async #prepare() {
    await privateDirectory(this.root);
    await mkdir(this.#directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await privateDirectory(this.#directory);
    await syncDirectory(this.root);
  }
  async #read() {
    const path = join(this.#directory, 'receipts.json');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.nlink === 1,
        'UNTRUSTED_JOURNAL_FILE');
      const record = JSON.parse(await handle.readFile('utf8'));
      requireThat(record.hash === digest(record.payload) && record.payload.schemaVersion === 1 &&
        Array.isArray(record.payload.completed) && record.payload.completed.every(isDigest) &&
        new Set(record.payload.completed).size === record.payload.completed.length &&
        (record.payload.pending === null || isDigest(record.payload.pending)), 'JOURNAL_CORRUPT');
      return record.payload;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, pending: null, completed: [] };
      throw error;
    } finally { await handle?.close(); }
  }
  async #write(payload) {
    const temp = join(this.#directory, `${randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ payload, hash: digest(payload) })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, join(this.#directory, 'receipts.json'));
    await syncDirectory(this.#directory);
  }
  async run(request, { admit, perform, readBack }) {
    // The binding identifies immutable approval, Scope/Shape, candidate, source,
    // role/session and operation target. All three callbacks belong to trusted
    // Core; none can be supplied by an Agent/worktree or external JSON request.
    requireThat(operations.includes(request?.operation) && isDigest(request.bindingHash) &&
      [admit, perform, readBack].every(value => typeof value === 'function'), 'INVALID_OPERATION_REQUEST');
    const decision = digest({ operation: request.operation, bindingHash: request.bindingHash });
    await this.#prepare();
    const lockPath = join(this.#directory, 'execution.lock');
    let lock;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') return { status: 'pending', code: 'WRITER_NOT_PROVEN_TERMINATED' }; throw error; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, decision })); await lock.sync();
      await syncDirectory(this.#directory);
      const state = await this.#read();
      if (state.pending !== null) return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
      if (state.completed.includes(decision)) return { status: 'denied', code: 'REPLAYED_OPERATION' };
      try { requireThat(await admit() === request.bindingHash, 'ADMISSION_BINDING_CHANGED'); }
      catch { return { status: 'denied', code: 'ADMISSION_FAILED' }; }
      // Durable intent precedes every external effect, including the first call.
      await this.#write({ ...state, pending: decision });
      try {
        await perform();
        requireThat(await readBack() === request.bindingHash, 'READBACK_BINDING_MISMATCH');
        await this.#write({ ...state, pending: null, completed: [...state.completed, decision] });
      } catch { return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' }; }
      return { status: 'completed', decisionId: decision };
    } finally {
      await lock.close();
      await unlink(lockPath);
      await syncDirectory(this.#directory);
    }
  }
}
