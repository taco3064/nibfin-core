import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const posix = { skip: process.platform === 'win32' };

// Simulated: the fixed image paths are relocated into a private fixture.
async function shell(t, entries) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-bash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent-home'));
  const source = await readFile(new URL('../src/security/nibfin-bash', import.meta.url),
    'utf8');
  const relocated = source.replace('environment=/input/tool-environment',
    `environment=${root}/tool-environment`)
    .replace('marker=/agent-home/', `marker=${root}/agent-home/`);
  assert.notEqual(relocated, source);
  await writeFile(join(root, 'nibfin-bash'), relocated, { mode: 0o755 });
  if (entries) await writeFile(join(root, 'tool-environment'),
    entries.map(([key, value]) => `${key}=${value}\0`).join(''));
  return root;
}

test('tool commands get the Core tool environment and their exit status', posix,
  async t => {
    const root = await shell(t, [['GOFLAGS', '-p=1'], ['NODE_USE_ENV_PROXY', '1'],
      ['HOME', '/work/.nibfin-cache/x/home'], ['LITERAL', '$(touch injected) a b']]);
    const started = Date.now();
    const result = spawnSync('/bin/bash', [join(root, 'nibfin-bash'), '-c',
      'echo "$GOFLAGS|$NODE_USE_ENV_PROXY|$HOME|$LITERAL|$KEPT"; exit 7'],
    { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', KEPT: 'kept' },
      timeout: 10000 });
    assert.equal(result.status, 7);
    assert.equal(result.stdout,
      '-p=1|1|/work/.nibfin-cache/x/home|$(touch injected) a b|kept\n');
    // The marker refresher holds no command stream open.
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(await readdir(join(root, 'agent-home')), ['.nibfin-tool-progress']);
    assert.ok(!(await readdir(root)).includes('injected'));
  });

test('a missing or unreadable environment file runs no command', posix,
  async t => {
    const cases = [async () => {},
      async root => { await mkdir(join(root, 'tool-environment')); }];
    if (process.getuid() !== 0) cases.push(async root => {
      await writeFile(join(root, 'tool-environment'), 'A=1\0', { mode: 0o000 });
    });
    for (const prepare of cases) {
      const root = await shell(t);
      await prepare(root);
      const result = spawnSync('/bin/bash', [join(root, 'nibfin-bash'), '-c',
        'touch ran; echo ran'], { cwd: root, encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' }, timeout: 10000 });
      assert.equal(result.status, 126);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'NIBFIN_TOOL_ENVIRONMENT_UNAVAILABLE\n');
      assert.ok(!(await readdir(root)).includes('ran'));
      assert.deepEqual(await readdir(join(root, 'agent-home')), []);
    }
  });
