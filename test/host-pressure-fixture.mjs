import { hostMemoryPressure } from '../src/host-memory-pressure.mjs';

export function pressureFixture(binding = {}) {
  return { schemaVersion: 1, code: hostMemoryPressure,
    binding: { stage: 'shape', runnerId: 26,
      executionId: '00000000-0000-4000-8000-000000000001',
      runId: 20, attempt: 1, jobId: 30, ...binding },
    bootId: '00000000-0000-4000-8000-000000000002',
    startedAt: 10.01, observedAt: 11, endedAt: 12, victimPid: 123,
    startTicks: '100', sequence: 8 };
}

export function oomRecord({ pid = 123, sequence = 8, time = 11,
  priority = 3, constraint = 'CONSTRAINT_NONE', scope = 'global_oom' } = {}) {
  return `${priority},${sequence},${time * 1e6},-;oom-kill:` +
    `constraint=${constraint},nodemask=(null),cpuset=/,mems_allowed=0,` +
    `${scope},task_memcg=/docker/owned,task=worker,pid=${pid},uid=1000\n`;
}
