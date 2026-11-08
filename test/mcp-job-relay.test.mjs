import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { sha256 } from '../src/identity.mjs';
import { mcpRequest, encodeMcpFrame } from '../src/mcp-job-codec.mjs';

// Synthetic process fixtures change only fixed adoption paths/owner in a
// disposable source copy. These do not prove production root ownership or WSL.
async function relayFixture(t, wrongPeer) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-relay-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'socket'), source = join(root, 'relay.pl');
  await mkdir(directory, { mode: 0o700 });
  let code = await readFile(new URL('../src/mcp-job-relay.pl', import.meta.url),
    'utf8');
  const uid = process.getuid(), gid = process.getgid();
  code = code.replaceAll('/etc/nibfin', root)
    .replaceAll('/run/nibfin-mcp', directory)
    .replaceAll("'/run'", JSON.stringify(root))
    .replaceAll('/opt/nibfin/core/src/mcp-job-relay.pl', source)
    .replace('$> == 0', `$> == ${uid}`)
    .replace('$s[4] == 0',
      `($name eq '/usr/bin/perl' || $s[4] == 0 || $s[4] == ${uid})`)
    .replace('$s[4] == 0 && ($s[2] & 0777)',
      `$s[4] == ${uid} && ($s[2] & 0777)`)
    .replace('chown(0,', `chown(${uid},`)
    .replace('$uid == 0 && $gid == 0', `$uid == ${uid} && $gid == ${gid}`)
    .replace('die "MCP_JOB_RELAY_REJECTED\\n"',
      'die "fixture check line ".(caller)[2].": $!\\n"')
    .replace('print STDERR "MCP_JOB_RELAY_UNRESOLVED\\n";', 'print STDERR $@;');
  await writeFile(source, code, { mode: 0o600 });
  await writeFile(join(root, 'mcp-relay.json'), JSON.stringify({
    controllerUid: wrongPeer ? uid + 1 : uid, controllerGid: gid,
    memberId: 2, repositoryId: 1, runnerId: 3, directory,
    perlHash: sha256(await readFile('/usr/bin/perl')), relayHash: sha256(code),
  }), { mode: 0o600 });
  const child = spawn('/usr/bin/perl', [source], {
    env: {}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false, diagnostics = '', forwarded = '';
  child.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  child.stdout.on('data', bytes => { forwarded += bytes.toString(); });
  const exited = new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', code => { closed = true; yes(code); });
  });
  t.after(() => { child.stdin.destroy(); child.kill(); });
  const path = join(directory, 'job.sock');
  for (let i = 0; i < 100; i++) {
    try { if ((await stat(path)).isSocket()) break; } catch {}
    assert.equal(closed, false, `relay exited before readiness: ${diagnostics}`);
    await setTimeout(20);
  }
  assert.ok((await stat(path)).isSocket());
  return { child, exited, path, source, forwarded: () => forwarded };
}

