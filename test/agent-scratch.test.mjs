import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, rmdir, writeFile, readFile, lstat, link, symlink, rm,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  prepareWriterTemporaryDirectory, writerTemporaryDirectory,
} from '../src/agent-scratch.mjs';
import { snapshotJobVmWorkspace } from '../src/job-vm-workspace.mjs';
import { shareAgentMount } from '../src/agent-mounts.mjs';

async function fixture(t) {
  const prefix = fileURLToPath(new URL('../.agent-scratch-', import.meta.url));
  const root = await mkdtemp(prefix);
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work, { mode: 0o700 });
  return { root, work, temporary: join(work, writerTemporaryDirectory) };
}

test('preparation carries the temporary path through the file-only snapshot', async t => {
  const f = await fixture(t);
  await prepareWriterTemporaryDirectory(f.work);
  assert.equal((await lstat(f.temporary)).isDirectory(), true);
  assert.deepEqual(await snapshotJobVmWorkspace(f.work), [{
    path: writerTemporaryDirectory + '/.keep', executable: false, content: '',
  }]);
});

test('ordinary non-VM mount preparation keeps the path writable', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  await prepareWriterTemporaryDirectory(f.work);
  await shareAgentMount(f.work, true);
  assert.equal((await lstat(f.temporary)).mode & 0o777, 0o777);
  await writeFile(join(f.temporary, 'fixture'), 'ordinary writable mount');
});

test('an existing ordinary carrier is preserved across preparation', async t => {
  const f = await fixture(t);
  await prepareWriterTemporaryDirectory(f.work);
  const marker = join(f.temporary, '.keep');
  await writeFile(marker, 'existing marker');
  const before = await lstat(marker);
  await prepareWriterTemporaryDirectory(f.work);
  assert.equal((await lstat(marker)).ino, before.ino);
  assert.equal(await readFile(marker, 'utf8'), 'existing marker');
});

test('regular files cannot replace either temporary-path directory', async t => {
  for (const nested of [false, true]) {
    const f = await fixture(t);
    if (nested) await mkdir(join(f.work, '.nibfin-cache'));
    const path = nested ? f.temporary : join(f.work, '.nibfin-cache');
    await writeFile(path, 'preserve');
    await assert.rejects(prepareWriterTemporaryDirectory(f.work));
    assert.equal(await readFile(path, 'utf8'), 'preserve');
  }
  const f = await fixture(t);
  await rmdir(f.work);
  await writeFile(f.work, 'not a repository directory');
  await assert.rejects(prepareWriterTemporaryDirectory(f.work));
  assert.equal(await readFile(f.work, 'utf8'), 'not a repository directory');
});

test('linked directories and markers cannot redirect preparation', {
  skip: process.platform !== 'linux',
}, async t => {
  for (const target of ['work', 'cache', 'temporary', 'marker', 'hardlink']) {
    const f = await fixture(t), outside = join(f.root, 'outside');
    await mkdir(outside);
    const sentinel = join(outside, 'sentinel');
    await writeFile(sentinel, 'preserve');
    let work = f.work;
    if (target === 'work') {
      work = join(f.root, 'linked-work');
      await symlink(f.work, work);
    } else if (target === 'cache') {
      await symlink(outside, join(f.work, '.nibfin-cache'));
    } else {
      await mkdir(join(f.work, '.nibfin-cache'));
      if (target === 'temporary') await symlink(outside, f.temporary);
      else {
        await mkdir(f.temporary);
        const marker = join(f.temporary, '.keep');
        if (target === 'marker') await symlink(sentinel, marker);
        else await link(sentinel, marker);
      }
    }
    await assert.rejects(prepareWriterTemporaryDirectory(work),
      { code: 'UNTRUSTED_WRITER_TEMPORARY_PATH' });
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    await assert.rejects(lstat(join(outside, 'tmp')), { code: 'ENOENT' });
  }
});
