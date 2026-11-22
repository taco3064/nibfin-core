import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isDigest, requireThat } from './identity.mjs';
import { stages } from './stages.mjs';

function supersededStages(pointer) {
  const value = pointer?.supersedes ?? {};
  requireThat(value && typeof value === 'object' && !Array.isArray(value),
    'EVIDENCE_OBJECT_CORRUPT');
  const result = {};
  for (const [stage, hashes] of Object.entries(value)) {
    const entries = Array.isArray(hashes) ? hashes : [hashes];
    requireThat(stage !== 'shape' && Object.hasOwn(stages, stage) &&
      entries.every(isDigest), 'EVIDENCE_OBJECT_CORRUPT');
    result[stage] = entries;
  }
  return result;
}

// Trusted evidence, never workflow/Issue state. Keep outside every Agent mount.
// Binding namespaces invalidate old receipts without editing their history.
export class EvidenceStore {
  #root; #directory; #binding; #readOnly;
  constructor(root, binding, { readOnly = false } = {}) {
    this.#readOnly = readOnly;
    this.#root = resolve(root); this.#binding = structuredClone(binding);
    requireThat(typeof binding?.issueId === 'string' && binding.issueId &&
      ['approvalHash', 'scopeHash', 'sourceHash'].every(key => isDigest(binding[key])),
    'INVALID_EVIDENCE_BINDING');
    this.#directory = join(this.#root, `evidence-${digest(binding)}`);
  }
  async #prepare() {
    for (const path of [this.#root, this.#directory]) {
      if (!this.#readOnly && path !== this.#root)
        await mkdir(path, { mode: 0o700 }).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
      const stat = await lstat(path);
      requireThat(stat.isDirectory() && !stat.isSymbolicLink() &&
        stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
        await realpath(path) === path, 'UNTRUSTED_EVIDENCE_DIRECTORY');
    }
  }
  async #sync() {
    for (const path of [this.#directory, this.#root]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY |
        constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  async #read(name) {
    const handle = await open(join(this.#directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.uid === process.getuid() &&
        stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
        stat.size <= 8 * 1024 * 1024, 'UNTRUSTED_EVIDENCE_FILE');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  async put(value) {
    requireThat(!this.#readOnly, 'READ_ONLY_EVIDENCE');
    const snapshot = structuredClone(value), hash = digest(snapshot);
    const content = JSON.stringify(snapshot);
    requireThat(Buffer.byteLength(content) <= 8 * 1024 * 1024, 'EVIDENCE_SIZE_LIMIT');
    await this.#prepare();
    let file;
    try {
      file = await open(join(this.#directory, hash), constants.O_WRONLY |
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (file) {
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
    }
    requireThat(digest(await this.#read(hash)) === hash, 'EVIDENCE_OBJECT_CORRUPT');
    await this.#sync();
    return hash;
  }
  async get(hash) {
    requireThat(isDigest(hash), 'INVALID_EVIDENCE_ID'); await this.#prepare();
    const value = await this.#read(hash);
    requireThat(digest(value) === hash, 'EVIDENCE_OBJECT_CORRUPT');
    return value;
  }
  async #pointer(stage) {
    try { return await this.#read(`${stage}.json`); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async #replacePointer(name, value) {
    requireThat(!this.#readOnly, 'READ_ONLY_EVIDENCE');
    const temp = join(this.#directory, `${randomUUID()}.tmp`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW;
    try {
      const handle = await open(temp, flags, 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, join(this.#directory, `${name}.json`));
      await this.#sync();
    } finally {
      await unlink(temp).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  // These methods are called only by the launcher of the admitted native Job.
  async replaceControllerResult(reference) {
    requireThat(reference === null || isDigest(reference), 'INVALID_EVIDENCE_ID');
    await this.#prepare();
    await this.#replacePointer('controller-result', { reference });
  }
  async readControllerResult() {
    await this.#prepare();
    let pointer;
    try { pointer = await this.#read('controller-result.json'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    requireThat(pointer && Object.keys(pointer).length === 1 &&
      (pointer.reference === null || isDigest(pointer.reference)),
    'EVIDENCE_OBJECT_CORRUPT');
    return pointer.reference;
  }
  async #nextPointer(receipt, hash) {
    if (receipt.stage !== 'shape') return { receiptHash: hash };
    const previous = await this.#pointer('shape');
    if (previous?.receiptHash === hash) return previous;
    const supersedes = supersededStages(previous);
    for (const stage of Object.keys(stages).filter(name => name !== 'shape')) {
      const pointer = await this.#pointer(stage);
      if (pointer) {
        requireThat(isDigest(pointer.receiptHash), 'INVALID_EVIDENCE_ID');
        supersedes[stage] = [...new Set([
          ...(supersedes[stage] ?? []), pointer.receiptHash,
        ])];
      }
    }
    // One existing pointer is the atomic active-work boundary. Old immutable
    // receipts remain readable; a new author never inherits an old close result.
    return { receiptHash: hash, supersedes,
      ...(previous ? { previousShape: previous.receiptHash } : {}) };
  }
  async append(value) {
    requireThat(!this.#readOnly, 'READ_ONLY_EVIDENCE');
    const receipt = structuredClone(value);
    requireThat(receipt.schemaVersion === 1 && Object.hasOwn(stages, receipt.stage) &&
      digest(receipt.binding) === digest(this.#binding), 'RECEIPT_BINDING_MISMATCH');
    await this.#prepare();
    const lockPath = join(this.#directory, 'append.lock');
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW;
    const lock = await open(lockPath, flags, 0o600);
    try {
      const hash = await this.put(receipt);
      const pointer = await this.#nextPointer(receipt, hash);
      await this.#replacePointer(receipt.stage, pointer);
      return hash;
    } finally {
      await lock.close(); await unlink(lockPath); await this.#sync();
    }
  }
  async #stageReceipt(stage, shape, superseded) {
    const pointer = stage === 'shape' ? shape : await this.#pointer(stage);
    if (!pointer || superseded[stage]?.includes(pointer.receiptHash)) return null;
    const receipt = await this.get(pointer.receiptHash);
    requireThat(receipt.stage === stage &&
      digest(receipt.binding) === digest(this.#binding), 'RECEIPT_BINDING_MISMATCH');
    return receipt;
  }
  async loadStage(stage) {
    requireThat(Object.hasOwn(stages, stage), 'INVALID_STAGE_REQUEST');
    await this.#prepare();
    const shape = await this.#pointer('shape');
    return this.#stageReceipt(stage, shape, supersededStages(shape));
  }
  async load() {
    await this.#prepare(); const result = {};
    const shape = await this.#pointer('shape');
    const supersedes = supersededStages(shape);
    for (const stage of Object.keys(stages)) {
      const receipt = await this.#stageReceipt(stage, shape, supersedes);
      if (receipt) result[stage] = receipt;
    }
    return result;
  }
}
