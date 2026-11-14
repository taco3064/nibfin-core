import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/identity.mjs';
import {
  pauseQualification,
  interpretPause,
  observePause,
  requireUnpaused,
} from '../src/pause.mjs';
import { pauseFixture, pauseIdentity, people } from './pause-fixture.mjs';

function qualify(f, actor, permission = 'write', adding = true) {
  return pauseQualification({
    repository: f.repository,
    actor,
    permission: { user: actor, permission },
    issue: f.issue,
    adding,
  });
}

test('native qualification covers owner, organization admin, write and triage',
  async (t) => {
  const f = await pauseFixture(t);
  f.issue.assignees = [];
  assert.equal(qualify(f, people.owner, 'none'), 'allowed');
  assert.equal(qualify(f, people.assignee, 'triage'), 'denied');
  f.issue.assignees = [people.assignee];
  for (const permission of ['write', 'triage', 'maintain'])
    assert.equal(qualify(f, people.assignee, permission), 'allowed');
  for (const permission of ['none', 'read'])
    assert.equal(qualify(f, people.assignee, permission), 'denied');
  f.repository.owner = { id: 99, type: 'Organization' };
  f.issue.assignees = [];
  assert.equal(qualify(f, people.stranger, 'admin'), 'allowed');
  assert.equal(qualify(f, people.stranger, 'write'), 'denied');
  assert.equal(qualify(f, people.stranger, 'custom-unproved'), 'unknown');
});

test('qualification ignores Runner ownership and availability; completion denies',
  async (t) => {
  const f = await pauseFixture(t);
  f.issue.runner = { status: 'offline' };
  assert.equal(qualify(f, people.assignee, 'triage'), 'allowed');
  f.issue.assignees = [];
  assert.equal(qualify(f, people.owner, 'none'), 'allowed');
  f.issue.labels.push({ name: 'delivered' });
  assert.equal(qualify(f, people.owner), 'denied');
  assert.equal(qualify(f, people.owner, 'none', false), 'allowed');
  f.issue.labels = [];
  f.issue.state = 'closed';
  assert.equal(qualify(f, people.owner), 'denied');
  assert.equal(qualify(f, { ...people.owner, id: undefined }), 'unknown');
  assert.equal(
    pauseQualification({
      repository: f.repository,
      issue: f.issue,
      actor: people.assignee,
      permission: { user: people.owner, permission: 'admin' },
      adding: false,
    }),
    'unknown',
  );
});

test('complete empty history differs from missing, malformed or changing history',
  async (t) => {
  const f = await pauseFixture(t);
  const clear = await observePause(f.reader, pauseIdentity);
  assert.equal(clear.status, 'clear');
  assert.doesNotThrow(() => requireUnpaused(clear, pauseIdentity));
  assert.throws(() => requireUnpaused(clear, { ...pauseIdentity, id: 'other' }));
  f.fault('history');
  assert.equal((await observePause(f.reader, pauseIdentity)).status, 'pending');
  f.fault(undefined);
  const list = f.reader.list;
  let count = 0;
  f.reader.list = async (path) => {
    const value = await list(path);
    if (++count === 2) value.push({ id: 99 });
    return value;
  };
  assert.equal(
    (await observePause(f.reader, pauseIdentity)).code,
    'PAUSE_OBSERVATION_CHANGED',
  );
  for (const events of [
    undefined,
    [{}],
    [{ id: 1, event: 'labeled', label: {}, created_at: 'bad' }],
  ])
    assert.equal(interpretPause({ issue: f.issue, events }).status, 'pending');
});

test('visible label absence never proves Resume across the post-event gap', async (t) => {
  const f = await pauseFixture(t);
  const pause = f.emit(people.owner, 'labeled');
  assert.equal((await f.reconcile(pause)).status, 'paused');
  f.emit(people.stranger, 'unlabeled');
  const evidence = await f.journal.pauseEvidence();
  const pending = await observePause(f.reader, pauseIdentity, evidence.decisions);
  assert.equal(pending.status, 'pending');
  assert.throws(() => requireUnpaused(pending, pauseIdentity));
  // Today's assignment or permission is never substituted for missing proof.
  f.issue.assignees = [people.stranger];
  assert.equal(
    (await observePause(f.reader, pauseIdentity, evidence.decisions)).status,
    'pending',
  );
});

test('dependency event IDs from E2E #25 and #34 can arrive out of order', async t => {
  const f = await pauseFixture(t);
  for (const ids of [[36005413247, 36005413052], [36005457878, 36005457393]]) {
    const events = ids.map((id, index) => ({
      id, event: 'blocked_by_added', created_at: `2026-11-13T07:52:1${index}Z`,
    }));
    assert.equal(interpretPause({ issue: f.issue, events }).status, 'clear');
    const pause = {
      id: 2, event: 'labeled', label: { name: 'pause' }, actor: people.owner,
      created_at: '2026-11-13T16:00:00Z',
    };
    const resume = {
      ...pause, id: pause.id - 1, event: 'unlabeled',
    };
    const result = interpretPause({ issue: f.issue, events: [...events, pause, resume] });
    assert.equal(result.code, 'PAUSE_HISTORY_INCONSISTENT');
    assert.throws(() => requireUnpaused(result, pauseIdentity), {
      code: 'PAUSE_OBSERVATION_UNKNOWN', pauseReason: 'PAUSE_HISTORY_INCONSISTENT',
    });
  }
});

test('ordered history rejects duplicate, contradictory and unbound event receipts',
  async (t) => {
  const f = await pauseFixture(t);
  f.emit(people.owner, 'labeled');
  const event = f.events[0];
  const decision = {
    eventHash: digest(event),
    observationHash: 'a'.repeat(64),
    qualification: 'allowed',
    desired: true,
  };
  assert.equal(
    interpretPause({ issue: f.issue, events: f.events, decisions: [decision] }).status,
    'paused',
  );
  for (const decisions of [[], [decision, decision], [{ ...decision, desired: false }]])
    assert.equal(
      interpretPause({ issue: f.issue, events: f.events, decisions }).status,
      'pending',
    );
  assert.equal(
    interpretPause({ issue: f.issue, events: [event, event], decisions: [decision] })
      .status,
    'pending',
  );
});

test('native read permission with triage role supplies label-edit permission',
  async t => {
  const f = await pauseFixture(t);
  const permission = { user: people.assignee, permission: 'read', role_name: 'triage' };
  assert.equal(pauseQualification({ repository: f.repository, actor: people.assignee,
    permission, issue: f.issue, adding: true }), 'allowed');
  f.issue.assignees = [];
  assert.equal(pauseQualification({ repository: f.repository, actor: people.assignee,
    permission, issue: f.issue, adding: false }), 'denied');
});
