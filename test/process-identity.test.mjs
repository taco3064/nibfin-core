import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processIdentity, processIdentityNow } from '../src/host-memory-pressure.mjs';

test('self identity works when the mounted proc view uses another PID namespace',
  { skip: process.platform !== 'linux' }, async () => {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const expected = { pid: process.pid, startTicks };
    assert.deepEqual(processIdentityNow(process.pid), expected);
    assert.deepEqual(await processIdentity(process.pid), expected);
    assert.equal(processIdentityNow(0), null);
    assert.equal(await processIdentity(0), null);
  });
