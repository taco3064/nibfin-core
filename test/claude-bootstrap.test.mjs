import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, lstat, chmod }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bootstrap, claudeIdle, claudeIdleDiagnostic, claudePreflightExits, claudeTimeouts,
  credentialVariable, credentialVariables, denialProbe, entryExit, environProbe,
  inputLimit, outputLimit, progressMarker, projectPythonCheck, readInput, runClaude,
  sandboxProbeArguments, terminalResult, writeOutput,
} from '../src/claude-bootstrap.mjs';
import { codexIdle, codexPreflightExits } from '../src/codex-bootstrap.mjs';
import { claudeCredentialKinds } from '../src/claude-model-credentials.mjs';
import { claudeLimits } from '../src/claude-plan.mjs';
import { parseClaudeResult } from '../src/claude-result.mjs';

const posix = { skip: process.platform === 'win32' };
const token = 'sk-ant-oat01-' + 'a'.repeat(40);
const session = '12345678-1234-4234-8234-123456789abc';
const structured = { outcome: 'ready', body: '', summary: 'Checked',
  rootCause: '', failureClass: 'none', evidenceReferences: ['/work'],
  blockingFindings: [], contractConflicts: [] };
const envelope = (change = {}) => ({ type: 'result', subtype: 'success',
  is_error: false, session_id: session, structured_output: structured, ...change });

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-claude-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function script(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test('the self-contained entry keeps Core exit codes, limits and patterns', async () => {
  assert.deepEqual(claudeIdle, codexIdle);
  for (const [reason, code] of Object.entries(claudePreflightExits))
    assert.equal(code, codexPreflightExits[reason], reason);
  const codex = await readFile(new URL('../src/codex-bootstrap.mjs', import.meta.url),
    'utf8');
  assert.match(codex, /const roleIdleTimeout = 10 \* 60_000;/);
  assert.match(codex, /const startupTimeout = 60_000;/);
  assert.match(codex, /size > 8 \* 1024 \* 1024/);
  assert.deepEqual(claudeTimeouts, { role: 10 * 60_000, startup: 60_000 });
  assert.equal(outputLimit, claudeLimits.stdout);
  assert.equal(inputLimit, claudeLimits.stdin + 1024);
  assert.deepEqual(credentialVariables.map(([pattern, name]) => [pattern.source, name]),
    [[claudeCredentialKinds['claude-subscription-token'].pattern.source,
      'CLAUDE_CODE_OAUTH_TOKEN'],
    [claudeCredentialKinds['anthropic-api-key'].pattern.source, 'ANTHROPIC_API_KEY']]);
  const source = await readFile(new URL('../src/claude-bootstrap.mjs', import.meta.url),
    'utf8');
  for (const [, from] of source.matchAll(/^import .* from '([^']+)';$/gm))
    assert.match(from, /^node:/);
  assert.equal(credentialVariable('sk-ant-api03-' + 'b'.repeat(40)), 'ANTHROPIC_API_KEY');
  assert.equal(credentialVariable('sk-ant-admin01-' + 'b'.repeat(40)), undefined);
});

test('terminal result checks agree with Core result parsing', () => {
  const cases = [
    [JSON.stringify(envelope()), true],
    [JSON.stringify(envelope({ is_error: true })), false],
    [JSON.stringify(envelope({ subtype: 'error_max_turns' })), false],
    [JSON.stringify(envelope({ errors: ['failed'] })), false],
    [JSON.stringify(envelope({ errors: [] })), true],
    [JSON.stringify(envelope({ session_id: 'not-a-session' })), false],
    [JSON.stringify(envelope({ structured_output: null })), false],
    [JSON.stringify(envelope({ type: 'assistant' })), false],
    [JSON.stringify(envelope()).replace('{', '{"type":"result",'), false],
  ];
  for (const [line, valid] of cases) {
    const core = (() => {
      try { parseClaudeResult('deliver', line); return true; } catch { return false; }
    })();
    const entry = (() => {
      try { return terminalResult(`{"type":"system"}\n${line}\n`) === line; }
      catch (error) {
        assert.equal(error.message, 'CLAUDE_RESULT_INVALID');
        return false;
      }
    })();
    assert.equal(core, valid, line);
    assert.equal(entry, valid, line);
  }
  const line = JSON.stringify(envelope());
  for (const stream of ['', `${line}\n${line}`, `${line}\n{"type":"user"}`, 'noise'])
    assert.throws(() => terminalResult(stream), /CLAUDE_RESULT_INVALID/);
});

const run = (body, options = {}) => runClaude(['-e', body], {
  executable: process.execPath, cwd: process.cwd(), input: '', idleTimeout: 1000,
  ...options,
});

test('stream events and the tool marker extend the idle deadline', async t => {
  const result = await run(`
    process.stdout.write('{"type":"assi');
    setTimeout(() => process.stdout.write('stant"}\\n'), 600);
    setTimeout(() => process.stdout.write('{"type":"result"}\\n'), 1300);
  `);
  assert.equal(result.stdout, '{"type":"assistant"}\n{"type":"result"}\n');
  const home = await directory(t);
  const marked = await run(`
    const fs = require('node:fs');
    let count = 0;
    const timer = setInterval(() => {
      fs.writeFileSync(${JSON.stringify(join(home, progressMarker))}, '');
      if (++count === 6) { clearInterval(timer); console.log('done'); }
    }, 300);
  `, { progressDirectory: home });
  assert.equal(marked.stdout, 'done\n');
  await assert.rejects(run(`
    const fs = require('node:fs');
    setInterval(() => {
      fs.writeFileSync(${JSON.stringify(join(home, 'other'))}, '');
      process.stderr.write('waiting\\n');
      console.log(JSON.stringify({ type: 'heartbeat' }));
    }, 100);
  `, { progressDirectory: home }), { message: 'CODEX_IDLE_TIMEOUT' });
});

test('idle diagnostics name only allowlisted event and block types', () => {
  const stalled = `
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'private-command' } }] } }));
    setInterval(() => {}, 50);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runClaude } from './src/claude-bootstrap.mjs';
    await runClaude(['-e', ${JSON.stringify(stalled)}], {
      executable: process.execPath, cwd: process.cwd(), input: '', idleTimeout: 1000,
    }).catch(() => {});
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(claudeIdleDiagnostic(result.stderr),
    'NIBFIN_IDLE_PROGRESS assistant tool_use');
  assert.doesNotMatch(result.stderr, /private-command|Bash/);
  assert.equal(claudeIdleDiagnostic('NIBFIN_IDLE_PROGRESS tool running'),
    'NIBFIN_IDLE_PROGRESS tool running');
  assert.equal(claudeIdleDiagnostic('NIBFIN_IDLE_PROGRESS item.started none'),
    undefined);
});

test('output beyond the bound and failed or missing CLIs are rejected', async () => {
  // A long idle deadline so the idle timer cannot win the race under load.
  await assert.rejects(run(`process.stdout.write('x'.repeat(${outputLimit + 1}))`,
    { idleTimeout: 30000 }), { message: 'CLAUDE_OUTPUT_LIMIT' });
  await assert.rejects(run('process.exit(3)'), { message: 'CLAUDE_EXECUTION_FAILED' });
  await assert.rejects(runClaude(['--version'], { executable: '/nonexistent/claude',
    cwd: process.cwd() }), { message: 'CODEX_UNAVAILABLE' });
});

test('stdin carries one credential line followed by the prompt', async () => {
  assert.deepEqual(await readInput(Readable.from([Buffer.from(`${token}\nLine 1\n`),
    Buffer.from('Line 2')])), { variable: 'CLAUDE_CODE_OAUTH_TOKEN', token,
    prompt: 'Line 1\nLine 2' });
  for (const text of [token, `not-a-token\nprompt`, `\n${token}\nprompt`,
    `${token}\n${'x'.repeat(inputLimit)}`])
    await assert.rejects(readInput(Readable.from([Buffer.from(text)])),
      { message: 'SUBSCRIPTION_LOGIN_UNAVAILABLE' });
});

test('outputs replace an existing entry without following it', posix, async t => {
  const root = await directory(t);
  const target = join(root, 'target'), path = join(root, 'stream.json');
  await writeFile(target, 'unchanged');
  await symlink(target, path);
  await writeOutput(path, '{}');
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.equal(await readFile(path, 'utf8'), '{}');
  assert.ok((await lstat(path)).isFile());
});

test('an unconfined host fails the environ denial probe', posix, async () => {
  await assert.rejects(runClaude(['-e', environProbe, String(process.pid)], {
    executable: process.execPath, cwd: '/' }), { message: 'CLAUDE_EXECUTION_FAILED' });
});

test('the denial probe requires both the environ and bubblewrap checks', posix,
  async t => {
    const root = await directory(t), log = join(root, 'bwrap-args');
    const node = await script(join(root, 'node'), `case "$2" in
  *setInterval*) exec sleep 5 ;;
  *) echo NIBFIN_ENVIRON_DENIED ;;
esac`);
    const bwrap = await script(join(root, 'bwrap'),
      `printf '%s\\n' "$@" > ${log}\necho NIBFIN_SANDBOX_DENIED`);
    await denialProbe('172.20.0.2', { node, bwrap, proxyPort: 3128 });
    assert.deepEqual((await readFile(log, 'utf8')).split('\n').slice(0, 13),
      sandboxProbeArguments('172.20.0.2', 3128, node).slice(0, 13));
    const open = await script(join(root, 'open'), 'echo NIBFIN_PROBE_READABLE');
    await assert.rejects(denialProbe('172.20.0.2', { node, bwrap: open }),
      { message: 'SANDBOX_PROBE_FAILED' });
    await assert.rejects(denialProbe('172.20.0.2', { node: open, bwrap }),
      { message: 'SANDBOX_PROBE_FAILED' });
    assert.deepEqual(sandboxProbeArguments('h', 1, '/n').slice(0, 13), [
      '--unshare-user', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/',
      '--dev-bind', '/dev', '/dev', '--tmpfs', '/agent-home', '--tmpfs', '/io']);
  });

async function entryFixture(t, { version = '2.1.326 (Claude Code)' } = {}) {
  const root = await directory(t);
  for (const path of ['input', 'io', 'agent-home', 'work', 'bin'])
    await mkdir(join(root, path));
  const server = createServer(socket => socket.destroy()).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const result = JSON.stringify(envelope());
  const claude = await script(join(root, 'bin/claude'), `
if [ "$1" = --version ]; then echo '${version}'; exit 0; fi
[ "$CLAUDE_CODE_OAUTH_TOKEN" = '${token}' ] || exit 9
[ -z "$ANTHROPIC_API_KEY" ] || exit 10
[ "$(cat)" = 'Role prompt' ] || exit 11
[ "$(pwd)" = '${root}/work' ] || exit 12
echo '{"type":"system","subtype":"init"}'
echo '${result}'`);
  const node = await script(join(root, 'bin/node'),
    'case "$2" in *setInterval*) exec sleep 5 ;; esac\necho NIBFIN_ENVIRON_DENIED');
  const bwrap = await script(join(root, 'bin/bwrap'), 'echo NIBFIN_SANDBOX_DENIED');
  await writeFile(join(root, 'input/invocation.json'), JSON.stringify({
    plan: { cwd: '/work', args: ['-p'], policyHash: 'f'.repeat(64),
      toolDirectories: ['/work/.nibfin-cache/x/home'] },
    codexVersion: '2.1.326 (Claude Code)', proxyHost: '127.0.0.1', jobVm: false }));
  return { root, result, options: { root, claude, node, bwrap,
    proxyPort: server.address().port,
    input: Readable.from([Buffer.from(`${token}\nRole prompt`)]) } };
}

test('the entry probes, runs Claude with the credential and writes outputs after',
  posix, async t => {
    const f = await entryFixture(t);
    await symlink(join(f.root, 'work'), join(f.root, 'io/stream.json'));
    await bootstrap(f.options);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'io/probe.json'), 'utf8')),
      { policyHash: 'f'.repeat(64), stdout: 'NIBFIN_PROBE_PASSED\n',
        codexVersion: '2.1.326 (Claude Code)' });
    const stream = JSON.parse(await readFile(join(f.root, 'io/stream.json'), 'utf8'));
    assert.deepEqual(stream, { stdout: f.result, stderr: '' });
    assert.ok((await lstat(join(f.root, 'io/stream.json'))).isFile());
    assert.deepEqual((await readdir(join(f.root, 'agent-home'))), [progressMarker]);
    assert.ok((await lstat(join(f.root, 'work/.nibfin-cache/x/home'))).isDirectory());
    for (const name of await readdir(join(f.root, 'io')))
      assert.ok(!(await readFile(join(f.root, 'io', name), 'utf8')).includes(token));
  });

test('entry failures map to the reused Codex exit codes', posix, async t => {
  const mismatch = await entryFixture(t, { version: '2.1.325 (Claude Code)' });
  await assert.rejects(bootstrap(mismatch.options),
    { message: 'CODEX_VERSION_MISMATCH' });
  const login = await entryFixture(t);
  login.options.input = Readable.from([Buffer.from('not-a-token\nRole prompt')]);
  await assert.rejects(bootstrap(login.options),
    { message: 'SUBSCRIPTION_LOGIN_UNAVAILABLE' });
  assert.deepEqual(await readdir(join(login.root, 'io')), ['probe-sentinel']);
  const proxy = await entryFixture(t);
  proxy.options.proxyPort = 1;
  await assert.rejects(bootstrap(proxy.options), { message: 'PROBE_PROXY_UNREACHABLE' });
  assert.deepEqual(entryExit(new Error('CODEX_IDLE_TIMEOUT')),
    { exitCode: 75, stderr: 'NIBFIN_AGENT_IDLE_TIMEOUT\n' });
  assert.deepEqual(entryExit(new Error('SANDBOX_PROBE_FAILED')),
    { exitCode: 80, stderr: 'SANDBOX_PROBE_FAILED\n' });
  assert.deepEqual(entryExit(new Error('CLAUDE_RESULT_INVALID')),
    { exitCode: 1, stderr: 'NIBFIN_AGENT_ENTRY_FAILED\n' });
  assert.deepEqual(entryExit(new Error('MANAGED_PROFILE_UNSUPPORTED')),
    { exitCode: 1, stderr: 'NIBFIN_AGENT_ENTRY_FAILED\n' });
});

test('a selected project Python must match under the project tool PATH', posix,
  async t => {
    const root = await directory(t), bin = join(root, 'bin');
    await mkdir(bin);
    await script(join(bin, 'python3'), 'echo "Python 3.13.7"');
    const check = (...args) => spawnSync(process.execPath, ['-e',
      `${projectPythonCheck}checkProjectPython(); console.log('ok');`, 'h', '1',
      ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(check('3.13.7', bin).stdout, 'ok\n');
    for (const args of [['3.12.0', bin], ['3.13.7', join(root, 'empty')]]) {
      const result = check(...args);
      assert.equal(result.status, 44);
      assert.equal(result.stderr, 'NIBFIN_PROJECT_PYTHON_UNAVAILABLE\n');
    }
    assert.equal(check().stdout, 'ok\n');
    assert.deepEqual(sandboxProbeArguments('h', 1, '/n', '3.13.7', bin).slice(-4),
      ['h', '1', '3.13.7', bin]);
    assert.deepEqual(sandboxProbeArguments('h', 1, '/n').slice(-2), ['h', '1']);
  });

test('the entry passes the selected Python and tool PATH into bubblewrap', posix,
  async t => {
    const f = await entryFixture(t), log = join(f.root, 'bwrap-args');
    const invocation = join(f.root, 'input/invocation.json');
    const value = JSON.parse(await readFile(invocation, 'utf8'));
    value.plan.projectPython = '3.13.7';
    value.plan.toolEnvironment = { PATH: '/opt/nibfin/project/bin:/usr/bin' };
    await writeFile(invocation, JSON.stringify(value));
    f.options.bwrap = await script(f.options.bwrap,
      `printf '%s\n' "$@" > ${log}\necho NIBFIN_SANDBOX_DENIED`);
    await bootstrap(f.options);
    assert.deepEqual((await readFile(log, 'utf8')).trimEnd().split('\n').slice(-2),
      ['3.13.7', '/opt/nibfin/project/bin:/usr/bin']);
    const failed = await entryFixture(t);
    failed.options.bwrap = await script(failed.options.bwrap,
      'echo NIBFIN_PROJECT_PYTHON_UNAVAILABLE >&2; exit 44');
    await assert.rejects(bootstrap(failed.options), { message: 'SANDBOX_PROBE_FAILED' });
    assert.equal(entryExit(new Error('SANDBOX_PROBE_FAILED')).exitCode,
      codexPreflightExits.SANDBOX_PROBE_FAILED);
  });
