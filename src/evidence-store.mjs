import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isDigest, requireThat } from './identity.mjs';
import { stages } from './stages.mjs';

// Trusted evidence, never workflow/Issue state. Keep outside every Agent mount.
// Binding namespaces invalidate old receipts without editing their history.
export class EvidenceStore {
  #root; #directory; #binding;
  constructor(root, binding) {
    this.#root = resolve(root); this.#binding = structuredClone(binding);
    requireThat(typeof binding?.issueId === 'string' && binding.issueId &&
      ['approvalHash', 'scopeHash', 'sourceHash'].every(key => isDigest(binding[key])), 'INVALID_EVIDENCE_BINDING');
    this.#directory = join(this.#root, `evidence-${digest(binding)}`);
  }
  async #prepare() {
    for (const path of [this.#root, this.#directory]) {
      if (path !== this.#root) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(path);
      requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 && await realpath(path) === path, 'UNTRUSTED_EVIDENCE_DIRECTORY');
    }
  }
  async #sync() {
    for (const path of [this.#directory, this.#root]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  async #read(name) {
    const handle = await open(join(this.#directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
        stat.size <= 8 * 1024 * 1024, 'UNTRUSTED_EVIDENCE_FILE');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  async put(value) {
    const snapshot = structuredClone(value), hash = digest(snapshot), content = JSON.stringify(snapshot);
    requireThat(Buffer.byteLength(content) <= 8 * 1024 * 1024, 'EVIDENCE_SIZE_LIMIT'); await this.#prepare();
    let file;
    try { file = await open(join(this.#directory, hash), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (file) { try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
    requireThat(digest(await this.#read(hash)) === hash, 'EVIDENCE_OBJECT_CORRUPT'); await this.#sync();
    return hash;
  }
  async get(hash) {
    requireThat(isDigest(hash), 'INVALID_EVIDENCE_ID'); await this.#prepare();
    const value = await this.#read(hash); requireThat(digest(value) === hash, 'EVIDENCE_OBJECT_CORRUPT'); return value;
  }
  async append(value) {
    const receipt = structuredClone(value);
    requireThat(receipt.schemaVersion === 1 && Object.hasOwn(stages, receipt.stage) &&
      digest(receipt.binding) === digest(this.#binding), 'RECEIPT_BINDING_MISMATCH');
    await this.#prepare();
    const lockPath = join(this.#directory, 'append.lock');
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let temp;
    try {
      const hash = await this.put(receipt);
      temp = join(this.#directory, `${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ receiptHash: hash })); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, join(this.#directory, `${receipt.stage}.json`)); await this.#sync(); return hash;
    } finally {
      if (temp) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await lock.close(); await unlink(lockPath); await this.#sync();
    }
  }
  async load() {
    await this.#prepare(); const result = {};
    for (const stage of Object.keys(stages)) {
      let pointer;
      try { pointer = await this.#read(`${stage}.json`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const receipt = await this.get(pointer.receiptHash);
      requireThat(receipt.stage === stage && digest(receipt.binding) === digest(this.#binding), 'RECEIPT_BINDING_MISMATCH');
      result[stage] = receipt;
    }
    return result;
  }
}
