import test from 'node:test';
import assert from 'node:assert/strict';
import { observePause } from '../src/pause.mjs';
import { pauseFixture, pauseIdentity, people } from './pause-fixture.mjs';

for (const permission of ['write', 'triage']) {
  test(`assigned ${permission} collaborator can pause and resume`, async (t) => {
    const f = await pauseFixture(t);
    f.permissions.assignee = permission;
    assert.equal(
      (await f.reconcile(f.emit(people.assignee, 'labeled'))).status,
      'paused',
    );
    assert.equal(
      (await f.reconcile(f.emit(people.assignee, 'unlabeled'))).status,
      'clear',
    );
    assert.equal(f.writes(), 0);
  });
}

test('owner and effective organization admin resume any actor pause', async (t) => {
  for (const organization of [false, true]) {
    const f = await pauseFixture(t);
    if (organization) {
      f.repository.owner = { type: 'Organization', id: 99 };
      f.permissions.stranger = 'admin';
    }
    await f.reconcile(f.emit(people.assignee, 'labeled'));
    assert.equal(
      (
        await f.reconcile(
          f.emit(organization ? people.stranger : people.owner, 'unlabeled'),
        )
      ).status,
      'clear',
    );
  }
});

test('unauthorized addition is minimally removed with durable receipt and replay safety',
  async (t) => {
  const f = await pauseFixture(t);
  const body = f.issue.body;
  const event = f.emit(people.stranger, 'labeled');
  assert.equal((await f.reconcile(event)).status, 'clear');
  assert.equal(f.writes(), 1);
  assert.equal(f.issue.body, body);
  assert.deepEqual(f.issue.labels, [{ name: 'scope' }, { name: 'unrelated' }]);
  assert.ok(f.inspections() >= 4);
  const evidence = await f.journal.pauseEvidence();
  assert.equal(evidence.pending, false);
  assert.deepEqual(
    evidence.decisions.map((item) => item.qualification),
    ['denied', 'repair'],
  );
  const restoredEvent = {
    action: 'unlabeled',
    sender: people.controller,
    label: { name: 'pause' },
    issue: structuredClone(f.issue),
  };
  assert.equal((await f.reconcile(restoredEvent)).status, 'clear');
  assert.equal((await f.reconcile(event)).status, 'pending');
  assert.equal(f.writes(), 1);
});

test('unauthorized removal is restored and never clears the effective pause',
  async (t) => {
  const f = await pauseFixture(t);
  await f.reconcile(f.emit(people.owner, 'labeled'));
  const event = f.emit(people.stranger, 'unlabeled');
  assert.equal((await f.reconcile(event)).status, 'paused');
  assert.equal(f.writes(), 1);
  assert.ok(f.issue.labels.some((label) => label.name === 'pause'));
  const proof = await f.journal.pauseEvidence();
  assert.equal(
    (await observePause(f.reader, pauseIdentity, proof.decisions)).status,
    'paused',
  );
});

test('reassignment permits the new assignee; receipts do not requalify past actors',
  async (t) => {
  const f = await pauseFixture(t);
  const event = f.emit(people.assignee, 'labeled');
  await f.reconcile(event);
  f.permissions.assignee = 'none';
  assert.equal((await f.reconcile(event)).status, 'paused');
  f.issue.assignees = [people.stranger];
  assert.equal(
    (await f.reconcile(f.emit(people.stranger, 'unlabeled'))).status,
    'clear',
  );
  assert.equal(f.writes(), 0);
});

test('repeated additions preserve pause and unassigned triage cannot resume',
  async (t) => {
  const f = await pauseFixture(t);
  await f.reconcile(f.emit(people.owner, 'labeled'));
  await f.reconcile(f.emit(people.stranger, 'labeled'));
  assert.equal(f.writes(), 0);
  f.issue.assignees = [];
  assert.equal(
    (await f.reconcile(f.emit(people.assignee, 'unlabeled'))).status,
    'paused',
  );
  assert.equal(f.writes(), 1);
});

for (const fault of ['lost', 'dropped']) {
  test(`${fault} repair response retains pending intent and prevents blind retry`,
    async (t) => {
    const f = await pauseFixture(t);
    const event = f.emit(people.stranger, 'labeled');
    f.fault(fault);
    assert.equal((await f.reconcile(event)).status, 'pending');
    assert.equal((await f.journal.pauseEvidence()).pending, true);
    f.fault(undefined);
    assert.equal((await f.reconcile(event)).status, 'pending');
    assert.equal(f.writes(), 1);
    await assert.rejects(f.journal.assertIdle(), /EXTERNAL_EFFECT_UNKNOWN/);
  });
}

test('revoked authority, stale assignments and unknown history prevent mutations',
  async (t) => {
  for (const fault of ['revoked', 'history', 'assignment']) {
    const f = await pauseFixture(t);
    const event = f.emit(people.stranger, 'labeled');
    if (fault === 'assignment') f.issue.assignees = [];
    else f.fault(fault);
    assert.equal((await f.reconcile(event)).status, 'pending');
    assert.equal(f.writes(), 0);
  }
});

test('completed Issue rejects and removes a new pause without changing completion',
  async (t) => {
  const f = await pauseFixture(t);
  f.issue.state = 'closed';
  f.issue.labels.push({ name: 'delivered' });
  assert.equal((await f.reconcile(f.emit(people.owner, 'labeled'))).status, 'clear');
  assert.equal(f.issue.state, 'closed');
  assert.ok(f.issue.labels.some((label) => label.name === 'delivered'));
  assert.equal(f.writes(), 1);
});

test('permission churn during qualification cannot produce a pause decision',
  async (t) => {
  const f = await pauseFixture(t);
  const get = f.reader.get;
  let reads = 0;
  f.reader.get = async (path) => {
    const value = await get(path);
    if (path.includes('/assignee/permission') && ++reads > 1) value.permission = 'none';
    return value;
  };
  const result = await f.reconcile(f.emit(people.assignee, 'labeled'));
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'PAUSE_QUALIFICATION_CHANGED');
  assert.equal((await f.journal.pauseEvidence()).decisions.length, 0);
  assert.equal(f.writes(), 0);
});
