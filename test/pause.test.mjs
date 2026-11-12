import test from 'node:test';
import assert from 'node:assert/strict';
import { observePause, requirePauseClear } from '../src/pause.mjs';
import { pauseFixture, identity, owner, member, other, bot,
  repairFixture, additionEvent } from './pause-fixture.mjs';
import { decideStage } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

const observe = f => observePause(f.reader, identity);

test('native qualification uses owner/admin and assigned label permission, no Runner',
  async () => {
    for (const kind of ['owner', 'admin', 'write', 'triage', 'triage-role']) {
      const f = pauseFixture();
      let actor = member;
      if (kind === 'owner') {
        actor = owner;
        f.issue.assignees = [];
      } else if (kind === 'admin') {
        actor = other;
        f.repository.owner = { id: 50, type: 'Organization' };
        f.issue.assignees = [];
      } else {
        const result = f.permissions.get(member.login);
        result.permission = kind === 'triage-role' ? 'read' : kind;
        if (kind === 'triage-role') result.role_name = 'triage';
      }
      f.add(actor);
      assert.equal((await observe(f)).status, 'paused', kind);
      // Offline or absent Runners are intentionally not read by this policy.
      assert.equal((await observe(f)).actorId, actor.id);
    }
  });

test('unassigned, insufficient, completed and mismatched identities fail closed',
  async () => {
    for (const kind of ['unassigned', 'read', 'closed', 'delivered', 'identity']) {
      const f = pauseFixture();
      if (kind === 'unassigned') f.issue.assignees = [];
      if (kind === 'read') f.permissions.get(member.login).permission = 'read';
      if (kind === 'closed') f.issue.state = 'closed';
      if (kind === 'delivered') f.issue.labels.push({ name: 'delivered' });
      if (kind === 'identity') f.permissions.get(member.login).user = other;
      const event = additionEvent(f.issue, f.add(member));
      const result = await observePause(f.reader, identity, [], event);
      const ambiguous = kind === 'identity';
      assert.equal(result.status, ambiguous ? 'unknown' : 'repair', kind);
      if (result.status === 'repair') assert.equal(result.desired, false);
    }
    const f = pauseFixture();
    f.add(member);
    f.permissions.clear();
    assert.equal((await observe(f)).status, 'unknown');
  });

test('the repository owner can resume a pause added by an assignee', async () => {
    const f = pauseFixture();
    f.add(member);
    f.add(owner);
    assert.equal((await observe(f)).actorId, member.id);
    f.add(owner, false);
    assert.equal((await observe(f)).status, 'clear');
});

test('a newly assigned collaborator can resume another actor’s pause', async t => {
  const f = await repairFixture(t);
  f.add(owner);
  const removal = additionEvent(f.issue, f.add(member, false));
  assert.equal((await observe(f)).status, 'repair');
  assert.equal((await f.repair(removal)).status, 'clear');
  f.issue.assignees = [];
  assert.equal((await f.repair()).status, 'clear');
  assert.equal(f.state.writes, 0);
});

test('organization admin can resume and unassigned triage cannot control pause',
  async t => {
    const f = await repairFixture(t);
    f.repository.owner = { id: 50, type: 'Organization' };
    f.permissions.get(other.login).permission = 'triage';
    assert.equal((await f.repair(additionEvent(f.issue, f.add(other)))).status,
      'clear');
    assert.equal(f.state.writes, 1);
    f.add(member);
    assert.equal((await f.repair(additionEvent(f.issue, f.add(other, false)))).status,
      'paused');
    assert.equal(f.state.writes, 2);
    f.permissions.get(other.login).permission = 'admin';
    const removal = additionEvent(f.issue, f.add(other, false));
    assert.equal((await f.repair(removal)).status, 'clear');
    assert.equal(f.state.writes, 2);
  });

test('history absence, malformed order, truncation and unstable reads stay Unknown',
  async () => {
    for (const kind of ['absent', 'malformed', 'duplicate', 'order', 'missing',
      'changed', 'identity', 'repo', 'bot']) {
      const f = pauseFixture();
      f.add(owner);
      f.add(other, false);
      if (kind === 'absent') f.state.failure = 'history';
      if (kind === 'malformed') f.events[0].actor.id = null;
      if (kind === 'duplicate') f.events.push(f.events[1]);
      if (kind === 'order') f.events.reverse();
      if (kind === 'missing') delete f.events[0].label;
      if (kind === 'identity') f.issue.node_id = 'I_other';
      if (kind === 'repo') f.repository.id = 11;
      if (kind === 'bot') f.add(bot);
      if (kind === 'changed') {
        const list = f.reader.list.bind(f.reader);
        let reads = 0;
        f.reader.list = async path => {
          if (++reads === 2) f.add(owner, false);
          return list(path);
        };
      }
      assert.equal((await observe(f)).status, 'unknown', kind);
    }
    const f = pauseFixture();
    f.issue.labels.push({ name: 'pause' });
    assert.equal((await observe(f)).status, 'unknown');
    f.reader.list = async () => { throw new Error('Incomplete pagination'); };
    assert.equal((await observe(f)).status, 'unknown');
  });

