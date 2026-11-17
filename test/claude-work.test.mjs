import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeWorkWorker, withClaudeWorkWorker } from '../src/claude-work-launcher.mjs';
import { claudeTools, claudeWorkSocket } from '../src/claude-work-channel.mjs';
import { runWorkBridge } from '../src/claude-work-bridge.mjs';
import { PassThrough, Duplex } from 'node:stream';
import { workerEnvironment } from '../src/claude-work-container.mjs';

import { fixture } from './fixtures/claude-lifecycle.mjs';

const executionId = '00000000-0000-4000-8000-000000000001';

// Native coverage: 'src/claude-work-worker.py', 'src/claude-work-protocol.py',
// 'src/claude-work-files.py', 'src/security/claude-work.Dockerfile'.
test('native Python schemas, descriptor confinement and framing regression', () => {
  // These are native stdlib checks, not claims of Docker/host isolation.
  const result = spawnSync('python3', ['-B', 'test/fixtures/claude-work-tests.py'],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('simulated lifecycle binds role and peer and confirms settlement', async () => {
  for (const stage of ['deliver', 'shape', 'validate-shape', 'accept', 'review-pr']) {
    const f = await fixture(stage);
    try {
      assert.throws(() => f.worker.requireSettlement(), /TERMINATION_UNKNOWN/);
      const result = await f.worker.start();
      assert.equal(result.executionId, executionId);
      const admission = JSON.parse(await readFile(
        join(f.admission.session, 'work-admission.json')));
      assert.deepEqual(admission.peer, [1001, 1001]);
      assert.deepEqual(admission.operations,
        claudeTools(stage).map(tool => tool.split('__').at(-1)));
      assert.equal(admission.socket, claudeWorkSocket);
      const create = f.calls.find(cmd => cmd[0] === 'create');
      assert.ok(create.includes('--cap-drop=ALL'));
      assert.equal(create.filter(arg => arg === '--mount').length, 5);
      assert.equal(create.some(arg => /\/auth|docker.sock|ANTHROPIC/.test(arg)), false);
      assert.ok(workerEnvironment.every(value => create.includes(value)));
      assert.throws(() => f.worker.start(), /ALREADY_LAUNCHED/);
      const [first, second] = await Promise.all([f.worker.settle(), f.worker.settle()]);
      assert.deepEqual(first, second);
      assert.equal(first.status, 'terminated');
      assert.equal(f.worker.requireSettlement().executionId, executionId);
      await assert.rejects(readFile(join(f.admission.session, 'work-admission.json')));
    } finally { await f.worker.settle(); await f.close(); }
  }
});

test('simulated failures reconcile create effects and retain unknown fence', async () => {
  for (const mode of ['lostCreate', 'unsafe', 'executorFails', 'contaminated',
    'foreignNetwork']) {
    const f = await fixture();
    try {
      f.controls[mode] = true;
      await assert.rejects(f.worker.start(), /START_DENIED/);
      assert.equal((await f.worker.settle()).status, 'terminated');
      if (['unsafe', 'contaminated', 'foreignNetwork'].includes(mode))
        assert.equal(f.calls.some(cmd => cmd[0] === 'start'), false);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.worker.start();
    f.controls.cleanupUnknown = true;
    assert.equal((await f.worker.settle()).status, 'unknown');
    assert.throws(() => f.worker.requireSettlement(), /TERMINATION_UNKNOWN/);
    assert.ok(await readFile(join(f.admission.session, 'work-admission.json')));
    f.controls.cleanupUnknown = false;
    assert.equal((await f.worker.settle()).status, 'terminated');
  } finally { await f.worker.settle(); await f.close(); }
});

test('transport, peer and execution substitutions fail closed', async () => {
  await assert.rejects(runWorkBridge(null, null, '/tmp/attacker'), /ENDPOINT_DENIED/);
  const f = await fixture();
  try {
    for (const patch of [{ executionId: 'wrong' },
      { peer: { uid: 101000, gid: 201000 } }, { stage: 'owner' }]) {
      assert.throws(() => new ClaudeWorkWorker(
        f.config, { ...f.admission, ...patch },
        { backend: f.backend, egress: f.egress }));
    }
  } finally { await f.close(); }
});

test('simulated model exits always settle the worker', async () => {
  for (const mode of ['complete', 'interrupt', 'exception', 'unknown']) {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const operation = withClaudeWorkWorker(f.worker, async handoff => {
        assert.equal(handoff.executionId, executionId);
        if (mode === 'exception') throw new Error('MODEL_EXECUTOR_FAILURE');
        if (mode === 'interrupt') abort.abort();
        if (mode === 'unknown') f.controls.cleanupUnknown = true;
        return { status: mode };
      }, { signal: abort.signal });
      if (['exception', 'unknown'].includes(mode)) await assert.rejects(operation);
      else assert.equal((await operation).status, mode);
      if (mode === 'unknown')
        assert.throws(() => f.worker.requireSettlement(), /TERMINATION_UNKNOWN/);
      else assert.equal(f.worker.requireSettlement().status, 'terminated');
    } finally {
      f.controls.cleanupUnknown = false;
      await f.worker.settle();
      await f.close();
    }
  }
});

test('stdio transport forwards buffered input and bounds both directions', async () => {
  for (const mode of ['normal', 'request', 'response']) {
    const input = new PassThrough(), output = new PassThrough();
    const received = [], emitted = [];
    output.on('data', chunk => emitted.push(chunk));
    let fake;
    const dial = endpoint => {
      assert.equal(endpoint, claudeWorkSocket);
      fake = new Duplex({ read() {}, write(chunk, encoding, callback) {
        if (chunk.includes('notifications/nibfin-work-complete')) {
          callback();
          return;
        }
        received.push(chunk);
        callback();
        if (mode === 'response') this.push(Buffer.alloc(262145, 65));
        else this.push(Buffer.from('{"id":1,"result":"ok"}\n'));
      } });
      fake.setTimeout = () => {};
      queueMicrotask(() => fake.emit('connect'));
      return fake;
    };
    input.write(mode === 'request' ? Buffer.alloc(131073, 65) : '{"id":1}\n');
    const running = runWorkBridge(input, output, claudeWorkSocket, dial);
    if (mode === 'normal') {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(Buffer.concat(received).toString(), '{"id":1}\n');
      assert.equal(Buffer.concat(emitted).toString(), '{"id":1,"result":"ok"}\n');
      input.end();
      await running;
    } else {
      await assert.rejects(running, /CHANNEL_UNAVAILABLE/);
      assert.equal(Buffer.concat(emitted).length, 0);
      if (mode === 'request') assert.equal(received.length, 0);
    }
    assert.equal(fake.destroyed, true);
    input.destroy();
    output.destroy();
  }
});

test('effective isolation substitutions deny startup', async () => {
  const mutations = [
    c => { c.Mounts.find(m => m.Destination === '/work').RW = true; },
    c => { c.Mounts.push({ Source: '/auth', Destination: '/auth', RW: false }); },
    c => { c.HostConfig.PidMode = 'host'; },
    c => { c.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
    c => { c.AppArmorProfile = 'unconfined'; },
    c => { c.NetworkSettings.Networks.other = {}; },
    c => { c.HostConfig.UsernsMode = 'host'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture('accept');
    try {
      f.controls.mutate = mutate;
      await assert.rejects(f.worker.start(), /START_DENIED/);
      assert.equal(f.calls.some(call => call[0] === 'start'), false);
      assert.equal((await f.worker.settle()).status, 'terminated');
    } finally { await f.close(); }
  }
});

test('bridge rejects premature closure and incomplete exchanges', async () => {
  for (const mode of ['close', 'error', 'partial-request', 'partial-response',
    'unanswered', 'forged-completion']) {
    const input = new PassThrough(), output = new PassThrough();
    let fake;
    const dial = () => {
      fake = new Duplex({ read() {}, write(chunk, encoding, callback) {
        callback();
        if (mode === 'partial-response') this.push('{"id":1');
      } });
      fake.setTimeout = () => {};
      queueMicrotask(() => fake.emit('connect'));
      return fake;
    };
    const running = runWorkBridge(input, output, claudeWorkSocket, dial);
    const rejected = assert.rejects(running, /CHANNEL_UNAVAILABLE/);
    input.write(mode === 'partial-request' ? '{"id":' :
      mode === 'forged-completion' ?
        '{"jsonrpc":"2.0","method":"notifications/nibfin-work-complete"}\n' :
        '{"id":1}\n');
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'close') fake.destroy();
    else if (mode === 'error') fake.destroy(new Error('private transport'));
    else input.end();
    await rejected;
    input.destroy();
    output.destroy();
  }
});
