import test from 'node:test';
import assert from 'node:assert/strict';
import { runJobVmWriter } from '../src/job-vm-writer.mjs';
import { hostMemoryPressure } from '../src/host-memory-pressure.mjs';
import { writerInitializeTimeout } from '../src/job-vm-pressure.mjs';
import { pressureFixture } from './host-pressure-fixture.mjs';

async function run({ observed = true, retired = true, failure = 'JOB_VM_EXIT_FAILED',
  completed = false, returned } = {}) {
  const memoryPressure = pressureFixture({ stage: 'deliver' });
  const calls = [];
  const result = await runJobVmWriter({}, {
    executionId: memoryPressure.binding.executionId,
    pressureBinding: memoryPressure.binding,
  }, () => assert.fail('Controlled VM owns this invocation'), {
    capacity: async () => { calls.push('capacity');
      return async () => { calls.push('released'); }; },
    observe: async binding => {
      assert.deepEqual(binding, memoryPressure.binding);
      calls.push('observe');
      return { own: async (pid, ticks) => {
        assert.equal(pid, 123);
        assert.equal(ticks, '100');
        calls.push('owned');
      }, finish: async () => {
        calls.push('finish');
        return observed ? memoryPressure : undefined;
      } };
    },
    runVm: async (_config, lifecycle) => {
      assert.deepEqual(calls, ['capacity', 'observe']);
      await lifecycle.onProcess({ pid: 123, startTicks: '100' });
      if (retired) { calls.push('retired'); await lifecycle.onRetired(); }
      if (returned) return { result: returned };
      if (completed) return { result: { status: 'completed' } };
      throw Object.assign(new Error(failure), { code: failure });
    },
  });
  return { result, calls, memoryPressure };
}

test('retired post-admission VM pressure carries original execution evidence',
  async () => {
  const { result, calls, memoryPressure } = await run();
  assert.equal(result.status, 'interrupted');
  assert.equal(result.code, hostMemoryPressure);
  assert.deepEqual(result.memoryPressure, memoryPressure);
  assert.equal(result.executionId, memoryPressure.binding.executionId);
  assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls, ['capacity', 'observe', 'owned', 'retired', 'finish',
    'released']);
});

test('unproven VM retirement cannot use a pressure observation', async () => {
  await assert.rejects(run({ retired: false }), { code: 'JOB_VM_EXIT_FAILED' });
  await assert.rejects(run({ observed: false }), { code: 'JOB_VM_EXIT_FAILED' });
});

test('VM initialization timeout compatibility remains a distinct transient case',
  async () => {
  const { result } = await run({ observed: false, failure: writerInitializeTimeout });
  assert.equal(result.code, writerInitializeTimeout);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.memoryPressure, undefined);
});

test('successful VM work is not replaced by a pressure observation', async () => {
  const { result } = await run({ completed: true });
  assert.equal(result.status, 'completed');
});

test('retired VM cannot turn unknown container termination into a retry', async () => {
  for (const returned of [
    { status: 'pending', code: 'WRITER_TERMINATION_UNKNOWN' },
    { status: 'denied', code: 'AGENT_EXECUTION_UNVERIFIED' },
    { status: 'interrupted', code: 'PROCESS_FAILED' },
  ]) {
    const { result } = await run({ returned });
    assert.deepEqual(result, returned);
    assert.equal(result.memoryPressure, undefined);
  }
  const returned = { status: 'interrupted', code: 'PROCESS_FAILED',
    terminationHash: 'b'.repeat(64) };
  const { result } = await run({ returned });
  assert.equal(result.code, hostMemoryPressure);
  assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
});
