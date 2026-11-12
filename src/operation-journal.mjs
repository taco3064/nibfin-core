import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { operations } from './approval-record.mjs';
import { MergeBeforeWrite } from './github-write.mjs';
import {
  retainedRecovery, recoveryFile, inspectRecoveryFile,
  syncRecoveryDirectory as syncDirectory,
} from './recovery-lock.mjs';

async function privateDirectory(path) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0 && await realpath(path) === resolve(path),
  'UNTRUSTED_JOURNAL_DIRECTORY');
}

// Durable local execution receipts, never a copy of Issue/dependency state.
// Adapted from the reference's exclusive lease and pending-before-effect model.
// This is NOT a distributed lock. Trusted admission must separately prove no
// live/unknown previous writer on another host before invoking this component.
export class OperationJournal {
  #directory;
  constructor(root, issue) {
    requireThat(process.platform === 'linux' && typeof process.getuid === 'function',
      'UNSUPPORTED_JOURNAL_HOST');
    requireThat(typeof issue?.id === 'string' && issue.id &&
      Number.isSafeInteger(issue.repositoryId) && issue.repositoryId > 0,
      'INVALID_JOURNAL_SUBJECT');
    this.#directory = join(resolve(root),
      digest({ issueId: issue.id, repositoryId: issue.repositoryId }));
    this.root = resolve(root);
  }
  async #prepare() {
    await privateDirectory(this.root);
    await mkdir(this.#directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateDirectory(this.#directory);
    await syncDirectory(this.root);
  }
  async #read() {
    const path = join(this.#directory, 'receipts.json');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      requireThat(stat.isFile() &&
        stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.nlink === 1,
        'UNTRUSTED_JOURNAL_FILE');
      const record = JSON.parse(await handle.readFile('utf8'));
      requireThat(record.hash === digest(record.payload) &&
        record.payload.schemaVersion === 1 &&
        Array.isArray(record.payload.completed) &&
        record.payload.completed.every(isDigest) &&
        (record.payload.pauseEffects === undefined ||
          Array.isArray(record.payload.pauseEffects)) &&
        new Set(record.payload.completed).size === record.payload.completed.length &&
        (record.payload.pending === null || isDigest(record.payload.pending)) &&
        (record.payload.wakeRunId === undefined ||
          isDigest(record.payload.pending) && isId(record.payload.wakeRunId)),
      'JOURNAL_CORRUPT');
      return record.payload;
    } catch (error) {
      if (error.code === 'ENOENT')
        return { schemaVersion: 1, pending: null, completed: [] };
      throw error;
    } finally { await handle?.close(); }
  }
  async #write(payload) {
    const temp = join(this.#directory, `${randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ payload, hash: digest(payload) }));
      await handle.sync();
    }
    finally { await handle.close(); }
    await rename(temp, join(this.#directory, 'receipts.json'));
    await syncDirectory(this.#directory);
  }
  async pauseEffects() {
    try {
      await privateDirectory(this.root);
      await privateDirectory(this.#directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    await this.#assertUnlocked();
    const state = await this.#read();
    requireThat(state.pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
    return state.pauseEffects ?? [];
  }
  async recordPauseAuthorization(proof, inspect) {
    requireThat(proof.authorized === true && isId(proof.eventId) &&
      isId(proof.actorId) && isId(proof.repositoryId) && isDigest(proof.beforeHash) &&
      typeof proof.issueId === 'string' && typeof proof.desired === 'boolean',
    'INVALID_PAUSE_AUTHORIZATION');
    const result = await this.#withLock(digest(proof), async state => {
      requireThat(state.pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
      const effects = state.pauseEffects ?? [];
      const prior = effects.find(item => item.eventId === proof.eventId);
      if (prior) {
        requireThat(digest(prior) === digest(proof), 'PAUSE_AUTHORIZATION_CHANGED');
        return true;
      }
      await inspect();
      await this.#write({ ...state, pauseEffects: [...effects, proof] });
      return true;
    });
    requireThat(result === true, result?.code ?? 'PAUSE_AUTHORIZATION_NOT_RECORDED');
  }
  async assertIdle() {
    await this.#prepare();
    await this.#assertUnlocked();
    requireThat((await this.#read()).pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
  }
  async #assertUnlocked() {
    await lstat(join(this.#directory, 'execution.lock')).then(
      () => requireThat(false, 'WRITER_NOT_PROVEN_TERMINATED'),
      error => { if (error.code !== 'ENOENT') throw error; },
    );
  }
  async run(request, { admit, perform, readBack }) {
    // The binding identifies immutable approval, Scope/Shape, candidate, source,
    // role/session and operation target. All three callbacks belong to trusted
    // Core; none can be supplied by an Agent/worktree or external JSON request.
    requireThat((operations.includes(request?.operation) ||
      ['release', 'pause-repair'].includes(request?.operation)) &&
      isDigest(request.bindingHash) &&
      [admit, perform, readBack].every(value => typeof value === 'function'),
    'INVALID_OPERATION_REQUEST');
    const decision = digest({
      operation: request.operation, bindingHash: request.bindingHash,
    });
    return this.#withLock(decision, async state => {
      if (state.pending !== null) {
        if (request.operation === 'wake' && state.pending === decision && state.wakeRunId)
          return this.#finishWake(state, decision, state.wakeRunId, request, readBack);
        return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
      }
      if (state.completed.includes(decision))
        return { status: 'denied', code: 'REPLAYED_OPERATION' };
      try {
        requireThat(await admit() === request.bindingHash, 'ADMISSION_BINDING_CHANGED');
      }
      catch { return { status: 'denied', code: 'ADMISSION_FAILED' }; }
      // Durable intent precedes every external effect, including the first call.
      await this.#write({ ...state, pending: decision });
      try {
        let result;
        try { result = await perform(); }
        catch (error) {
          // Only the merge adapter can prove it stopped before its one write.
          if (request.operation !== 'merge' || !(error instanceof MergeBeforeWrite))
            throw error;
          await this.#write(state);
          return { status: 'pending', code: error.code };
        }
        if (request.operation === 'wake') {
          requireThat(isId(result), 'DISPATCH_IDENTITY_UNKNOWN');
          await this.#write({ ...state, pending: decision, wakeRunId: result });
          return this.#finishWake(state, decision, result, request, readBack);
        }
        requireThat(await readBack() === request.bindingHash,
          'READBACK_BINDING_MISMATCH');
        if (request.operation === 'pause-repair') {
          requireThat(result && isId(result.eventId) && isId(result.actorId) &&
              (result.rejectedEventId === undefined ||
                (!result.desired && isId(result.rejectedEventId) &&
                  result.rejectedEventId < result.eventId)) &&
            isDigest(result.beforeHash) && typeof result.desired === 'boolean' &&
            typeof result.issueId === 'string' && isId(result.repositoryId),
          'PAUSE_REPAIR_RECEIPT_UNKNOWN');
          state = { ...state,
            pauseEffects: [...(state.pauseEffects ?? []), result] };
        }
        await this.#complete(state, decision);
      } catch { return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' }; }
      return { status: 'completed', decisionId: decision };
    });
  }
  async recoverCommitPr(decision, readBack, proof) {
    return this.#reconcile(decision, readBack, proof);
  }
  async #finishWake(state, decision, runId, request, readBack) {
    try {
      requireThat(await readBack(runId) === request.bindingHash,
        'READBACK_BINDING_MISMATCH');
      await this.#complete(state, decision);
      return { status: 'completed', decisionId: decision, runId };
    } catch {
      return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN', runId };
    }
  }
  async recoverReview(bindingHash, readBack, proof) {
    requireThat(isDigest(bindingHash), 'INVALID_RECOVERY_REQUEST');
    const decision = digest({ operation: 'review-pr', bindingHash });
    return this.#reconcile(decision, readBack, proof);
  }
  async #reconcile(decision, readBack, proof) {
    requireThat(isDigest(decision) && typeof readBack === 'function',
      'INVALID_RECOVERY_REQUEST');
    const reconcile = async (state, inspect = async () => {}) => {
      requireThat(state.pending === decision ||
        state.pending === null && state.completed.includes(decision),
      'RECOVERY_DECISION_MISMATCH');
      const journalPath = join(this.#directory, 'receipts.json');
      const snapshot = await recoveryFile(journalPath, 8 * 1024 * 1024);
      requireThat(digest(JSON.parse(snapshot.bytes).payload) === digest(state),
        'RECOVERY_JOURNAL_CHANGED');
      const receiptHash = await readBack();
      requireThat(isDigest(receiptHash), 'INVALID_RECOVERY_RECEIPT');
      await inspect();
      await privateDirectory(this.root);
      await privateDirectory(this.#directory);
      await inspectRecoveryFile(journalPath, snapshot, 8 * 1024 * 1024);
      requireThat(digest(await this.#read()) === digest(state),
        'RECOVERY_JOURNAL_CHANGED');
      if (state.pending === decision) await this.#complete(state, decision);
      return { status: 'completed', decisionId: decision, receiptHash };
    };
    await this.#prepare();
    if (proof) {
      requireThat(isId(proof.pid) && typeof proof.prove === 'function',
        'INVALID_RECOVERY_PROOF');
      const retained = await lstat(join(this.#directory, 'execution.lock')).then(
        () => true, error => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        });
      if (retained) return retainedRecovery(this.#directory, decision, proof,
        async inspect => reconcile(await this.#read(), inspect));
    }
    return this.#withLock(decision, state => reconcile(state, proof?.prove));
  }
  async #complete(state, decision) {
    const { wakeRunId: _, ...prior } = state;
    await this.#write({
      ...prior, pending: null, completed: [...state.completed, decision],
    });
  }
  async #withLock(decision, use) {
    await this.#prepare();
    const lockPath = join(this.#directory, 'execution.lock');
    let lock;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code === 'EEXIST')
        return { status: 'pending', code: 'WRITER_NOT_PROVEN_TERMINATED' };
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, decision }));
      await lock.sync();
      await syncDirectory(this.#directory);
      return await use(await this.#read());
    } finally {
      await lock.close();
      await unlink(lockPath);
      await syncDirectory(this.#directory);
    }
  }
}
