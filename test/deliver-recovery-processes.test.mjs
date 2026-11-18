import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parseRecoveryProcess, recoveryProcessCensus, proveDeliverProcesses }
  from '../src/deliver-recovery-processes.mjs';

test('strict Linux identities support names containing spaces and parentheses',
  async () => {
    const current = parseRecoveryProcess(process.pid,
      await readFile(`/proc/${process.pid}/stat`, 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.match(current.startTicks, /^[1-9][0-9]*$/);
    assert.throws(() => parseRecoveryProcess(process.pid, 'unreadable'),
      { code: 'RECOVERY_PROCESS_IDENTITY_UNAVAILABLE' });
  });

test('Linux census sees a synthetic detached helper and its actual disappearance',
  async t => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    const closed = once(child, 'close');
    t.after(async () => { child.kill('SIGKILL'); await closed; });
    await once(child, 'spawn');
    const census = await recoveryProcessCensus(child.pid);
    assert.equal(census.some(item => item.pid === child.pid), true);
    await assert.rejects(proveDeliverProcesses({ pid: child.pid },
      { census: async () => census }), { code: 'RECOVERY_CONTROLLER_UNRESOLVED' });
    await assert.rejects(proveDeliverProcesses({ pid: 900001 },
      { census: async () => census.filter(item => item.pid === child.pid) }),
    { code: 'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED' });
    child.kill('SIGKILL');
    await closed;
    assert.equal((await recoveryProcessCensus(child.pid))
      .some(item => item.pid === child.pid), false);
  });
