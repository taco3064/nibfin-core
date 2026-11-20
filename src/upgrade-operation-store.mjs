import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { mergeUpgradeOperations } from './upgrade-continuation-operations.mjs';

const statePath = '/etc/nibfin/upgrade-continuations.sqlite';
const legacyPath = '/etc/nibfin/upgrade-continuations.json';

async function prepareDatabase(path, verify) {
  await verify(dirname(path));
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await verify(path);
  const observed = await lstat(path);
  requireThat(observed.isFile() && observed.nlink === 1 &&
    (observed.mode & 0o077) === 0, 'UPGRADE_OPERATION_STATE_INVALID');
}

function rejectConflictingNativeIdentity(current, baseline, next) {
  for (const record of next) {
    const previous = baseline.find(item => item.id === record.id);
    if (isDeepStrictEqual(previous, record)) continue;
    if (!previous) {
      requireThat(!current.some(item => item.id !== record.id &&
        item.memberId === record.memberId &&
        isDeepStrictEqual(item.execution, record.execution) &&
        isDeepStrictEqual(item.intent, record.intent)), 'UPGRADE_OPERATION_CHANGED');
    }
    for (const consumer of record.consumers) {
      if (!consumer.proposal) continue;
      requireThat(!current.some(item => item.id !== record.id &&
        item.consumers.some(other => other.repositoryId === consumer.repositoryId &&
          other.proposal?.pullNumber === consumer.proposal.pullNumber)),
      'UPGRADE_OPERATION_CHANGED');
    }
  }
}

function readState(db) {
  const row = db.prepare('SELECT operations FROM upgrade_state WHERE id = 1').get();
  requireThat(row, 'UPGRADE_OPERATION_STATE_INVALID');
  const operations = JSON.parse(row.operations);
  requireThat(Array.isArray(operations), 'UPGRADE_OPERATION_STATE_INVALID');
  return operations;
}

export function upgradeOperationStore({
  path = statePath, legacy = legacyPath, verify = rootOwnedPath,
  readLegacy = readRetirementFile,
} = {}) {
  let baseline;
  async function transaction(use, reading = false) {
    await prepareDatabase(path, verify);
    // The legacy input is only read for initialization. Once committed, all
    // callers use the database even if the old file was retained for recovery.
    const db = new DatabaseSync(path);
    try {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE name = 'upgrade_state'",
      ).get();
      if (table && reading) return readState(db);
      const legacyState = table ? null : await readLegacy(legacy);
      requireThat(legacyState === null || legacyState.schemaVersion === 1 &&
        Array.isArray(legacyState.operations), 'UPGRADE_OPERATION_STATE_INVALID');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!table) {
          db.exec('CREATE TABLE IF NOT EXISTS upgrade_state (' +
            'id INTEGER PRIMARY KEY CHECK (id = 1), operations TEXT NOT NULL) STRICT');
          db.prepare('INSERT OR IGNORE INTO upgrade_state VALUES (1, ?)').run(
            JSON.stringify(legacyState?.operations ?? []));
        }
        const result = use(db, readState(db));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if ((error.errcode & 255) === 5)
        throw Object.assign(new Error('Upgrade state changed during publication',
          { cause: error }), { code: 'UPGRADE_OPERATION_STATE_BUSY' });
      throw error;
    } finally { db.close(); }
  }
  return {
    async read() {
      const current = await transaction((_db, value) => value, true);
      baseline = structuredClone(current);
      return current;
    },
    async write(next) {
      requireThat(baseline, 'UPGRADE_OPERATION_STATE_INVALID');
      await transaction((db, current) => {
        rejectConflictingNativeIdentity(current, baseline, next);
        const merged = mergeUpgradeOperations(current, baseline, next);
        db.prepare('UPDATE upgrade_state SET operations = ? WHERE id = 1').run(
          JSON.stringify(merged));
      });
      baseline = structuredClone(next);
    },
  };
}
