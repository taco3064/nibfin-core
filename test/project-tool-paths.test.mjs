import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir, mkdtemp, readFile, rm, writeFile, symlink, rename,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectToolPaths, projectToolDirectories }
  from '../src/project-tool-paths.mjs';
import { prepareToolOutput } from '../src/project-tool-output.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { forwardJobVmArguments, sandboxProbeArguments }
  from '../src/codex-bootstrap.mjs';
import { workEnvironment } from '../src/claude-work-container.mjs';
import { digest } from '../src/identity.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const repository = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const parent = join(repository, '.nibfin-cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'tool-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('both providers forward the same role tool paths to their actual commands', () => {
  for (const stage of ['deliver', 'accept', 'shape', 'review-pr']) {
    const writable = stage === 'deliver';
    const identity = ['shape', 'review-pr'].includes(stage) ? 'shape' : stage;
    const content = 'Role instructions';
    const plan = codexPlan(stage, {
      model: 'configured-model', context: { execution: { id } },
      skill: { identity, content, hash: digest(content) },
    });
    const paths = projectToolPaths(writable, id);
    const claude = Object.fromEntries(workEnvironment(
      { proxyUrl: 'http://gateway:3128' }, writable, id,
    ).map(value => {
      const split = value.indexOf('=');
      return [value.slice(0, split), value.slice(split + 1)];
    }));
    for (const [key, value] of Object.entries(paths)) {
      assert.equal(plan.config['shell_environment_policy.set'][key], value);
      assert.equal(claude[key], value);
      assert.ok(value.startsWith(writable ? '/work/' : '/tmp/'));
    }
    const forwarded = forwardJobVmArguments(plan.args);
    for (const setting of plan.settings) assert.ok(forwarded.includes(setting));
    assert.deepEqual(plan.toolDirectories, projectToolDirectories(writable, id));
    assert.equal(plan.config['permissions.nibfin.filesystem']['/work'],
      writable ? 'write' : 'read');
    assert.equal(plan.environment.CODEX_HOME, '/agent-home');
    assert.equal(plan.environment.HOME, '/session');
    assert.ok(sandboxProbeArguments(plan, '192.0.2.1', 8, true)
      .includes('shell_environment_policy.set.TMPDIR="/tmp/tool-home"'));
  }
});

test('tool output preparation never follows an escaping source link',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await fixture(t);
    const work = join(root, 'work'), outside = join(root, 'outside');
    await mkdir(work); await mkdir(outside);
    await symlink(outside, join(work, '.nibfin-cache'));
    await assert.rejects(prepareToolOutput(work, id), /UNSAFE_TOOL_OUTPUT_PATH/);
    await assert.rejects(readFile(join(outside, id)), { code: 'ENOENT' });
  });

test('a real child creates temporary and cache output under its repo', async t => {
  const root = await fixture(t);
  const paths = Object.fromEntries(Object.entries(projectToolPaths(true, id))
    .map(([key, value]) => [key, join(root, value.slice('/work/'.length))]));
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  const code = `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const keys = ${JSON.stringify(Object.keys(paths))};
    const generated = keys.map(key => {
      const file = path.join(process.env[key], key + '.output');
      fs.writeFileSync(file, key); return file;
    });
    generated.push(fs.mkdtempSync(path.join(os.tmpdir(), 'child-')));
    process.stdout.write(JSON.stringify(generated));
  `;
  const child = spawnSync(process.execPath, ['-e', code], {
    cwd: root, encoding: 'utf8', env: { ...paths, SystemRoot: process.env.SystemRoot },
  });
  assert.equal(child.status, 0, child.stderr);
  for (const file of JSON.parse(child.stdout)) assert.ok(file.startsWith(root + sep));
});

test('native worker and VM collection preserve role output boundaries',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await fixture(t);
    const environment = Object.fromEntries(Object.entries(projectToolPaths(true, id))
      .map(([key, value]) => [key, join(root, value.slice('/work/'.length))]));
    const child = spawnSync('python3', ['-B', 'test/fixtures/project-tool-tests.py'], {
      cwd: repository, encoding: 'utf8', input: JSON.stringify({ root, environment }),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: root },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });

test('only newly owned tool output is retired after its runtime has ended', async t => {
  const work = await fixture(t);
  const lease = await prepareToolOutput(work, id);
  assert.equal(lease.owned, true);
  const path = join(work, '.nibfin-cache', id);
  await writeFile(join(path, 'active-runtime-file'), 'Core-owned');
  // Agent handoff does not remove a still-owned runtime artifact.
  assert.equal(await readFile(join(path, 'active-runtime-file'), 'utf8'), 'Core-owned');
  await lease.dispose();
  await assert.rejects(readFile(join(path, 'active-runtime-file')), { code: 'ENOENT' });
  await mkdir(path);
  await writeFile(join(path, 'maintained-source'), 'keep');
  const existing = await prepareToolOutput(work, id);
  assert.equal(existing.owned, false);
  assert.equal(existing.cleanupScript, '');
  await existing.dispose();
  assert.equal(await readFile(join(path, 'maintained-source'), 'utf8'), 'keep');
});

test('matching output identities can be retired by the container cleanup recipe',
  async t => {
    const work = await fixture(t);
    const lease = await prepareToolOutput(work, id);
    const parent = join(work, '.nibfin-cache'), root = join(parent, id);
    await writeFile(join(root, 'disposable.txt'), 'temporary');
    const script = lease.cleanupScript
      .replace(JSON.stringify('/work/.nibfin-cache'), JSON.stringify(parent))
      .replace(JSON.stringify('/work/.nibfin-cache/' + id), JSON.stringify(root));
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    await lease.dispose();
    await assert.rejects(readFile(join(root, 'disposable.txt')), { code: 'ENOENT' });
  });

test('settlement preserves files after a parent link or root replacement', async t => {
  for (const replace of ['parent', 'root']) {
    const work = await fixture(t);
    const lease = await prepareToolOutput(work, id);
    const parent = join(work, '.nibfin-cache'), root = join(parent, id);
    const saved = join(work, 'original');
    await writeFile(join(root, 'original.txt'), 'owned');
    if (replace === 'parent') {
      const outside = join(work, 'outside');
      await mkdir(join(outside, id), { recursive: true });
      await writeFile(join(outside, id, 'preserve.txt'), 'other');
      await rename(parent, saved);
      await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await rename(root, saved);
      await mkdir(root);
      await writeFile(join(root, 'preserve.txt'), 'other');
    }
    await assert.rejects(lease.dispose(), { code: 'TOOL_OUTPUT_CHANGED' });
    assert.equal(await readFile(join(root, 'preserve.txt'), 'utf8'), 'other');
    const script = lease.cleanupScript
      .replace(JSON.stringify('/work/.nibfin-cache'), JSON.stringify(parent))
      .replace(JSON.stringify('/work/.nibfin-cache/' + id), JSON.stringify(root));
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /TOOL_OUTPUT_CHANGED/);
    assert.equal(await readFile(join(root, 'preserve.txt'), 'utf8'), 'other');
    const original = replace === 'parent' ? join(saved, id) : saved;
    assert.equal(await readFile(join(original, 'original.txt'), 'utf8'), 'owned');
  }
});
