import test from 'node:test';
import assert from 'node:assert/strict';
import { retireManagedPool, requireRetiredReplacement }
  from '../src/managed-retirement.mjs';

const binding = () => ({ pool: { repository: 'owner/execution', repositoryId: 5,
  memberId: 4, runners: [{ id: 10, name: 'slot-1' }, { id: 11, name: 'slot-2' }] },
provider: 'codex', slots: [1, 2], repositories: [5, 6] });

function fixture() {
  let state;
  const observed = new Set();
  const writes = [], effects = [];
  const controls = { busy: false, native: ['present', 'present'], closed: false,
    unknown: null, failAfter: null, failBefore: null, changed: false };
  const ports = {
    read: async () => structuredClone(state),
    write: async value => { state = structuredClone(value); writes.push(state); },
    inspectBinding: async () => {
      if (controls.changed) throw Object.assign(new Error(),
        { code: 'RETIREMENT_ADOPTION_CHANGED' });
    },
    observeEffect: async name => controls.unknown === name ? 'unknown' :
      observed.has(name) ? 'done' : 'absent',
    performEffect: async name => {
      effects.push(name);
      if (controls.failBefore === name) throw new Error('before effect');
      observed.add(name);
      if (name === 'close-admission') controls.closed = true;
      if (controls.failAfter === name) throw new Error('after effect');
    },
    assertClosed: async () => { assert(controls.closed); },
    settle: async () => {
      if (controls.busy) throw Object.assign(new Error(),
        { code: 'RETIREMENT_CONSUMER_PENDING' });
    },
    registrations: async () => controls.native,
    cleanupEffects: ['slot-1', 'slot-2'],
  };
  return { ports, controls, observed, writes, effects,
    run: () => retireManagedPool(binding(), ports),
    state: () => structuredClone(state) };
}

test('native pool retirement has no obsolete relay effect prerequisite', async () => {
  const f = fixture();
  f.ports.drainEffects = ['close-admission'];
  f.controls.unknown = 'relay-pause';
  const removal = await f.run();
  assert.equal(removal.removal.permitted, true);
  assert.deepEqual(f.effects, ['close-admission']);
  f.controls.native = ['absent', 'absent'];
  assert.equal((await f.run()).status, 'retired');
  assert(!f.effects.includes('relay-pause'));
});

test('two slots hand off matched IDs, observe absence and retire once', async () => {
  const f = fixture();
  const removal = await f.run();
  assert.equal(removal.phase, 'removal');
  assert.equal(removal.removal.permitted, true);
  assert.deepEqual(removal.removal.runners, binding().pool.runners);
  assert.deepEqual(f.effects, ['close-admission', 'relay-pause']);
  assert(f.writes.find(s => s.effects['close-admission'] === 'intent'));
  f.controls.native = ['absent', 'absent'];
  const retired = await f.run();
  assert.equal(retired.status, 'retired');
  assert.equal(retired.retirementId, removal.retirementId);
  assert.equal(retired.removal.permitted, false);
  assert.deepEqual(f.effects.slice(2), ['slot-1', 'slot-2']);
  assert.deepEqual(await f.run(), retired);
  assert.equal(f.effects.length, 4);
});

test('active work retains a closed boundary and the same Pending operation', async () => {
  const f = fixture();
  f.controls.busy = true;
  const first = await f.run();
  const second = await f.run();
  assert.equal(second.retirementId, first.retirementId);
  assert.equal(second.phase, 'settling');
  assert.equal(second.code, 'RETIREMENT_CONSUMER_PENDING');
  assert.equal(second.removal.permitted, false);
  assert.equal(f.controls.closed, true);
  assert.equal(f.effects.length, 2);
});

test('partial native removal cannot authorize either slot cleanup', async () => {
  const f = fixture();
  await f.run();
  f.controls.native = ['absent', 'present'];
  assert.equal((await f.run()).phase, 'removal');
  assert.equal(f.effects.length, 2);
  f.controls.native = ['absent', 'unknown'];
  const unknown = await f.run();
  assert.equal(unknown.code, 'RETIREMENT_NATIVE_UNKNOWN');
  assert.equal(unknown.removal.permitted, false);
  assert.equal(f.effects.length, 2);
});

test('crash after an effect reconciles readback without a duplicate write', async () => {
  const f = fixture();
  f.controls.failAfter = 'close-admission';
  assert.equal((await f.run()).phase, 'removal');
  assert.equal(f.effects.filter(x => x === 'close-admission').length, 1);
  f.controls.native = ['absent', 'absent'];
  f.controls.failAfter = 'slot-1';
  assert.equal((await f.run()).status, 'retired');
  assert.equal(f.effects.filter(x => x === 'slot-1').length, 1);
});

test('unobserved write stays Pending and is never automatically repeated', async () => {
  const f = fixture();
  f.controls.failBefore = 'relay-pause';
  const first = await f.run();
  assert.equal(first.code, 'DRAIN_EFFECT_UNKNOWN');
  assert.equal(f.controls.closed, true);
  assert.equal(f.state().effects['relay-pause'], 'intent');
  assert.equal((await f.run()).code, 'DRAIN_EFFECT_UNKNOWN');
  assert.equal(f.effects.filter(x => x === 'relay-pause').length, 1);
  f.observed.add('relay-pause');
  assert.equal((await f.run()).phase, 'removal');
});

test('only explicitly retryable, observed incomplete effects may retry', async () => {
  const f = fixture();
  f.ports.retryableEffects = ['relay-pause'];
  f.controls.failBefore = 'relay-pause';
  await f.run();
  f.controls.failBefore = null;
  f.controls.unknown = 'relay-pause';
  await f.run();
  assert.equal(f.effects.filter(x => x === 'relay-pause').length, 1);
  f.controls.unknown = null;
  assert.equal((await f.run()).phase, 'removal');
  assert.equal(f.effects.filter(x => x === 'relay-pause').length, 2);
});

test('changed adoption and changed identity cannot authorize cleanup', async () => {
  const f = fixture();
  await f.run();
  f.controls.changed = true;
  assert.equal((await f.run()).code, 'RETIREMENT_ADOPTION_CHANGED');
  await assert.rejects(retireManagedPool({ ...binding(), provider: 'claude' }, f.ports),
    { code: 'RETIREMENT_IDENTITY_CHANGED' });
  assert.equal(f.effects.length, 2);
});

test('release needs retirement and fresh IDs independently of replacement', async () => {
  const f = fixture();
  const next = binding().pool;
  next.runners = [{ id: 12, name: 'slot-1' }, { id: 13, name: 'slot-2' }];
  await f.run();
  assert.throws(() => requireRetiredReplacement(f.state(), next),
    { code: 'RETIREMENT_RELEASE_REQUIRED' });
  f.controls.native = ['absent', 'absent'];
  assert.equal((await f.run()).status, 'retired');
  assert.doesNotThrow(() => requireRetiredReplacement(f.state(), next));
  assert.throws(() => requireRetiredReplacement(f.state(), binding().pool),
    { code: 'RETIREMENT_RELEASE_REQUIRED' });
  assert.equal((await f.run()).status, 'retired');
});
