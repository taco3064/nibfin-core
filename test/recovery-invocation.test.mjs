import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRecoveryInvocation } from '../src/recovery-invocation.mjs';
import { proveDeliverProcesses } from '../src/deliver-recovery-processes.mjs';
import { controllerRelayArguments, controllerRelayProgram }
  from '../src/controller-contract.mjs';

const installation = '/opt/nibfin/core';
function fixture() {
  const transport = { pid: 900002, parent: 1, startTicks: '12', state: 'S',
    command: [controllerRelayProgram, ...controllerRelayArguments(process.getuid())] };
  const controller = { pid: process.pid, parent: transport.pid,
    startTicks: '13', state: 'S',
    command: [process.execPath, `${installation}/bin/nibfin-controller.mjs`] };
  const processes = [transport, controller];
  const census = async () => structuredClone(processes);
  return { processes, transport, controller, census };
}

test('authenticated current Controller and exact transport ancestor can remain live',
  async () => {
    const f = fixture();
    const currentInvocation = await observeRecoveryInvocation(installation, 2, f);
    assert.equal(currentInvocation.members.length, 2);
    assert.match(await proveDeliverProcesses({ pid: 900001 },
      { census: f.census, installation, currentInvocation }), /^[a-f0-9]{64}$/);
  });

for (const [name, change] of [
  ['arbitrary descendant', f => f.processes.push({ pid: 900003,
    parent: f.controller.pid, startTicks: '14', state: 'S', command: ['helper'] })],
  ['another continuation', f => f.processes.push({ pid: 900003,
    parent: f.transport.pid, startTicks: '14', state: 'S',
    command: [process.execPath, `${installation}/bin/nibfin-core.mjs`,
      'stage', '2', 'continue'] })],
  ['reparented helper', f => f.processes.push({ pid: 900003, parent: 1,
    startTicks: '14', state: 'S', command: ['helper'] })],
]) test(`current invocation does not exempt ${name}`, async () => {
  const f = fixture();
  const currentInvocation = await observeRecoveryInvocation(installation, 2, f);
  change(f);
  await assert.rejects(proveDeliverProcesses({ pid: 900001 },
    { census: f.census, installation, currentInvocation }),
  { code: 'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED' });
});

for (const [name, change] of [
  ['reused transport PID', f => { f.transport.startTicks = '99'; }],
  ['reparented controller', f => { f.controller.parent = 1; }],
  ['changed command', f => { f.transport.command.push('extra'); }],
  ['disappeared transport', f => { f.processes.shift(); }],
]) test(`consequential revalidation rejects ${name}`, async () => {
  const f = fixture();
  const currentInvocation = await observeRecoveryInvocation(installation, 2, f);
  let reads = 0;
  const census = async () => {
    if (++reads === 2) change(f);
    return f.census();
  };
  await assert.rejects(proveDeliverProcesses({ pid: 900001 },
    { census, installation, currentInvocation }),
  { code: 'RECOVERY_INVOCATION_CHANGED' });
});

test('similarly named commands and wrong direct Issue cannot identify the invocation',
  async () => {
    const f = fixture();
    for (const command of [
      [process.execPath, '/other/bin/nibfin-controller.mjs'],
      [process.execPath, `${installation}/bin/nibfin-core.mjs`,
        'stage', '3', 'continue'],
      [process.execPath, `${installation}/bin/nibfin-core.mjs`,
        'stage', '2', 'deliver'],
    ]) {
      f.controller.command = command;
      await assert.rejects(observeRecoveryInvocation(installation, 2, f),
        { code: 'RECOVERY_INVOCATION_UNAVAILABLE' });
    }
  });

test('exact authenticated direct continuation is recognized without descendants',
  async () => {
    const f = fixture();
    f.processes.shift();
    f.controller.parent = 1;
    f.controller.command = [process.execPath, `${installation}/bin/nibfin-core.mjs`,
      'stage', '2', 'continue'];
    const invocation = await observeRecoveryInvocation(installation, 2, f);
    assert.deepEqual(invocation.members.map(item => item.pid), [process.pid]);
  });
