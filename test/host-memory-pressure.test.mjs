import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import {
  observeHostPressure, confirmedHostPressure, pressureMatchesReceipt,
  processIdentity, processIdentityNow,
} from '../src/host-memory-pressure.mjs';
import { pressureFixture, oomRecord } from './host-pressure-fixture.mjs';

async function fixture(options = {}) {
  const queue = [];
  let closed = false, now = 10, live = { pid: 123, startTicks: '100' };
  const monitor = await observeHostPressure(pressureFixture().binding, {
    interval: 1_000_000, clock: async () => now,
    boot: async () => pressureFixture().bootId,
    identity: async () => live,
    reader: async () => ({ read: async () => queue.splice(0),
      close: async () => { closed = true; } }),
    ...options,
  });
  await monitor.own(123);
  return { monitor, queue, closed: () => closed,
    clock: value => { now = value; }, identity: value => { live = value; } };
}

test('global kernel OOM correlates only to a captured live process', async () => {
  const f = await fixture();
  f.queue.push(oomRecord());
  f.clock(12);
  const result = await f.monitor.finish();
  assert.deepEqual(result, pressureFixture());
  assert.ok(f.closed());
  assert.equal(JSON.stringify(result).includes('task_memcg'), false);
  assert.equal(confirmedHostPressure(result), true);
});

test('foreign, stale, limited and non-kernel records cannot confirm', async () => {
  for (const fields of [
    { pid: 124 }, { time: 9 }, { time: 13 }, { priority: 11 },
    { scope: 'oom_memcg=/docker/owned' }, { constraint: 'CONSTRAINT_MEMCG' },
  ]) {
    const f = await fixture();
    f.queue.push(oomRecord(fields));
    f.clock(12);
    assert.equal(await f.monitor.finish(), undefined);
    assert.ok(f.closed());
  }
});

test('PID reuse and a victim already gone cannot establish ownership', async () => {
  for (const live of [null, { pid: 123, startTicks: '101' }]) {
    const f = await fixture();
    f.identity(live);
    f.queue.push(oomRecord());
    f.clock(12);
    assert.equal(await f.monitor.finish(), undefined);
  }
});

test('repeat ownership sampling retains the original capture interval', async () => {
  const f = await fixture();
  f.clock(12);
  await f.monitor.own(123, '100');
  f.queue.push(oomRecord());
  assert.deepEqual(await f.monitor.finish(), pressureFixture());
});

test('guard-owned identity excludes a PID replaced before capture', async () => {
  const f = await fixture();
  f.identity({ pid: 456, startTicks: '101' });
  await f.monitor.own(456, '100');
  f.clock(12);
  f.queue.push(oomRecord({ pid: 456 }));
  assert.equal(await f.monitor.finish(), undefined);
});

test('unreadable, missed or unsupported telemetry stays unconfirmed', async () => {
  for (const reader of [
    async () => { throw new Error('EACCES'); },
    async () => ({ read: async () => { throw new Error('EPIPE'); }, close() {} }),
    async () => ({ read: async () => ['unsupported'], close() {} }),
  ]) {
    const f = await fixture({ reader });
    assert.equal(await f.monitor.finish(), undefined);
  }
  const f = await fixture();
  f.clock(12);
  f.queue.push(oomRecord(), oomRecord({ sequence: 10 }));
  assert.equal(await f.monitor.finish(), undefined);
});

test('records predating monitor startup are discarded', async () => {
  let reads = 0;
  const f = await fixture({ reader: async () => ({
    read: async () => ++reads === 1 ? [oomRecord({ time: 9 })] : [], close() {},
  }) });
  f.clock(12);
  assert.equal(await f.monitor.finish(), undefined);
});

test('background collection observes before the victim exits and retires its reader',
  async () => {
    const f = await fixture({ interval: 1 });
    f.clock(12);
    f.queue.push(oomRecord());
    await setTimeout(30);
    f.identity(null);
    assert.deepEqual(await f.monitor.finish(), pressureFixture());
    assert.ok(f.closed());
  });

test('binding and interval validation reject foreign retained evidence', () => {
  const proof = pressureFixture();
  const execution = { id: proof.binding.executionId, runId: 20, attempt: 1, jobId: 30 };
  assert.equal(pressureMatchesReceipt(proof, 'shape', execution), true);
  for (const patch of [{ id: 'foreign' }, { runId: 21 }, { attempt: 2 }, { jobId: 31 }])
    assert.equal(pressureMatchesReceipt(proof, 'shape', { ...execution, ...patch }),
      false);
  assert.equal(pressureMatchesReceipt(proof, 'accept', execution), false);
  for (const patch of [{ observedAt: 9 }, { endedAt: 10 }, { bootId: '' },
    { victimPid: 0 }, { startTicks: '' }, { sequence: -1 }])
    assert.equal(confirmedHostPressure({ ...proof, ...patch }), false);
});

test('native proc readers capture the same live process start identity', async () => {
  const identity = await processIdentity(process.pid);
  assert.deepEqual(processIdentityNow(process.pid), identity);
  assert.ok(identity.startTicks);
  assert.equal(await processIdentity(-1), null);
});

test('exit-like and aggregate kernel messages do not prove global OOM ownership',
  async () => {
    for (const message of ['Out of memory: Killed process 123 (worker)',
      'Memory cgroup out of memory: Killed process 123', 'exit 137',
      'oom_kill 1', 'full avg10=5.00', 'Agent says host OOM']) {
      const f = await fixture();
      f.clock(12);
      f.queue.push(`3,8,11000000,-;${message}\n`);
      assert.equal(await f.monitor.finish(), undefined);
    }
  });
