import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireHostFence, issueStatePath } from '../src/host-fence.mjs';

test('a recovery record on one Issue does not delay an unrelated Issue',
  { skip: process.platform !== 'linux' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-fence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const left = issueStatePath(root, { repositoryId: 10, number: 1 });
    const right = issueStatePath(root, { repositoryId: 10, number: 2 });
    await mkdir(left, { mode: 0o700 });
    await mkdir(right, { mode: 0o700 });
    const first = await acquireHostFence(left, { job: 1 });
    const second = await acquireHostFence(right, { job: 2 });
    await assert.rejects(acquireHostFence(left, { job: 3 }),
      { code: 'HOST_EXECUTION_UNRESOLVED' });
    await first.release();
    await second.release();
  });

test('unresolved fence is preserved when no live holder can be confirmed',
  { skip: process.platform !== 'linux' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-fence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'stage.lock');
    const original = JSON.stringify({ pid: 2147483647 });
    await writeFile(path, original, { mode: 0o600 });
    await assert.rejects(acquireHostFence(root, { job: 2 }),
      { code: 'HOST_EXECUTION_UNRESOLVED' });
    assert.equal(await readFile(path, 'utf8'), original);
  });