test('complete paginated history differs from unavailable history', async () => {
  const f = pauseFixture();
  for (let index = 0; index < 102; index++) f.add(owner, index % 2 === 0);
  assert.equal((await observe(f)).status, 'clear');
  f.reader.list = async () => { throw new Error('Pagination limit exceeded'); };
  assert.equal((await observe(f)).status, 'unknown');
});

test('stage admission requires coherent pause evidence even when label is absent', () => {
  const context = stageFixture();
  assert.equal(decideStage('shape', context, now).status, 'allowed');
  for (const pause of [undefined, { status: 'unknown' }, { status: 'repair' },
    { ...context.pause, status: 'paused' },
    { ...context.pause, issueId: 'I_wrong' }]) {
    assert.notEqual(decideStage('shape', { ...context, pause }, now).status, 'allowed');
  }
});

test('minimal journaled repairs remove invalid additions and authenticate restoration',
  async t => {
    for (const restore of [false, true]) {
      const f = await repairFixture(t);
      const native = f.add(restore ? member : other);
      if (!restore) f.issue.assignees = [];
      else f.add(other, false);
      const before = { body: f.issue.body, title: f.issue.title,
        assignees: structuredClone(f.issue.assignees) };
      const event = restore ? undefined : additionEvent(f.issue, native);
      const result = await f.repair(event);
      assert.equal(result.status, restore ? 'paused' : 'clear');
      assert.equal(result.actorId, restore ? member.id : undefined);
      assert.equal(f.state.writes, 1);
      assert.equal(f.issue.body, before.body);
      assert.equal(f.issue.title, before.title);
      assert.deepEqual(f.issue.assignees, before.assignees);
      assert.ok(f.issue.labels.some(label => label.name === 'unrelated'));
      const proof = await f.journal.pauseEffects();
      assert.equal(proof.length, 1);
      assert.equal((await f.repair()).status, result.status);
      assert.equal(f.state.writes, 1);
      if (restore) {
        assert.equal((await observe(f)).status, 'unknown');
        f.add(owner, false);
        const resumed = await observePause(f.reader, identity, proof);
        assert.equal(resumed.status, 'clear');
        assert.equal((await f.repair()).status, 'clear');
        f.add(owner);
        assert.equal((await f.repair()).actorId, owner.id);
      }
    }
  });

test('revocation and failed/lost/contradictory writes never retry blindly', async t => {
  for (const failure of ['revoked', 'lost', 'failed', 'body', 'label']) {
    const f = await repairFixture(t);
    f.add(member);
    f.add(other, false);
    if (failure === 'revoked') f.state.authority = false;
    else f.state.failure = failure;
    assert.equal((await f.repair()).status, 'unknown', failure);
    assert.equal((await f.repair()).status, 'unknown', failure);
    assert.equal(f.state.writes, failure === 'revoked' ? 0 : 1, failure);
    if (failure !== 'revoked')
      await assert.rejects(f.journal.pauseEffects(), /EXTERNAL_EFFECT_UNKNOWN/);
  }
});

test('repair intent is durable before mutation and late revocation prevents the effect',
  async t => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { digest } = await import('../src/identity.mjs');
    const { reconcilePause } = await import('../src/pause-repair.mjs');
    for (const revoke of [false, true]) {
      const f = await repairFixture(t);
      f.add(member);
      f.add(other, false);
      let admissions = 0;
      const result = await reconcilePause({ reader: f.reader, issue: identity,
        token: 'fixture-only', journal: f.journal,
        authorize: async () => {
          if (revoke && ++admissions === 3) throw new Error('Revoked before write');
          return { actorId: bot.id, approvalHash: 'a'.repeat(64) };
        },
        fetcher: async (...args) => {
          if (args[1].method === 'GET') return f.fetcher(...args);
          const directory = digest({ issueId: identity.id,
            repositoryId: identity.repositoryId });
          const record = JSON.parse(await readFile(
            join(f.root, directory, 'receipts.json'), 'utf8'));
          assert.match(record.payload.pending, /^[a-f0-9]{64}$/);
          return f.fetcher(...args);
        } });
      assert.equal(result.status, revoke ? 'unknown' : 'paused');
      assert.equal(f.state.writes, revoke ? 0 : 1);
      if (revoke) {
        assert.equal((await f.repair()).status, 'unknown');
        assert.equal(f.state.writes, 0);
      }
    }
  });

