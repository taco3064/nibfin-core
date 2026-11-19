import test from 'node:test';
import assert from 'node:assert/strict';
import { observePause } from '../src/pause.mjs';
import { pauseFixture, pauseIdentity, people } from './pause-fixture.mjs';

test('Owner Resume after offline Pause needs no missing historical receipt', async t => {
  const f = await pauseFixture(t);
  f.emit(people.owner, 'labeled');
  assert.equal((await f.journal.pauseEvidence()).decisions.length, 0);
  const result = await f.reconcile(f.emit(people.owner, 'unlabeled'));
  assert.equal(result.status, 'clear');
  assert.equal(f.writes(), 0);
  const evidence = await f.journal.pauseEvidence();
  assert.equal(evidence.decisions.length, 1);
  assert.equal(evidence.decisions[0].eventId, f.events.at(-1).id);
  assert.equal((await observePause(f.reader, pauseIdentity,
    evidence.decisions)).status, 'clear');
});

test('a qualified Pause also overrides an unknown earlier transition', async t => {
  const f = await pauseFixture(t);
  f.emit(people.stranger, 'labeled');
  f.emit(people.stranger, 'unlabeled');
  assert.equal((await f.reconcile(f.emit(people.owner, 'labeled'))).status, 'paused');
  assert.equal(f.writes(), 0);
});

test('an unauthorized Resume cannot replace missing historical qualification',
  async t => {
    const f = await pauseFixture(t);
    f.emit(people.owner, 'labeled');
    const result = await f.reconcile(f.emit(people.stranger, 'unlabeled'));
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'PAUSE_HISTORY_UNKNOWN');
    assert.equal(f.writes(), 0);
  });

test('stable native event identity survives mutable actor presentation', async t => {
  const f = await pauseFixture(t);
  await f.reconcile(f.emit(people.owner, 'labeled'));
  const evidence = await f.journal.pauseEvidence();
  f.events[0].actor.avatar_url = 'https://example.invalid/new-avatar';
  assert.equal((await observePause(f.reader, pauseIdentity,
    evidence.decisions)).status, 'paused');
  f.emit(people.stranger, 'unlabeled');
  assert.equal((await observePause(f.reader, pauseIdentity,
    evidence.decisions)).status, 'pending');
});
