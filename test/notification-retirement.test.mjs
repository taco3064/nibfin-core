import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { retireNotificationResources } from '../src/notification-retirement.mjs';
import { consumerContract } from '../src/public-api.mjs';

function fixture() {
  const files = new Set(['timer', 'service', 'configuration']);
  const stopped = new Set(), calls = [];
  const state = { activeConsumer: false, unowned: false, lost: null,
    unknownStop: false, changed: false, paused: true, unknownEffect: true };
  const fail = code => { throw Object.assign(new Error(), { code }); };
  const ports = {
    units: ['timer', 'service'],
    inspect: async () => { if (state.changed) fail('HOST_ADOPTION_CHANGED'); },
    consumers: async () => {
      if (state.activeConsumer) fail('NOTIFICATION_ARTIFACT_CONSUMER_ACTIVE');
    },
    resources: async () => {
      if (state.unowned) fail('NOTIFICATION_RESOURCE_NOT_OWNED');
    },
    stopped: async unit => !state.unknownStop && stopped.has(unit),
    stop: async unit => {
      calls.push(`stop:${unit}`);
      stopped.add(unit);
      if (state.lost === `stop:${unit}`) throw new Error('response lost');
    },
    removable: async () => [...files],
    remove: async name => {
      calls.push(`remove:${name}`);
      files.delete(name);
      if (state.lost === `remove:${name}`) throw new Error('response lost');
    },
    reload: async () => { calls.push('reload'); },
    pruneJournal: async () => ['control.json', 'origin-1-2-1.json'],
  };
  return { state, ports, calls, files, stopped,
    run: () => retireNotificationResources(ports) };
}

test('cleanup stops scheduler first and keeps recovery evidence', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'retired');
  assert.deepEqual(f.calls.slice(0, 2), ['stop:timer', 'stop:service']);
  assert.deepEqual(result.retained, ['control.json', 'origin-1-2-1.json']);
  assert(f.state.paused && f.state.unknownEffect);
  assert.equal(f.files.size, 0);
  const firstCalls = [...f.calls];
  assert.equal((await f.run()).status, 'retired');
  assert.deepEqual(f.calls.slice(firstCalls.length), ['reload']);
});

test('unknown stop result retains every file and re-enters normal checks', async () => {
  const f = fixture();
  f.state.unknownStop = true;
  assert.equal((await f.run()).code, 'NOTIFICATION_STOP_UNCONFIRMED');
  assert.equal(f.files.size, 3);
  f.state.unknownStop = false;
  assert.equal((await f.run()).status, 'retired');
  assert.equal(f.calls.filter(call => call === 'stop:timer').length, 1);
});

test('lost stop response reuses the confirmed systemd result', async () => {
  const f = fixture();
  f.state.lost = 'stop:timer';
  assert.equal((await f.run()).status, 'retired');
  assert.equal(f.calls.filter(call => call === 'stop:timer').length, 1);
});

test('lost unlink response reuses confirmed absence', async () => {
  const f = fixture();
  f.state.lost = 'remove:configuration';
  assert.equal((await f.run()).status, 'pending');
  f.state.lost = null;
  assert.equal((await f.run()).status, 'retired');
  assert.equal(f.calls.filter(call => call === 'remove:configuration').length, 1);
});

for (const [property, code] of [
  ['activeConsumer', 'NOTIFICATION_ARTIFACT_CONSUMER_ACTIVE'],
  ['unowned', 'NOTIFICATION_RESOURCE_NOT_OWNED'],
  ['changed', 'HOST_ADOPTION_CHANGED'],
]) test(`${property} retains resources without stopping unrelated services`, async () => {
  const f = fixture();
  f.state[property] = true;
  assert.equal((await f.run()).code, code);
  assert.equal(f.files.size, 3);
  assert.deepEqual(f.calls, []);
});

test('public capability rejects arguments and candidate host execution', () => {
  const capability = consumerContract.notificationRelayRetirement;
  assert.equal(capability.command, 'retire-notification-relay');
  assert.deepEqual(capability.exitStatuses,
    { retired: 0, pending: 2, denied: 1 });
  const invoke = args => spawnSync(process.execPath,
    ['bin/nibfin-core.mjs', capability.command, ...args], { encoding: 'utf8' });
  const argument = invoke(['untrusted-path']);
  assert.equal(argument.status, 1);
  assert.equal(JSON.parse(argument.stderr).code, 'INVALID_COMMAND');
  const candidate = invoke([]);
  assert.equal(candidate.status, 1);
  assert.equal(JSON.parse(candidate.stderr).code,
    'NOTIFICATION_REQUIRES_INSTALLED_ADMINISTRATOR');
});