test('the actual repair credential must match the freshly authorized actor', async t => {
  const { reconcilePause } = await import('../src/pause-repair.mjs');
  const f = await repairFixture(t);
  f.add(member);
  f.add(other, false);
  const result = await reconcilePause({ reader: f.reader, issue: identity,
    token: 'fixture-only', journal: f.journal, fetcher: f.fetcher,
    authorize: async () => ({ actorId: owner.id, approvalHash: 'a'.repeat(64) }) });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'PAUSE_REPAIR_CREDENTIAL_CHANGED');
  assert.equal(f.state.writes, 0);
  await f.journal.assertIdle();
});

test('later qualification changes preserve an accepted pause', async t => {
  for (const change of ['unassigned', 'revoked', 'closed', 'delivered']) {
    const f = await repairFixture(t);
    assert.equal((await f.repair(additionEvent(f.issue, f.add(member)))).actorId,
      member.id);
    if (change === 'unassigned') f.issue.assignees = [];
    if (change === 'revoked') f.permissions.get(member.login).permission = 'read';
    if (change === 'closed') f.issue.state = 'closed';
    if (change === 'delivered') f.issue.labels.push({ name: 'delivered' });
    const removal = additionEvent(f.issue, f.add(other, false));
    const gap = await observePause(f.reader, identity, await f.journal.pauseEffects());
    assert.equal(gap.status, 'repair', change);
    assert.equal(gap.actorId, member.id, change);
    assert.throws(() => requirePauseClear(gap, identity, f.issue));
    const context = stageFixture();
    context.pause = gap;
    assert.equal(decideStage('shape', context, now).code, 'PAUSE_NOT_PROVEN_CLEAR');
    assert.equal((await f.repair(removal)).status, 'paused');
    assert.equal(f.state.writes, 1);
    f.add(owner, false);
    assert.equal((await f.repair()).status, 'clear');
  }
});

test('later native assignment events cannot turn a prior pause into removal repair',
  async () => {
    const f = pauseFixture();
    f.add(member);
    f.issue.assignees = [];
    f.events.push({ id: 2, event: 'unassigned', actor: owner, assignee: member });
    const result = await observe(f);
    assert.equal(result.status, 'unknown');
    assert.equal(result.actorId, member.id);
    assert.equal(result.desired, true);
  });

test('invalid addition is repaired from its own snapshot after assignment changes',
  async t => {
    const f = await repairFixture(t);
    const native = f.add(other);
    const event = additionEvent(f.issue, native);
    f.issue.assignees.push(other);
    assert.equal((await f.repair(event)).status, 'clear');
    assert.equal(f.state.writes, 1);
    assert.equal((await f.journal.pauseEffects())[0].rejectedEventId, native.id);
    f.permissions.delete(other.login);
    assert.equal((await f.repair(event)).status, 'clear');
    assert.equal(f.state.writes, 1);
  });

test('an earlier rejected snapshot cannot authorize removal of a later pause',
  async t => {
  const f = await repairFixture(t);
  const stale = additionEvent(f.issue, f.add(other));
  f.add(owner, false);
  f.issue.assignees.push(other);
  f.add(other);
  assert.equal((await f.repair(stale)).status, 'paused');
  assert.equal(f.state.writes, 0);
  });


test('revocation without an Issue event or timestamp change cannot authorize Resume',
  async t => {
    const f = await repairFixture(t);
    const event = f.add(member);
    const originalAddition = additionEvent(f.issue, event);
    f.issue.updated_at = event.created_at;
    const original = structuredClone(f.events);
    assert.equal((await f.repair(originalAddition)).status, 'paused');
    f.permissions.get(member.login).permission = 'read';
    const revoked = await f.repair(originalAddition);
    assert.equal(revoked.status, 'paused');
    assert.equal(revoked.actorId, member.id);
    assert.equal(revoked.desired, true);
    assert.throws(() => requirePauseClear(revoked, identity, f.issue));
    assert.equal((await f.repair(originalAddition)).status, 'paused');
    assert.equal(f.state.writes, 0);
    assert.deepEqual(f.events, original);
    const revokedRemoval = additionEvent(f.issue, f.add(member, false));
    assert.equal((await f.repair(revokedRemoval)).status, 'paused');
    assert.equal(f.state.writes, 1);
    f.add(owner, false);
    const resumed = await f.repair();
    assert.equal(resumed.status, 'clear');
    requirePauseClear(resumed, identity, f.issue);
  });


test('immutable Bot identity permits rejecting an invalid addition', async t => {
  const f = await repairFixture(t);
  f.add(bot);
  const result = await f.repair();
  assert.equal(result.status, 'clear');
  assert.equal(f.state.writes, 1);
});
