import test from 'node:test';
import assert from 'node:assert/strict';
import { ownContainerProcesses } from '../src/container-pressure.mjs';

const id = 'a'.repeat(64);

test('Docker host PIDs require exact live container and cgroup ownership', async () => {
  for (const cgroup of [`0::/docker/${id}\n`,
    `0::/system.slice/docker-${id}.scope\n`, '0::/docker/foreign\n']) {
    const captured = [];
    const inspect = async args => args[0] === 'inspect'
      ? [{ Id: id, State: { Running: true } }]
      : { Titles: ['PID'], Processes: [['123'], ['unsafe']] };
    await ownContainerProcesses({ own: async (...args) => captured.push(args) },
      inspect, id, { identity: async () => ({ pid: 123, startTicks: '100' }),
        read: async () => cgroup });
    assert.deepEqual(captured, cgroup.includes(id) ? [[123, '100']] : []);
  }
});

test('foreign or stopped inspection never supplies process ownership', async () => {
  for (const container of [{ Id: 'b'.repeat(64), State: { Running: true } },
    { Id: id, State: { Running: false } }]) {
    await ownContainerProcesses({ own: () => assert.fail('Foreign process') },
      async () => [container], id);
  }
});
