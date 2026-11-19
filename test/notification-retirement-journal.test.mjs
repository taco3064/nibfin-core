import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RelayJournal, writeRelayState } from '../src/relay-state.mjs';
import { pruneNotificationJournal }
  from '../src/notification-retirement-host.mjs';

test('real private journal cleanup keeps only recovery, pause and unrelated state', {
  skip: process.platform !== 'linux' && 'requires Linux UID, private modes and flock',
}, async t => {
  const parent = resolve('.deliver-test-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'notification-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new RelayJournal(root);
  await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: true });
  for (const [runId, status] of [[10, 'consumed'], [11, 'pending'], [12, 'skipped']]) {
    const origin = { repositoryId: 1, runId, attempt: 1 };
    await journal.write({ origin, status, intent: { origin }, runId: 50 });
  }
  const unrelated = { repositoryId: 2, runId: 20, attempt: 1 };
  await journal.write({ origin: unrelated, status: 'consumed',
    intent: { origin: unrelated } });
  await writeRelayState(root, 'poll-1.json', { cursor: 'obsolete' });
  await writeRelayState(root, 'replacement-' + 'a'.repeat(64) + '.json',
    { status: 'pending' });
  await writeFile(join(root, 'origin-1-13-1.json'), '{invalid', { mode: 0o600 });
  const pausedBefore = await readFile(join(root, 'control.json'), 'utf8');
  const unknownBefore = await readFile(join(root, 'origin-1-11-1.json'), 'utf8');
  const retained = await pruneNotificationJournal(root, [1]);
  assert(Array.isArray(retained), 'kernel gate must execute the cleanup');
  assert(retained.includes('control.json'));
  assert(retained.includes('origin-1-11-1.json'));
  assert(retained.includes('origin-1-13-1.json'));
  assert(retained.includes('origin-2-20-1.json'));
  assert(retained.includes('replacement-' + 'a'.repeat(64) + '.json'));
  const names = await readdir(root);
  assert(!names.includes('origin-1-10-1.json'));
  assert(!names.includes('origin-1-12-1.json'));
  assert(!names.includes('poll-1.json'));
  assert.equal(await readFile(join(root, 'control.json'), 'utf8'), pausedBefore);
  assert.equal(await readFile(join(root, 'origin-1-11-1.json'), 'utf8'), unknownBefore);
  assert.deepEqual(new Set(await pruneNotificationJournal(root, [1])),
    new Set(retained));
});
