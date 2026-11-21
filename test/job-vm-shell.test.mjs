import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runJobVmWriter } from '../src/job-vm-writer.mjs';
import { jobVmShellPort, probeJobVmShell } from '../src/job-vm-shell.mjs';
import { jobVmExecPort, jobVmExecutorFailures } from '../src/job-vm-exec-relay.mjs';
import { executionFiles } from '../src/job-vm-readiness-host.mjs';
import { startShellGuest } from './fixtures/job-vm-shell-guest.mjs';

const posix = { skip: process.platform === 'win32' };
const executionId = '00000000-0000-4000-8000-000000000001';

test('the executor guest shell endpoint (simulated cgroups)', posix, () => {
  const result = spawnSync('python3', ['-B', 'test/job-vm-shell.test.py'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('readiness re-runs for every Claude guest shell module', () => {
  for (const path of ['src/security/job-vm-executor.py', 'src/job-vm-shell.mjs',
    'src/claude-vm-shell.mjs', 'src/job-vm-exec-relay.mjs', 'src/job-vm-writer.mjs'])
    assert.ok(executionFiles.has(path), path);
  assert.equal(jobVmShellPort, 4023);
  assert.equal(jobVmExecPort, 4021);
});

test('the Claude shell probe is a real round trip through the relay', posix,
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-shell-probe-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const guest = await startShellGuest(t, root);
    await probeJobVmShell(guest.relay, AbortSignal.timeout(20_000));
    assert.deepEqual(guest.ports, [jobVmShellPort]);
    assert.deepEqual(await guest.requests(), [{ operation: 'run',
      script: 'printf NIBFIN_SHELL_READY', cwd: '/work', env: {} }]);
    const diagnostics = t.mock.method(console, 'error', () => {});
    await assert.rejects(probeJobVmShell(join(root, 'missing.sock'),
      AbortSignal.timeout(20_000)), { code: 'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE',
      reason: 'JOB_VM_SHELL_UNAVAILABLE' });
    assert.deepEqual(diagnostics.mock.calls.map(call => call.arguments),
      [['Nibfin Writer shell probe: JOB_VM_SHELL_UNAVAILABLE']]);
  });

// Controlled guest per port; no Firecracker, vsock or live KVM behavior.
async function writer(t, provider, { shell = 'ready', quiesce = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-shell-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { executionId, plan: provider ? { provider } : {} };
  for (const name of ['work', 'main', 'input']) {
    input[name] = join(root, name);
    await mkdir(input[name], { mode: 0o700 });
  }
  const events = [], paths = {}, sockets = new Set();
  const reply = (port, request) => {
    if (port === 4020) {
      events.push(`4020 ${request.operation}${request.name ? ' ' + request.name : ''}`);
      return request.operation === 'collect' ? { files: [] } : { ready: true,
        ...(request.name === 'work' ? { toolOutput: { root: request.toolRoot,
          directories: request.toolDirectories,
          collection: 'preserve-source-omit-owned-output' } } : {}) };
    }
    if (port === 4021) {
      events.push(`4021 ${request.method}`);
      return { id: 1, result: { sessionId: 'controlled-guest' } };
    }
    events.push(`4023 ${request.operation}`);
    if (request.operation === 'quiesce')
      return quiesce ? { quiesced: true } : { type: 'error',
        code: 'JOB_VM_SHELL_QUIESCE_FAILED' };
    return shell === 'ready' ? [{ type: 'stdout',
      data: Buffer.from('NIBFIN_SHELL_READY').toString('base64') },
    { type: 'exit', code: 0 }] : { type: 'error', code: shell };
  };
  for (const port of [4020, 4021, 4023]) {
    paths[port] = join(root, `guest-${port}.sock`);
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', bytes => {
        const value = reply(port, JSON.parse(bytes));
        for (const frame of [value].flat()) socket.write(JSON.stringify(frame) + '\n');
      });
    });
    server.listen(paths[port]);
    await once(server, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
  }
  const execute = async invocation => {
    events.push(`execute ${basename(invocation.jobVmSocket)}`);
    return { executionId, status: 'completed', terminationHash: 'a'.repeat(64) };
  };
  const run = () => runJobVmWriter({}, input, execute, {
    ...(provider ? { provider } : {}),
    capacity: async () => async () => {},
    observe: async () => ({ finish: async () => undefined }),
    runVm: async (_config, lifecycle) => {
      try {
        return await lifecycle.useGuest(async port =>
          createConnection({ path: paths[port] }), root);
      } finally { await lifecycle.onRetired(async () => {}); }
    },
  });
  return { events, run, input };
}

const prepared = ['4020 prepare work', '4020 prepare main', '4020 prepare input'];

// Captured from the Writer before the provider parameter: sockets, probe and
// collection order of a Codex Firecracker execution.
test('Codex VM writer keeps its exec socket, probe and collection order', posix,
  async t => {
    const f = await writer(t);
    assert.equal((await f.run()).status, 'completed');
    assert.deepEqual(f.events, [...prepared, '4021 initialize', 'execute exec.sock',
      '4020 collect']);
    const explicit = await writer(t, 'codex');
    assert.equal((await explicit.run()).status, 'completed');
    assert.deepEqual(explicit.events, f.events);
  });

test('Claude VM writer probes its shell and quiesces before collection', posix,
  async t => {
    const f = await writer(t, 'claude');
    assert.equal((await f.run()).status, 'completed');
    assert.deepEqual(f.events, [...prepared, '4023 run', 'execute shell.sock',
      '4023 quiesce', '4020 collect']);
    const stuck = await writer(t, 'claude', { quiesce: false });
    await assert.rejects(stuck.run(), { code: 'JOB_VM_SHELL_QUIESCE_FAILED' });
    assert.ok(!stuck.events.includes('4020 collect'));
  });

test('a failed Claude shell probe reuses the executor code with a diagnostic',
  posix, async t => {
    const diagnostics = t.mock.method(console, 'error', () => {});
    const f = await writer(t, 'claude', { shell: 'JOB_VM_SHELL_CGROUP_UNSUPPORTED' });
    const result = await f.run();
    assert.equal(result.status, 'interrupted');
    assert.equal(result.code, 'JOB_VM_EXEC_INITIALIZE_UNAVAILABLE');
    assert.ok(jobVmExecutorFailures.includes(result.code));
    assert.deepEqual(f.events, [...prepared, '4023 run']);
    assert.ok(diagnostics.mock.calls.some(call => call.arguments[0] ===
      'Nibfin Writer shell probe: JOB_VM_SHELL_CGROUP_UNSUPPORTED'));
  });

test('the writer provider must match the plan provider', posix, async t => {
  for (const [provider, plan] of [['claude', 'codex'], ['codex', 'claude'],
    ['other', 'other']]) {
    const f = await writer(t, plan === 'codex' ? undefined : plan);
    await assert.rejects(runJobVmWriter({}, f.input, async () => {}, { provider }),
      { code: 'INVALID_AGENT_PLAN' });
  }
});
