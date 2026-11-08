import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, writeFile, stat, chmod, symlink, link, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupAgentMounts, shareAgentMount } from '../src/agent-mounts.mjs';

test('mapped access preserves Git executable modes below a private parent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mounts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'); await mkdir(work, { mode: 0o700 });
  await writeFile(join(work, 'plain'), 'data', { mode: 0o600 });
  await writeFile(join(work, 'executable'), 'data', { mode: 0o700 });
  await shareAgentMount(work, true);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(work, 'plain'))).mode & 0o777, 0o666);
  assert.equal((await stat(join(work, 'executable'))).mode & 0o777, 0o777);
  await shareAgentMount(work, false);
  assert.equal((await stat(join(work, 'plain'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(work, 'executable'))).mode & 0o777, 0o755);
  await chmod(root, 0o755);
  await assert.rejects(shareAgentMount(work, true), {
    code: 'AGENT_MOUNT_PARENT_NOT_PRIVATE',
  });
});

test('cleanup preserves npm hard links without changing a linked inode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mounts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work);
  const executable = join(work, 'esbuild');
  const npmAlias = join(work, 'esbuild-alias');
  const outside = join(root, 'outside');
  await writeFile(executable, 'binary', { mode: 0o700 });
  await link(executable, npmAlias);
  await writeFile(outside, 'private', { mode: 0o600 });
  await link(outside, join(work, 'external-alias'));
  const plain = join(work, 'plain');
  await writeFile(plain, 'output', { mode: 0o600 });
  execFileSync(process.execPath, ['-e', cleanupAgentMounts, work]);
  assert.equal((await stat(executable)).mode & 0o777, 0o700);
  assert.equal((await stat(npmAlias)).ino, (await stat(executable)).ino);
  assert.equal((await stat(outside)).mode & 0o777, 0o600);
  assert.equal((await stat(plain)).mode & 0o777, 0o666);
});

test('unsafe links reject before changing any file permissions', async t => {
  for (const kind of ['symbolic', 'hard']) {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-mounts-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const work = join(root, 'work'); await mkdir(work, { mode: 0o700 });
    const secret = join(root, 'secret');
    await writeFile(secret, 'private', { mode: 0o600 });
    await (kind === 'symbolic' ? symlink : link)(secret, join(work, 'linked'));
    await assert.rejects(shareAgentMount(work, true), {
      code: 'UNSAFE_AGENT_MOUNT_ENTRY',
    });
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.equal((await stat(work)).mode & 0o777, 0o700);
  }
});