const linux = { skip: process.platform !== 'linux', timeout: 10000 };
test('finite relay admits kernel peer and forwards exactly one private exchange',
  linux, async t => {
    const f = await relayFixture(t, false);
    const socket = connect({ path: f.path, allowHalfOpen: true });
    t.after(() => socket.destroy());
    const response = [];
    socket.on('data', bytes => response.push(bytes));
    const ended = new Promise((yes, no) => {
      socket.once('end', yes);
      socket.once('error', no);
    });
    const binding = { repositoryId: 1, memberId: 2, runnerId: 3,
      runId: 4, attempt: 1, jobId: 5 };
    const request = mcpRequest(binding, 'a'.repeat(64));
    socket.write(encodeMcpFrame(request));
    for (let i = 0; i < 100 && !f.forwarded(); i++) await setTimeout(10);
    assert.deepEqual(JSON.parse(f.forwarded()), request);
    const reply = { ...request, delegation: { synthetic: true }, terminated: true };
    const upload = spawn('/usr/bin/perl', [f.source, '--response'], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let acknowledgement = '';
    upload.stdout.on('data', bytes => { acknowledgement += bytes; });
    const uploaded = new Promise((yes, no) => {
      upload.once('error', no);
      upload.once('close', yes);
    });
    upload.stdin.end(encodeMcpFrame(reply));
    assert.equal(await uploaded, 0);
    assert.equal(acknowledgement, 'NIBFIN_MCP_RESPONSE_STAGED\n');
    // Staging and producer termination alone release no secret response.
    assert.equal(Buffer.concat(response).toString().trim().split('\n').length, 1);
    f.child.stdin.end('NIBFIN_WINDOWS_MCP_OUTER_TERMINATED\n');
    await ended;
    socket.end();
    assert.equal(await f.exited, 0);
    const lines = Buffer.concat(response).toString().trim().split('\n').map(JSON.parse);
    assert.equal(typeof lines[0].relayPid, 'number');
    assert.deepEqual(lines[1], { ...reply, nativeTerminated: true });
    await assert.rejects(stat(f.path), { code: 'ENOENT' });
  });

test('wrong kernel peer reaches no native producer and receives no delegated bytes',
  linux, async t => {
    const f = await relayFixture(t, true);
    const socket = connect(f.path);
    t.after(() => socket.destroy());
    let output = '';
    socket.on('data', bytes => { output += bytes.toString(); });
    socket.on('error', () => {});
    assert.equal(await f.exited, 1);
    assert.equal(f.forwarded(), '');
    assert.equal(output, '');
  });

for (const control of ['', 'NIBFIN_WINDOWS_MCP_TERMINATED\n',
  'NIBFIN_WINDOWS_MCP_OUTER_TERMINATED\nextra\n']) {
  test(`staged response cannot replace outer control proof: ${JSON.stringify(control)}`,
    linux, async t => {
      const f = await relayFixture(t, false);
      const socket = connect({ path: f.path, allowHalfOpen: true });
      t.after(() => socket.destroy());
      let received = '';
      socket.on('data', bytes => { received += bytes; });
      socket.on('error', () => {});
      const binding = { repositoryId: 1, memberId: 2, runnerId: 3,
        runId: 4, attempt: 1, jobId: 5 };
      const request = mcpRequest(binding, 'a'.repeat(64));
      socket.write(encodeMcpFrame(request));
      for (let i = 0; i < 100 && !f.forwarded(); i++) await setTimeout(10);
      const upload = spawn('/usr/bin/perl', [f.source, '--response'], {
        env: {}, stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => upload.kill());
      upload.stdout.resume();
      upload.stderr.resume();
      const uploaded = new Promise((yes, no) => {
        upload.once('error', no);
        upload.once('close', yes);
      });
      upload.stdin.end(encodeMcpFrame({ ...request,
        delegation: { secret: 'synthetic-only' }, terminated: true }));
      assert.equal(await uploaded, 0);
      f.child.stdin.end(control);
      assert.equal(await f.exited, 1);
      assert.equal(received.includes('synthetic-only'), false);
      assert.equal(received.trim().split('\n').length, 1);
      assert.ok((await stat(f.path)).isSocket());
    });
}

test('request EOF cancels a pending exchange without claiming native termination',
  linux, async t => {
    const f = await relayFixture(t, false);
    const socket = connect({ path: f.path, allowHalfOpen: true });
    t.after(() => socket.destroy());
    let response = '';
    socket.on('data', bytes => { response += bytes; });
    socket.on('error', () => {});
    socket.write(encodeMcpFrame(mcpRequest({ repositoryId: 1, memberId: 2,
      runnerId: 3, runId: 4, attempt: 1, jobId: 5 }, 'a'.repeat(64))));
    for (let i = 0; i < 100 && !f.forwarded(); i++) await setTimeout(10);
    socket.end();
    assert.equal(await f.exited, 1);
    assert.equal(response.includes('nativeTerminated'), false);
    assert.ok((await stat(f.path)).isSocket());
  });
