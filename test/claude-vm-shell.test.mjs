import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nearestLocal, readToolEnvironment, reportedDirectory, shellCwdFile, shellExchange,
  shellOutputLimit, startDirectory,
} from '../src/claude-vm-shell.mjs';
import { claudeAgentPlan, jobVmToolEnvironment } from '../src/claude-agent-plan.mjs';
import { forwardJobVmArguments } from '../src/codex-bootstrap.mjs';
import { claudeLimits } from '../src/claude-plan.mjs';
import { digest } from '../src/identity.mjs';

const posix = { skip: process.platform === 'win32' };
const content = 'Bound role instructions';
const plan = jobVm => claudeAgentPlan('deliver', { model: 'configured-model',
  skill: { identity: 'deliver', content, hash: digest(content) },
  context: { execution: { id: '00000000-0000-4000-8000-000000000001' } }, jobVm });
// Local /work copy: only /work and /work/src exist.
const local = path => ['/work', '/work/src'].includes(path);

test('the VM tool environment is Codex VM forwarding and passes the guest check',
  posix, () => {
    const forwarded = Object.fromEntries(forwardJobVmArguments(['exec'])
      .filter(arg => arg.startsWith('shell_environment_policy.set.'))
      .map(arg => /^shell_environment_policy\.set\.([A-Z_]+)=(.*)$/.exec(arg))
      .map(([, key, value]) => [key, JSON.parse(value)]));
    assert.deepEqual(jobVmToolEnvironment, forwarded);
    assert.equal(shellOutputLimit, claudeLimits.stdout);
    // The guest validator accepts exactly what Core sends, and only that.
    const check = values => spawnSync('python3', ['-B', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('e', 'src/security/job-vm-executor.py')
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
try:
    e.shell_environment(json.loads(sys.argv[1])); print('accepted')
except e.ShellRefused as error:
    print(error.code)`, JSON.stringify(values)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(check(plan(true).toolEnvironment), 'accepted');
    assert.equal(check(plan(false).toolEnvironment), 'accepted');
    for (const extra of [{ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, { ALL_PROXY: 'x' },
      { HOME: '/agent-home' }])
      assert.equal(check({ ...plan(true).toolEnvironment, ...extra }),
        'JOB_VM_SHELL_ENVIRONMENT_REJECTED');
  });

test('the cwd file is read from Claude\'s own script ending only', () => {
  assert.equal(shellCwdFile("source /x || true && eval 'ls' < /dev/null && " +
    'pwd -P >| /tmp/claude-1a2b-cwd'), '/tmp/claude-1a2b-cwd');
  assert.equal(shellCwdFile("eval 'x' && pwd -P >| '/tmp/claude-ff-cwd'\n"),
    '/tmp/claude-ff-cwd');
  for (const script of ['pwd -P >| /tmp/claude-1a2b-cwd; rm -rf /',
    'pwd -P >| /etc/passwd', 'pwd -P >| /tmp/claude-../x-cwd', 'ls'])
    assert.equal(shellCwdFile(script), undefined, script);
});

test('the wrapper keeps or resets the guest cwd from Claude\'s spawn cwd', () => {
  // mkdir d && cd d: /work/d is guest-only, Claude stays at /work.
  assert.equal(reportedDirectory('/work/d', local), '/work');
  assert.equal(startDirectory('/work/d', '/work', local), '/work/d');
  assert.equal(nearestLocal('/work/src/a/b', local), '/work/src');
  // cd /tmp: Claude resets to /work and so does the next command.
  assert.equal(reportedDirectory('/tmp', local), '/work');
  assert.equal(startDirectory('/tmp', '/work', local), '/work');
  // Claude moved elsewhere: its spawn cwd wins.
  assert.equal(startDirectory('/work/d', '/work/src', local), '/work/src');
  assert.equal(startDirectory('/work/src/x', '/work/src', local), '/work/src/x');
  assert.equal(startDirectory(undefined, '/work/src', local), '/work/src');
  assert.equal(startDirectory('/work/d', '/home/claude', local), '/work/d');
  assert.equal(startDirectory(undefined, '/home/claude', local), '/work');
  for (const unsafe of ['/work/../etc', '/work/d/', 'work/d', '/work/\nx', 42])
    assert.equal(reportedDirectory(unsafe, () => true), '/work', String(unsafe));
  assert.equal(startDirectory('/work/../etc', '/work', () => true), '/work');
});

test('the tool environment file must be complete NUL-separated entries', posix,
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-vm-env-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'tool-environment');
    await writeFile(path, 'A=1\0B=x=y\0');
    assert.deepEqual(readToolEnvironment(path), { A: '1', B: 'x=y' });
    for (const text of ['A=1', '=1\0', 'A\0']) {
      await writeFile(path, text);
      assert.throws(() => readToolEnvironment(path),
        { code: 'NIBFIN_TOOL_ENVIRONMENT_UNAVAILABLE' });
    }
    assert.throws(() => readToolEnvironment(join(root, 'missing')),
      { code: 'NIBFIN_TOOL_ENVIRONMENT_UNAVAILABLE' });
  });

async function exchange(t, frames, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-vm-frames-'));
  const path = join(root, 'guest.sock'), requests = [];
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', bytes => {
      requests.push(bytes.toString());
      for (const frame of frames) socket.write(frame);
      if (!options.open) socket.end();
    });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  let stdout = '', stderr = '';
  try {
    const result = await shellExchange(createConnection({ path }),
      { operation: 'run' }, { stdout: bytes => { stdout += bytes; },
        stderr: bytes => { stderr += bytes; }, signal: options.signal });
    return { result, stdout, stderr, requests };
  } catch (error) {
    return { error: error.code, stdout, stderr, requests };
  }
}

const line = value => JSON.stringify(value) + '\n';
const data = (type, text) => line({ type, data: Buffer.from(text).toString('base64') });

test('guest frames stream output, the cwd and the exit code', posix, async t => {
  const ok = await exchange(t, [data('stdout', 'a'), data('stderr', 'b'),
    line({ type: 'cwd', path: '/work/d' }) + data('stdout', 'c'),
    line({ type: 'exit', code: 9 })]);
  assert.deepEqual(ok.result, { code: 9, cwd: '/work/d' });
  assert.equal(ok.stdout, 'ac');
  assert.equal(ok.stderr, 'b');
  assert.deepEqual(JSON.parse(ok.requests[0]), { operation: 'run' });
  assert.equal((await exchange(t, [line({ type: 'error',
    code: 'JOB_VM_SHELL_BUSY' })])).error, 'JOB_VM_SHELL_BUSY');
});

test('untrusted guest frames fail closed', posix, async t => {
  const invalid = [line({ type: 'exit', code: 256 }), line({ type: 'exit', code: -1 }),
    line({ type: 'error', code: 'ANY_CODE' }), line({ type: 'other' }), 'not json\n',
    line({ type: 'cwd', path: '/a' }) + line({ type: 'cwd', path: '/b' }),
    'x'.repeat(300 * 1024)];
  for (const frame of invalid)
    assert.equal((await exchange(t, [frame])).error, 'JOB_VM_SHELL_INVALID', frame);
  // Guest-sized 64 KiB chunks, one past the 8 MiB bound.
  const chunk = Buffer.alloc(65536).toString('base64');
  const flood = Array.from({ length: 129 }, () => line({ type: 'stdout', data: chunk }));
  assert.equal((await exchange(t, flood)).error, 'JOB_VM_SHELL_OUTPUT_LIMIT');
  assert.equal((await exchange(t, [data('stdout', 'partial')])).error,
    'JOB_VM_SHELL_DISCONNECTED');
  const signal = AbortSignal.timeout(100);
  assert.equal((await exchange(t, [], { open: true, signal })).error,
    'JOB_VM_SHELL_TIMEOUT');
  // The client is copied alone into the container: Node built-ins only.
  const source = await readFile(new URL('../src/claude-vm-shell.mjs', import.meta.url),
    'utf8');
  for (const [, from] of source.matchAll(/^import .* from '([^']+)';$/gm))
    assert.match(from, /^node:/);
});
