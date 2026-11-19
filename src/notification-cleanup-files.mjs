import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, requireThat } from './identity.mjs';
import { RelayJournal } from './relay-state.mjs';
import { operationReceiptLimit } from './operation-journal.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import {
  relayConfigFile, relayStateRoot, relayUnitDirectory, validateRelayConfiguration,
} from './relay-host.mjs';

// Filesystem seam used by controlled fixtures; the installed entry supplies only
// fixed resource paths and the maintained templates from relay-service.
export class NotificationCleanupFiles {
  constructor(contents, { config = relayConfigFile, root = relayStateRoot,
    units = relayUnitDirectory, inspect = rootOwnedPath } = {}) {
    Object.assign(this, { contents, config, root, units, inspect });
  }
  async snapshot(path, limit = 262144) {
    const stat = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!stat) return null;
    await this.inspect(path);
    requireThat(stat.isFile() && stat.nlink === 1,
      'NOTIFICATION_RESOURCE_CONFLICT');
    return { path, dev: stat.dev, ino: stat.ino,
      bytes: await boundedHostFile(path, limit), limit };
  }
  async ownedUnits() {
    const result = [];
    for (const [name, expected] of this.contents) {
      const file = await this.snapshot(join(this.units, name));
      requireThat(!file || file.bytes === expected, 'NOTIFICATION_RESOURCE_CONFLICT');
      if (file) result.push(file);
    }
    return result;
  }
  async configuration(consumers) {
    const file = await this.snapshot(this.config);
    if (file) {
      const value = validateRelayConfiguration(JSON.parse(file.bytes));
      requireThat(value.origins.every(origin => consumers.some(consumer =>
        consumer.repositoryId === origin.repositoryId &&
        consumer.repository === origin.repository)), 'NOTIFICATION_REFERENCES_UNKNOWN');
    }
    return file;
  }
  async resources(consumers) {
    const result = await this.ownedUnits();
    const config = await this.configuration(consumers);
    if (config) result.push(config);
    const present = await lstat(this.root).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!present) return result;
    await this.inspect(this.root);
    await privateHostDirectory(this.root);
    const journal = new RelayJournal(this.root);
    const names = new Set(await readdir(this.root));
    const retained = new Set();
    const replacements = new Set([...names].flatMap(name => {
      const match = /^(replacement-[a-f0-9]{64})(?:\.json)?$/.exec(name);
      return match ? [match[1]] : [];
    }));
    // Dispose of supporting evidence first. An interrupted removal must leave
    // the origin available to attribute any remaining operation to its pool.
    for (const name of replacements) {
      try {
        await journal.requireReplacementEffectsSettled({ only: name + '.json',
          inspect: true, affects: () => true });
        const resources = [];
        if (names.has(name))
          resources.push(...await this.replacementDirectory(join(this.root, name)));
        if (names.has(name + '.json'))
          resources.push(await this.snapshot(join(this.root, name + '.json')));
        result.push(...resources);
      } catch {
        retained.add(name);
        for (const entry of [name, name + '.json'].filter(item => names.has(item)))
          result.push({ path: join(this.root, entry), unresolved: true,
            purpose: 'replacement recovery evidence lacks verified safe settlement' });
      }
    }
    for (const name of names) {
      if (/^replacement-[a-f0-9]{64}(?:\.json)?$/.test(name)) continue;
      const path = join(this.root, name);
      if (name === 'relay.lock') {
        result.push({ path, purpose: 'stable serialization for cleanup and recovery' });
        continue;
      }
      const file = await this.snapshot(path);
      if (/^origin-\d+-\d+-1\.json$/.test(name)) {
        const origin = JSON.parse(file.bytes).origin;
        const record = await journal.read(origin);
        requireThat(record && name ===
          `origin-${origin.repositoryId}-${origin.runId}-1.json`,
        'RELAY_JOURNAL_CORRUPT');
        const replacement = 'replacement-' + digest(origin);
        if (retained.has(replacement)) {
          result.push({ path, unresolved: true,
            purpose: 'source attribution for retained replacement recovery evidence' });
          continue;
        }
        if (record.status === 'pending') {
          result.push({ path, unresolved: true,
            purpose: 'original unresolved dispatch intent and exact-run recovery' });
          continue;
        }
      } else if (name === 'control.json') {
        await journal.control();
      } else if (name === 'replacement-poll.json') {
        const cache = JSON.parse(file.bytes);
        requireThat(Object.keys(cache).length === 1 &&
          Number.isSafeInteger(cache.position) && cache.position >= 0,
        'NOTIFICATION_RESOURCE_CONFLICT');
      } else if (/^poll-\d+\.json$/.test(name)) {
        const cache = JSON.parse(file.bytes);
        requireThat(Object.keys(cache).every(key => ['nextAt', 'etag'].includes(key)) &&
          Number.isFinite(cache.nextAt) &&
          (cache.etag === null || typeof cache.etag === 'string'),
        'NOTIFICATION_RESOURCE_CONFLICT');
      } else {
        result.push({ path, unresolved: true,
          purpose: 'unrecognized material requires ownership investigation' });
        continue;
      }
      result.push(file);
    }
    return result;
  }
  async replacementDirectory(path) {
    await this.inspect(path);
    await privateHostDirectory(path);
    const result = [];
    for (const name of await readdir(path)) {
      requireThat(/^[a-f0-9]{64}$/.test(name), 'NOTIFICATION_RESOURCE_CONFLICT');
      const directory = join(path, name);
      await this.inspect(directory);
      await privateHostDirectory(directory);
      for (const entry of await readdir(directory)) {
        requireThat(entry === 'receipts.json', 'NOTIFICATION_RESOURCE_CONFLICT');
        // Match the maintained operation-journal reader's receipt bound.
        result.push(await this.snapshot(join(directory, entry), operationReceiptLimit));
      }
      result.push(await this.directorySnapshot(directory));
    }
    result.push(await this.directorySnapshot(path));
    return result;
  }
  async directorySnapshot(path) {
    const stat = await lstat(path);
    return { path, directory: true, dev: stat.dev, ino: stat.ino };
  }
  async remove(expected) {
    if (expected.directory) {
      const stat = await lstat(expected.path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!stat) return;
      await this.inspect(expected.path);
      await privateHostDirectory(expected.path);
      requireThat(stat.dev === expected.dev && stat.ino === expected.ino &&
        (await readdir(expected.path)).length === 0, 'NOTIFICATION_RESOURCE_CHANGED');
      await rmdir(expected.path);
      await syncRecoveryDirectory(dirname(expected.path));
      return;
    }
    const current = await this.snapshot(expected.path, expected.limit);
    if (!current) return;
    requireThat(current.dev === expected.dev && current.ino === expected.ino &&
      current.bytes === expected.bytes, 'NOTIFICATION_RESOURCE_CHANGED');
    await unlink(expected.path);
    await syncRecoveryDirectory(dirname(expected.path));
  }
  async absent(resource) {
    try { await lstat(resource.path); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
}
