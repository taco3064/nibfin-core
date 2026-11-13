import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readEffectiveSkill, readSkill } from '../src/skills.mjs';
import { digest } from '../src/identity.mjs';

const core = resolve(import.meta.dirname, '..');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work);
  return { root, work };
}
for (const identity of ['shape', 'deliver', 'accept']) {
  test(`${identity}: defaults, exact composition and installed integrity`, async t => {
    const { work } = await fixture(t);
    const builtin = await readFile(join(core, 'skills', identity, 'SKILL.md'), 'utf8');
    const hash = digest(builtin);
    for (const project of [undefined, {}, { skills: {} },
      { skills: { [identity === 'shape' ? 'accept' : 'shape']:
        { mode: 'override', path: 'unused.md' } } }]) {
      const value = await readEffectiveSkill(core, identity, hash, project, work);
      assert.equal(value.content, builtin);
    }
    for (const custom of ['No front matter\n', '']) {
      await writeFile(join(work, 'custom.md'), custom);
      for (const mode of ['extend', 'override']) {
        const project = { skills: { [identity]: { mode, path: 'custom.md' } } };
        const value = await readEffectiveSkill(core, identity, hash, project, work);
        const expected = mode === 'override' ? custom :
          `${builtin}\n\n---\n\n${custom}`;
        assert.equal(value.content, expected);
        assert.equal(value.hash, digest(expected));
        if (mode === 'extend') {
          await assert.rejects(readEffectiveSkill(core, identity, '0'.repeat(64),
            project, work), /SKILL_IDENTITY_CHANGED/);
        }
      }
    }
    await assert.rejects(readSkill(core, identity, '0'.repeat(64)));
  });
}

test('unsafe files fail with bounded diagnostics and no fallback', async t => {
  const { work, root } = await fixture(t);
  const secret = 'OUTSIDE-CONTENT-MUST-NOT-APPEAR';
  await writeFile(join(root, 'outside.md'), secret);
  await mkdir(join(work, 'directory.md'));
  await symlink(join(root, 'outside.md'), join(work, 'escape.md'));
  await symlink(root, join(work, 'parent'));
  await writeFile(join(work, 'good.md'), 'regular control');
  const load = path => readEffectiveSkill(core, 'deliver', null,
    { skills: { deliver: { mode: 'override', path } } }, work);
  assert.equal((await load('good.md')).content, 'regular control');
  for (const path of ['/outside.md', '../outside.md', 'escape.md',
    'parent/outside.md', 'missing.md', 'directory.md', 'good.txt']) {
    await assert.rejects(load(path), error => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(root));
      return true;
    });
  }
});

test('unreadable file fails under an actually unprivileged reader', async t => {
  const { root, work } = await fixture(t);
  await chmod(root, 0o755);
  await writeFile(join(work, 'denied.md'), 'private', { mode: 0o000 });
  const module = new URL('../src/skills.mjs', import.meta.url).href;
  const script = `
    import { readEffectiveSkill } from ${JSON.stringify(module)};
    try {
      await readEffectiveSkill(${JSON.stringify(core)}, 'shape', null,
        { skills: { shape: { mode: 'override', path: 'denied.md' } } },
        ${JSON.stringify(work)});
      process.exit(1);
    } catch (error) {
      if (error.message !== 'PROJECT_SKILL_UNREADABLE_OR_UNSAFE') process.exit(2);
    }
  `;
  const options = { encoding: 'utf8' };
  if (process.getuid() === 0) Object.assign(options, { uid: 65534, gid: 65534 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    options);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('directory replacement during loading never redirects reads outside', async t => {
  const { root, work } = await fixture(t);
  await mkdir(join(work, 'parent'));
  await writeFile(join(work, 'parent', 'skill.md'), 'inside');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'skill.md'), 'outside secret');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
    const work = ${JSON.stringify(work)}, root = ${JSON.stringify(root)};
    process.send('ready');
    for (;;) {
      renameSync(work + '/parent', work + '/held');
      symlinkSync(root + '/outside', work + '/parent');
      unlinkSync(work + '/parent');
      renameSync(work + '/held', work + '/parent');
    }
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('swap fixture exited early')));
    });
    for (let index = 0; index < 150; index++) {
      try {
        const value = await readEffectiveSkill(core, 'shape', null,
          { skills: { shape: { mode: 'override', path: 'parent/skill.md' } } },
          work);
        assert.equal(value.content, 'inside');
      } catch (error) {
        assert.equal(error.message, 'PROJECT_SKILL_UNREADABLE_OR_UNSAFE');
      }
    }
  } finally {
    child.kill();
    await exited;
  }
});
