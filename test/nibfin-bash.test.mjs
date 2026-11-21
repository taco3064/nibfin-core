import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, copyFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeAgentPlan } from '../src/claude-agent-plan.mjs';
import { vmRouteProbe } from '../src/claude-bootstrap.mjs';
import { digest } from '../src/identity.mjs';
import { startShellGuest } from './fixtures/job-vm-shell-guest.mjs';

const posix = { skip: process.platform === 'win32' };

// Simulated: the fixed image paths are relocated into a private fixture.
// `vm` places the Core shell client and/or the guest shell socket path.
async function shell(t, entries, vm = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-bash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent-home'));
  const source = await readFile(new URL('../src/security/nibfin-bash', import.meta.url),
    'utf8');
  const relocated = source.replace('environment=/input/tool-environment',
    `environment=${root}/tool-environment`)
    .replace('marker=/agent-home/', `marker=${root}/agent-home/`)
    .replace('client=/input/vm-shell.mjs', `client=${root}/vm-shell.mjs`)
    .replace('socket=/job-vm-shell.sock', `socket=${vm.socket ?? root + '/none.sock'}`)
    .replace('state=/agent-home/', `state=${root}/agent-home/`)
    .replace('node=/usr/local/bin/node', `node=${process.execPath}`);
  assert.doesNotMatch(relocated,
    /^(?:environment|marker|client|socket|state|node)=\/(?:input|agent-home|job|usr)/m);
  if (vm.client) await copyFile(new URL('../src/claude-vm-shell.mjs', import.meta.url),
    join(root, 'vm-shell.mjs'));
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

const token = 'sk-ant-oat01-' + 'd'.repeat(40);
const content = 'Bound role instructions';
const vmPlan = claudeAgentPlan('deliver', { model: 'configured-model',
  skill: { identity: 'deliver', content, hash: digest(content) },
  context: { execution: { id: '00000000-0000-4000-8000-000000000001' } },
  jobVm: true });
const vmEntries = Object.entries(vmPlan.toolEnvironment);
// Asynchronous: the fixture relay runs in this process.
const run = (root, args) => new Promise(resolve => {
  const child = spawn('/bin/bash', [join(root, 'nibfin-bash'), ...args], { cwd: root,
    env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: token }, timeout: 20000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});
async function guestRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'nb-vm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('VM mode runs nothing locally except the snapshot invocation', posix,
  async t => {
    for (const vm of [{ client: true }, { socket: '/' }]) {
      const root = await shell(t, vmEntries, vm);
      const argvs = [['-c', 'touch ran', 'extra'], ['-l', '-c', 'touch ran'],
        ['-c'], [], ['-i', 'touch ran'], ['-c', '-l', 'touch ran', 'x'],
        ['-x', '-l', 'touch ran']];
      // Without the client even a tool argv is refused.
      if (!vm.client) argvs.push(['-c', 'touch ran']);
      for (const args of argvs) {
        const result = await run(root, args);
        assert.equal(result.status, 126, args.join(' '));
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'NIBFIN_TOOL_ROUTE_REFUSED\n');
      }
      assert.ok(!(await readdir(root)).includes('ran'));
      assert.deepEqual(await readdir(join(root, 'agent-home')), []);
    }
  });

test('the VM snapshot runs locally without the inherited credential', posix,
  async t => {
    const root = await shell(t, vmEntries, { client: true });
    const result = await run(root, ['-c', '-l', 'env; touch snapshot']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^GOFLAGS=-p=1$/m);
    assert.match(result.stdout, /^DOCKER_HOST=tcp:\/\/127\.0\.0\.1:2375$/m);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stdout.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    assert.ok((await readdir(root)).includes('snapshot'));
  });

test('the bootstrap VM route probe passes only for the VM route', posix,
  async t => {
    vmRouteProbe(join(await shell(t, vmEntries, { client: true }), 'nibfin-bash'));
    const docker = join(await shell(t, vmEntries), 'nibfin-bash');
    assert.throws(() => vmRouteProbe(docker), { message: 'SANDBOX_PROBE_FAILED' });
  });

// Simulated guest (test/fixtures/job-vm-shell-guest.py); /work is relocated.
test('VM tool scripts run in the guest with the Core environment only', posix,
  async t => {
    const guest = await startShellGuest(t, await guestRoot(t));
    const root = await shell(t, vmEntries, { client: true, socket: guest.relay });
    const result = await run(root, ['-c', 'echo out; echo err >&2; exit 4']);
    assert.equal(result.status, 4);
    assert.equal(result.stdout, 'out\n');
    assert.equal(result.stderr, 'err\n');
    const [request] = await guest.requests();
    assert.deepEqual(request.env, vmPlan.toolEnvironment);
    assert.equal(request.cwd, '/work');
    assert.ok(!JSON.stringify(request).includes(token));
    assert.deepEqual(await readdir(join(root, 'agent-home')), ['.nibfin-tool-progress']);
    await writeFile(join(root, 'tool-environment'), 'LD_PRELOAD=/tmp/x.so\0');
    const rejected = await run(root, ['-c', 'touch ran']);
    assert.equal(rejected.status, 126);
    assert.equal(rejected.stderr, 'JOB_VM_SHELL_ENVIRONMENT_REJECTED\n');
    assert.ok(!(await readdir(guest.work)).includes('ran'));
    const missing = await shell(t, vmEntries, { client: true,
      socket: join(root, 'missing.sock') });
    assert.equal((await run(missing, ['-c', 'true'])).stderr,
      'JOB_VM_SHELL_UNAVAILABLE\n');
  });

test('VM cwd follows the guest within /work and resets outside it', posix,
  async t => {
    const guest = await startShellGuest(t, await guestRoot(t));
    const root = await shell(t, vmEntries, { client: true, socket: guest.relay });
    const cwdFile = `/tmp/claude-${Date.now().toString(16)}${process.pid}-cwd`;
    t.after(() => rm(cwdFile, { force: true }));
    // Claude's own script shape: the command, then its cwd record.
    const claude = command => ['-c',
      `eval '${command}' < /dev/null && pwd -P >| ${cwdFile}`];
    const state = join(root, 'agent-home/.nibfin-guest-cwd');
    assert.equal((await run(root, claude('mkdir d && cd d'))).status, 0);
    // /work/d exists only in the guest: Claude's local cwd stays /work.
    assert.equal(await readFile(cwdFile, 'utf8'), '/work');
    assert.equal(await readFile(state, 'utf8'), '/work/d');
    assert.equal((await run(root, claude('pwd'))).stdout, join(guest.work, 'd') + '\n');
    assert.equal((await run(root, claude('cd /tmp'))).status, 0);
    assert.equal(await readFile(cwdFile, 'utf8'), '/work');
    assert.equal(await readFile(state, 'utf8'), '/tmp');
    assert.equal((await run(root, claude('pwd'))).stdout, guest.work + '\n');
    assert.ok((await guest.requests()).every(request => request.cwdFile === cwdFile));
  });
