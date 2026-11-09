import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { acquireHostFence, waitForHostFence } from '../src/host-fence.mjs';

test('waiting runner only enters after the live holder releases the fence',
  { skip: process.platform !== 'linux' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-fence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = await acquireHostFence(root, { job: 1 });
    const path = join(root, 'stage.lock');
    const original = await readFile(path, 'utf8');
    const second = waitForHostFence(root, { job: 2 }, 5000, 10);
    await setTimeout(50);
    assert.equal(await readFile(path, 'utf8'), original);
    await first.release();
    await (await second).release();
  });

test('unresolved fence is preserved when no live holder can be confirmed',
  { skip: process.platform !== 'linux' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-fence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'stage.lock');
    const original = JSON.stringify({ pid: 2147483647 });
    await writeFile(path, original, { mode: 0o600 });
    await assert.rejects(waitForHostFence(root, { job: 2 }, 5000, 10),
      { code: 'HOST_EXECUTION_UNRESOLVED' });
    assert.equal(await readFile(path, 'utf8'), original);
  });
