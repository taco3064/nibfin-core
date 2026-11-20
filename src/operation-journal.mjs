import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { operations } from './approval-record.mjs';
import { MergeBeforeWrite } from './github-write.mjs';
import { localDeliverInterruption } from './local-deliver-interruption.mjs';
import { githubReadWait } from './observation-failure.mjs';
import { isBootId, linuxBootId } from './linux-boot.mjs';
import { processIdentityNow } from './host-memory-pressure.mjs';
import {
  retainedRecovery, recoveryFile, inspectRecoveryFile,
  syncRecoveryDirectory as syncDirectory,
} from './recovery-lock.mjs';

async function privateDirectory(path, uid = process.getuid()) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() &&
        stat.uid === uid &&
    (stat.mode & 0o077) === 0 && await realpath(path) === resolve(path),
  'UNTRUSTED_JOURNAL_DIRECTORY');
}

function validRecoveryProvenance(value) {
  return ['commit-pr', 'review-pr'].includes(value?.operation) &&
    isId(value.pid) && isBootId(value.bootId) && /^[1-9]\d*$/.test(value.startTicks) &&
    isId(value.runnerId) && ['runId', 'attempt', 'jobId', 'actorId']
      .every(field => isId(value.execution?.[field]));
}

// Durable local execution receipts, never a copy of Issue/dependency state.
// Adapted from the reference's exclusive lease and pending-before-effect model.
// This is NOT a distributed lock. Trusted admission must separately prove no
// live/unknown previous writer on another host before invoking this component.
export class OperationJournal {
  #directory;
  #uid;
  constructor(root, issue, { uid = process.getuid() } = {}) {
    requireThat(process.platform === 'linux' && typeof process.getuid === 'function',
      'UNSUPPORTED_JOURNAL_HOST');
    requireThat(typeof issue?.id === 'string' && issue.id &&
      Number.isSafeInteger(issue.repositoryId) && issue.repositoryId > 0,
      'INVALID_JOURNAL_SUBJECT');
    requireThat(Number.isSafeInteger(uid) && uid >= 0 &&
      (uid === process.getuid() || process.getuid() === 0),
    'UNTRUSTED_JOURNAL_OWNER');
    this.#uid = uid;
    this.#directory = join(resolve(root),
      digest({ issueId: issue.id, repositoryId: issue.repositoryId }));
    this.root = resolve(root);
  }
  async #prepare() {
    await privateDirectory(this.root, this.#uid);
    const created = await mkdir(this.#directory, { mode: 0o700 }).then(
      () => true, error => { if (error.code !== 'EEXIST') throw error; });
    if (created) {
      const directory = await open(this.#directory, constants.O_RDONLY |
        constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.chown(this.#uid, -1); }
      finally { await directory.close(); }
    }
    await privateDirectory(this.#directory, this.#uid);
    await syncDirectory(this.root);
  }
  async #read() {
    const path = join(this.#directory, 'receipts.json');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      requireThat(stat.isFile() &&
        stat.uid === this.#uid && (stat.mode & 0o077) === 0 && stat.nlink === 1,
        'UNTRUSTED_JOURNAL_FILE');
      const record = JSON.parse(await handle.readFile('utf8'));
      requireThat(record.hash === digest(record.payload) &&
        record.payload.schemaVersion === 1 &&
        (record.payload.pauseDecisions === undefined ||
          Array.isArray(record.payload.pauseDecisions) &&
          record.payload.pauseDecisions.every(proof =>
            isDigest(proof?.eventHash) && isDigest(proof.observationHash) &&
            ['allowed', 'denied', 'repair'].includes(proof.qualification) &&
            typeof proof.desired === 'boolean')) &&
        Array.isArray(record.payload.completed) &&
        record.payload.completed.every(isDigest) &&
        new Set(record.payload.completed).size === record.payload.completed.length &&
        (record.payload.pending === null || isDigest(record.payload.pending)) &&
        (record.payload.pendingRecovery === undefined ||
          isDigest(record.payload.pending) &&
          validRecoveryProvenance(record.payload.pendingRecovery)) &&
        (record.payload.wakeReceipts === undefined ||
          Array.isArray(record.payload.wakeReceipts) &&
          record.payload.wakeReceipts.every(receipt =>
            isId(receipt?.runId) &&
            record.payload.completed.includes(receipt.decisionId))) &&
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
      await handle.chown(this.#uid, -1);
      await handle.writeFile(JSON.stringify({ payload, hash: digest(payload) }));
      await handle.sync();
    }
    finally { await handle.close(); }
    await rename(temp, join(this.#directory, 'receipts.json'));
    await syncDirectory(this.#directory);
  }
  // An association or observation is not an effect. Only this journal can
  // prove that dispatch never started; retained execution locks fail closed.
  async wakeRecoveryState() {
    return this.#withLock(digest({ operation: 'observe-wake-recovery' }), async state => {
      const initial = state.wakeObservation ??
        state.wakeReceipts?.at(-1)?.observation;
      if (initial) return { status: 'observed', initial };
      return state.pending === null && state.completed.length === 0
        ? { status: 'unstarted' }
        : { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
    });
  }
  async wakeObservation() {
    await this.#prepare();
    const state = await this.#read();
    return state.wakeObservation ?? state.wakeReceipts?.at(-1)?.observation ?? null;
  }
  async pauseEvidence() {
    try { await privateDirectory(this.root, this.#uid); }
    catch (error) {
      if (error.code === 'ENOENT') return { decisions: [], pending: false };
      throw error;
    }
    await this.#prepare();
    const state = await this.#read();
    return { decisions: state.pauseDecisions ?? [], pending: state.pending !== null };
  }
  async recordPauseDecision(proof) {
    requireThat(isDigest(proof?.eventHash) && isDigest(proof.observationHash) &&
      ['allowed', 'denied'].includes(proof.qualification) &&
      typeof proof.desired === 'boolean', 'INVALID_PAUSE_DECISION');
    return this.#withLock(digest(proof), async state => {
      requireThat(state.pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
      const decisions = state.pauseDecisions ?? [];
      const previous = decisions.find(item => item.eventHash === proof.eventHash);
      requireThat(!previous || digest(previous) === digest(proof),
        'PAUSE_DECISION_CHANGED');
      if (!previous) await this.#write({ ...state,
        pauseDecisions: [...decisions, proof] });
      return { status: 'completed' };
    });
  }
  // Same lock and durable intent as delivery; this receipt binds one native
  // label effect. Uncertain writes remain pending and are never blindly retried.
  async repairPause(request, { admit, perform, readBack }) {
    requireThat(isDigest(request?.bindingHash) &&
      typeof request.desired === 'boolean', 'INVALID_PAUSE_REPAIR');
    const decision = digest({ operation: 'repair-pause', ...request });
    return this.#withLock(decision, async state => {
      if (state.pending !== null)
        return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
      if (state.completed.includes(decision))
        return { status: 'denied', code: 'REPLAYED_OPERATION' };
      try {
        requireThat(await admit() === request.bindingHash, 'PAUSE_ADMISSION_CHANGED');
      } catch { return { status: 'denied', code: 'ADMISSION_FAILED' }; }
      await this.#write({ ...state, pending: decision });
      try {
        await perform();
        const proof = await readBack();
        requireThat(isDigest(proof?.eventHash) &&
          proof.observationHash === request.bindingHash &&
          proof.qualification === 'repair' && proof.desired === request.desired,
        'PAUSE_REPAIR_READBACK_UNKNOWN');
        state = { ...state,
          pauseDecisions: [...(state.pauseDecisions ?? []), proof] };
        await this.#complete(state, decision);
        return { status: 'completed', decisionId: decision };
      } catch { return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' }; }
    });
  }
  async assertIdle() {
    await this.#prepare();
    await lstat(join(this.#directory, 'execution.lock')).then(
      () => requireThat(false, 'WRITER_NOT_PROVEN_TERMINATED'),
      error => { if (error.code !== 'ENOENT') throw error; },
    );
    requireThat((await this.#read()).pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
  }
  async retireStoppedLease() {
    await this.#prepare();
    const path = join(this.#directory, 'execution.lock');
    const snapshot = await recoveryFile(path, 16384, this.#uid).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!snapshot) return;
    const { pid, decision } = JSON.parse(snapshot.bytes);
    requireThat(isId(pid) && isDigest(decision), 'UNTRUSTED_JOURNAL_FILE');
    const exited = await lstat(`/proc/${pid}`).then(() => false, error => {
      if (error.code === 'ENOENT') return true;
      throw error;
    });
    if (!exited || (await this.#read()).pending !== null) return;
    await inspectRecoveryFile(path, snapshot, 16384, this.#uid);
    await unlink(path);
    await syncDirectory(this.#directory);
  }
  async pendingStageRecovery(operation) {
    await this.#prepare();
    const { pendingRecovery, pending } = await this.#read();
    return pendingRecovery?.operation === operation ? { pendingRecovery, pending } : null;
  }
  async run(request, { admit, perform, readBack, localDeliver = false, recovery }) {
    // The binding identifies immutable approval, Scope/Shape, candidate, source,
    // role/session and operation target. All three callbacks belong to trusted
    // Core; none can be supplied by an Agent/worktree or external JSON request.
    requireThat((operations.includes(request?.operation) ||
      request?.operation === 'release') && isDigest(request.bindingHash) &&
      [admit, perform, readBack].every(value => typeof value === 'function') &&
      (request.observation === undefined || request.operation === 'wake' &&
        digest(request.observation) === request.bindingHash),
    'INVALID_OPERATION_REQUEST');
    requireThat(!localDeliver || request.operation === 'deliver',
      'INVALID_LOCAL_DELIVER_REQUEST');
    const decision = digest({
      operation: request.operation, bindingHash: request.bindingHash,
    });
    const execute = async state => {
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
      // Deliver's work-branch save is conditional and reads its exact GitHub
      // ref before retry. Other external writes still keep durable intent.
      let pendingRecovery;
      if (recovery) {
        const identity = processIdentityNow(process.pid);
        pendingRecovery = { ...identity, pid: process.pid, bootId: await linuxBootId(),
          operation: request.operation, ...recovery };
        requireThat(validRecoveryProvenance(pendingRecovery), 'INVALID_RECOVERY_PROOF');
      }
      if (!localDeliver) await this.#write({ ...state, pending: decision,
        ...(pendingRecovery ? { pendingRecovery } : {}),
        ...(request.operation === 'wake' && request.observation
          ? { wakeObservation: request.observation } : {}) });
      let phase = 'perform';
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
          await this.#write({ ...state, pending: decision, wakeRunId: result,
            ...(request.observation ? { wakeObservation: request.observation } : {}) });
          return this.#finishWake({ ...state,
            ...(request.observation ? { wakeObservation: request.observation } : {})
          }, decision, result, request, readBack);
        }
        phase = 'read-back';
        requireThat(await readBack() === request.bindingHash,
          'READBACK_BINDING_MISMATCH');
        phase = 'complete';
        await this.#complete(state, decision);
      } catch (error) {
        const waiting = localDeliver ? githubReadWait(error, undefined, { stage: true })
          : null;
        if (waiting) return waiting;
        return { status: 'pending', code: localDeliver ?
          'LOCAL_DELIVER_INTERRUPTED' : 'EXTERNAL_EFFECT_UNKNOWN',
        ...(localDeliver ? {
          localInterruption: localDeliverInterruption(phase, error),
        } : {}) };
      }
      return { status: 'completed', decisionId: decision };
    };
    if (!localDeliver) return this.#withLock(decision, execute);
    // The native Actions job serializes Deliver. Its only external write is
    // conditional on the bound work ref, so a local lease adds no protection.
    await this.#prepare();
    return execute(await this.#read());
  }
  async settleInterruptedLocalDeliver(decisions, prove) {
    requireThat(Array.isArray(decisions) && decisions.every(isDigest) &&
      typeof prove === 'function', 'INVALID_RECOVERY_REQUEST');
    const result = await this.#withLock(digest(decisions), async state => {
      if (state.pending === null) return { status: 'completed' };
      requireThat(decisions.includes(state.pending), 'EXTERNAL_EFFECT_UNKNOWN');
      await prove();
      requireThat(digest(await this.#read()) === digest(state),
        'RECOVERY_JOURNAL_CHANGED');
      // Keep prior receipts. Retiring an interrupted intent does not finish Deliver.
      await this.#write({ ...state, pending: null });
      return { status: 'completed' };
    });
    requireThat(result.status === 'completed', result.code);
  }
  async recoverWake(bindingHash, readBack) {
    requireThat(isDigest(bindingHash) && typeof readBack === 'function',
      'INVALID_RECOVERY_REQUEST');
    const request = { operation: 'wake', bindingHash };
    const decision = digest(request);
    return this.#withLock(decision, async state => {
      const receipt = state.wakeReceipts?.find(item => item.decisionId === decision);
      if (state.pending === null && state.completed.includes(decision) && receipt)
        return { status: 'completed', decisionId: decision, runId: receipt.runId };
      if (state.pending === decision && state.wakeRunId)
        return this.#finishWake(state, decision, state.wakeRunId, request, readBack);
      return { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' };
    });
  }
  async recoverCommitPr(decision, readBack, proof) {
    return this.#reconcile(decision, readBack, proof);
  }
  async #finishWake(state, decision, runId, request, readBack) {
    try {
      requireThat(await readBack(runId) === request.bindingHash,
        'READBACK_BINDING_MISMATCH');
      await this.#complete({ ...state, wakeReceipts: [
        ...(state.wakeReceipts ?? []), { decisionId: decision, runId,
          ...(state.wakeObservation ? { observation: state.wakeObservation } : {}) },
      ] }, decision);
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
      const snapshot = await recoveryFile(journalPath, 8 * 1024 * 1024, this.#uid);
      requireThat(digest(JSON.parse(snapshot.bytes).payload) === digest(state),
        'RECOVERY_JOURNAL_CHANGED');
      const receiptHash = await readBack();
      requireThat(isDigest(receiptHash), 'INVALID_RECOVERY_RECEIPT');
      await inspect();
      await privateDirectory(this.root, this.#uid);
      await privateDirectory(this.#directory, this.#uid);
      await inspectRecoveryFile(
        journalPath, snapshot, 8 * 1024 * 1024, this.#uid);
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
        async inspect => reconcile(await this.#read(), inspect), this.#uid);
    }
    return this.#withLock(decision, state => reconcile(state, proof?.prove));
  }
  async #complete(state, decision) {
    const { wakeRunId: _, wakeObservation: unused, pendingRecovery, ...prior } = state;
    void unused;
    void pendingRecovery;
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
      await lock.chown(this.#uid, -1);
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

// Read-only observations can prepare a directory without issuing any effect.
async function readScannedJournal(directory, uid) {
  const path = join(directory, 'receipts.json');
  let file;
  try { file = await recoveryFile(path, 8 * 1024 * 1024, uid); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling symlink is not an absent receipt.
    await lstat(path).then(() => { throw error; }, missing => {
      if (missing.code !== 'ENOENT') throw missing;
    });
    return { schemaVersion: 1, pending: null, completed: [] };
  }
  const { payload, hash } = JSON.parse(file.bytes);
  requireThat(hash === digest(payload) && payload.schemaVersion === 1 &&
    Array.isArray(payload.completed), 'JOURNAL_CORRUPT');
  return payload;
}

// Read only authenticated local receipts, never infer origins from run titles.
export async function readWakeOrigins(root, uid = process.getuid()) {
  try { await privateDirectory(root, uid); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = (await readdir(root)).filter(isDigest).sort();
  requireThat(names.length <= 4096, 'WAKE_JOURNAL_CAPACITY');
  const origins = [];
  for (const name of names) {
    const directory = join(root, name);
    await privateDirectory(directory, uid);
    const payload = await readScannedJournal(directory, uid);
    for (const receipt of payload.wakeReceipts ?? []) {
      const initial = receipt.observation;
      // Older receipts lack immutable source/Issue observations. Keep them;
      // neither title parsing nor queue absence can reconstruct a dispatch.
      if (!initial) {
        requireThat(isId(receipt.runId) && isDigest(receipt.decisionId) &&
          payload.completed.includes(receipt.decisionId), 'JOURNAL_CORRUPT');
        origins.push({ runId: receipt.runId, decisionId: receipt.decisionId });
        continue;
      }
      const decision = digest({ operation: 'wake', bindingHash: digest(initial) });
      requireThat(receipt.decisionId === decision && isId(receipt.runId) &&
        payload.completed.includes(decision) &&
        name === digest({ issueId: initial.issue?.id,
          repositoryId: initial.issue?.repositoryId }), 'JOURNAL_CORRUPT');
      origins.push({ initial, runId: receipt.runId, decisionId: decision });
    }
  }
  return origins;
}

export async function requireWakeEffectsSettled(root, uid = process.getuid()) {
  await privateDirectory(root, uid);
  for (const name of (await readdir(root)).filter(isDigest)) {
    const directory = join(root, name);
    await privateDirectory(directory, uid);
    await lstat(join(directory, 'execution.lock')).then(
      () => requireThat(false, 'WRITER_NOT_PROVEN_TERMINATED'),
      error => { if (error.code !== 'ENOENT') throw error; });
    const payload = await readScannedJournal(directory, uid);
    requireThat(payload.pending === null, 'EXTERNAL_EFFECT_UNKNOWN');
  }
}
