import { lstat, opendir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { readObservationFile, safePath } from './local-work-files.mjs';
import { digest, requireThat } from './identity.mjs';

// Absence is observed with lstat: dangling links and unreadable paths are not
// missing inputs. Membership is retained even for unrelated native attempts,
// whose context could otherwise be replaced to change the recovery coverage.
export class RecoveryEvidenceSnapshot {
  #entries = [];
  #bytes = 0;
  #names = 0;
  #deadline = Date.now() + 15000;
  async #observe(path, kind, limit) {
    try { return await this.#read(path, kind, limit); }
    catch (error) {
      if (error.code === 'ENOENT')
        requireThat(false, 'RECOVERY_EVIDENCE_CHANGED');
      if (['EACCES', 'EPERM'].includes(error.code))
        requireThat(false, 'RECOVERY_EVIDENCE_UNAVAILABLE');
      throw error;
    }
  }
  async #read(path, kind, limit) {
    requireThat(Date.now() < this.#deadline, 'RECOVERY_EVIDENCE_LIMIT');
    const stat = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    requireThat(!stat.isSymbolicLink(), 'UNTRUSTED_EVIDENCE');
    const identity = { ino: stat.ino, dev: stat.dev, ctimeMs: stat.ctimeMs };
    if (kind === 'directory' || kind === 'input-directory') {
      if (kind === 'input-directory') {
        // Historical input mounts were readable below a private execution root.
        await privateHostDirectory(dirname(path));
        requireThat(stat.isDirectory() && stat.uid === process.getuid() &&
          (stat.mode & 0o022) === 0, 'UNTRUSTED_HOST_STATE');
        await safePath(path, process.getuid());
      } else await privateHostDirectory(path);
      const names = [];
      for await (const entry of await opendir(path)) {
        requireThat(names.length < 4096 && ++this.#names <= 65536,
          'RECOVERY_EVIDENCE_LIMIT');
        names.push(entry.name);
      }
      return { names: names.sort(), ...identity };
    }
    const file = await readObservationFile(path, process.getuid(), limit);
    this.#bytes += Buffer.byteLength(file.bytes);
    requireThat(this.#bytes <= 64 * 1024 * 1024, 'RECOVERY_EVIDENCE_LIMIT');
    return { ...file, ...identity };
  }
  async directory(path, kind = 'directory') {
    requireThat(kind === 'directory' || kind === 'input-directory',
      'UNTRUSTED_EVIDENCE');
    const value = await this.#observe(path, kind);
    this.#entries.push({ path, kind, value });
    return value?.names ?? [];
  }
  async json(path, limit = 8 * 1024 * 1024) {
    const value = await this.#observe(path, 'file', limit);
    this.#entries.push({ path, kind: 'file', limit, value });
    if (value === null) return null;
    let parsed;
    try { parsed = JSON.parse(value.bytes); }
    catch { requireThat(false, 'RECOVERY_EVIDENCE_INVALID'); }
    requireThat(parsed !== null && typeof parsed === 'object' &&
      !Array.isArray(parsed), 'RECOVERY_EVIDENCE_INVALID');
    return parsed;
  }
  get hash() { return digest(this.#entries); }
  async confirm() {
    // Limit each filesystem scan independently of intervening native reads.
    this.#deadline = Date.now() + 15000;
    this.#bytes = 0;
    this.#names = 0;
    for (const { path, kind, limit, value } of this.#entries) {
      requireThat(digest(await this.#observe(path, kind, limit)) === digest(value),
        'RECOVERY_EVIDENCE_CHANGED');
    }
  }
}
