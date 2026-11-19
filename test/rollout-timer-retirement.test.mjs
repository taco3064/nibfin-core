import test from 'node:test';
import assert from 'node:assert/strict';
import { retireRolloutTimer, legacyRolloutUnits }
  from '../src/rollout-timer-retirement.mjs';
import { requireNoLegacyRolloutConsumer } from '../src/legacy-rollout-consumer.mjs';

function ports() {
  const events = [];
  const units = new Map([...legacyRolloutUnits.keys()].map(name => [name, false]));
  const resources = new Set(legacyRolloutUnits.keys());
  const state = { ownerPaused: true, plan: { unrelated: true } };
  return { events, units, files: resources, state,
    ready: async () => {}, resources: async () => {},
    stopped: async name => units.get(name),
    safeToStop: async () => {},
    stop: async name => { events.push(`stop:${name}`); units.set(name, true); },
    removable: async () => [...resources],
    remove: async name => { events.push(`remove:${name}`); resources.delete(name); },
    reload: async () => events.push('reload'), retained: async () => [],
  };
}

test('retires scheduler before worker and preserves unrelated recovery', async () => {
  const fixture = ports();
  assert.equal((await retireRolloutTimer(fixture)).status, 'retired');
  assert.deepEqual(fixture.events.slice(0, 2),
    ['stop:nibfin-rollout.timer', 'stop:nibfin-rollout.service']);
  assert.deepEqual(fixture.state, { ownerPaused: true, plan: { unrelated: true } });
  fixture.events.length = 0;
  assert.equal((await retireRolloutTimer(fixture)).status, 'retired');
  assert.deepEqual(fixture.events, [], 'confirmed retirement repeats no writes');
});

test('a lost stop response is read back instead of stopping again', async () => {
  const fixture = ports();
  const stop = fixture.stop;
  fixture.stop = async name => { await stop(name); throw new Error('response lost'); };
  assert.equal((await retireRolloutTimer(fixture)).status, 'retired');
  assert.equal(fixture.events.filter(event => event.startsWith('stop:')).length, 2);
});

test('a foreign unit or failed observation never authorizes deletion', async () => {
  const fixture = ports();
  fixture.resources = async () => {
    throw Object.assign(new Error('unknown'), { code: 'CORE_ROLLOUT_UNIT_UNKNOWN' });
  };
  assert.equal((await retireRolloutTimer(fixture)).code, 'CORE_ROLLOUT_UNIT_UNKNOWN');
  assert.deepEqual(fixture.events, []);
});

test('active unknown program is retained without stopping unrelated work', async () => {
  const fixture = ports();
  fixture.safeToStop = async name => {
    if (name.endsWith('.service')) throw Object.assign(new Error('unknown'),
      { code: 'CORE_ROLLOUT_ACTIVE_PROGRAM_UNKNOWN' });
  };
  const result = await retireRolloutTimer(fixture);
  assert.equal(result.code, 'CORE_ROLLOUT_ACTIVE_PROGRAM_UNKNOWN');
  assert.deepEqual(fixture.events, ['stop:nibfin-rollout.timer']);
});

function consumers(changes = {}) {
  const timer = { ActiveState: 'inactive', UnitFileState: 'disabled',
    LoadState: 'loaded' };
  const service = { ActiveState: 'inactive', UnitFileState: 'static',
    LoadState: 'loaded', MainPID: '0', ControlGroup: '',
    TriggeredBy: 'nibfin-rollout.timer' };
  Object.assign(timer, changes.timer);
  Object.assign(service, changes.service);
  return async name => name.endsWith('.timer') ? timer : service;
}

test('credential use observes actual consumers; an unused old file is irrelevant',
  async () => {
    await requireNoLegacyRolloutConsumer(consumers());
    await requireNoLegacyRolloutConsumer(async () => ({ ActiveState: 'inactive',
      UnitFileState: '', LoadState: 'not-found' }));
    for (const changes of [
      { timer: { ActiveState: 'active' } },
      { timer: { UnitFileState: 'enabled' } },
      { service: { ActiveState: 'active' } },
      { service: { UnitFileState: 'enabled-runtime' } },
      { service: { MainPID: '123' } },
      { service: { ControlGroup: '/old-consumer' } },
    ]) await assert.rejects(requireNoLegacyRolloutConsumer(consumers(changes)),
      { code: 'MANAGED_CREDENTIAL_LEGACY_CONSUMER_PENDING' });
    await assert.rejects(requireNoLegacyRolloutConsumer(consumers({ service: {
      TriggeredBy: 'another.timer' } })),
    { code: 'MANAGED_CREDENTIAL_LEGACY_CONSUMER_OTHER_TRIGGER' });
    await assert.rejects(requireNoLegacyRolloutConsumer(async () => {
      throw new Error('native observation unavailable');
    }), /native observation unavailable/);
  });
