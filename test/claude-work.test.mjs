import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeWorkWorker, withClaudeWorkWorker } from '../src/claude-work-launcher.mjs';
import { claudeTools, claudeWorkSocket } from '../src/claude-work-channel.mjs';
import { runWorkBridge } from '../src/claude-work-bridge.mjs';
import { PassThrough, Duplex } from 'node:stream';
import { workerEnvironment } from '../src/claude-work-container.mjs';

const executionId = '00000000-0000-4000-8000-000000000001';
const image = `sha256:${'a'.repeat(64)}`;
const id = 'b'.repeat(64), gatewayId = 'c'.repeat(64);

async function fixture(stage = 'deliver') {
  const root = await mkdtemp(join(tmpdir(), 'claude-work-'));
  const admission = { executionId, stage, peer: { uid: 101001, gid: 201001 } };
  for (const name of ['work', 'main', 'input', 'session']) {
    admission[name] = join(root, name);
    await mkdir(admission[name]);
  }
  const directory = join(root, 'proxy');
  await mkdir(directory);
  for (const name of ['egress-proxy.mjs', 'claude-package-proxy.mjs'])
    await writeFile(join(directory, name), await readFile(`src/${name}`));
  const egress = { image, gatewayId, directory, network: `nibfin-work-${executionId}` };
  const namespace = { uidStart: 100000, gidStart: 200000, size: 65536 };
  const backend = { kind: 'linux-rootful-docker-v1', namespace };
  const host = { platform: 'linux', uid: 1000, gids: [200],
    rootOwnedPath: async () => {}, realpath: async path => path,
    lstat: async path => ({ isSocket: () => true,
      uid: path.endsWith('worker.sock') ? 101000 : 0,
      gid: path.endsWith('worker.sock') ? 201000 : 200,
      mode: path.endsWith('worker.sock') ? 0o666 : 0o660 }) };
  const config = { docker: '/usr/bin/docker', socket: '/run/nibfin-engine/docker.sock',
    image };
  const calls = [];
  let container, exists = false, running = false;
  const controls = { cleanupUnknown: false, lostCreate: false, unsafe: false,
    executorFails: false, contaminated: false, foreignNetwork: false };
  const run = async (exe, args, options) => {
    assert.equal(exe, config.docker);
    assert.deepEqual(args.slice(0, 2), ['--host', `unix://${config.socket}`]);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    const cmd = args.slice(2); calls.push(cmd);
    let result = '';
    const inspection = () => ({ ...container,
      State: running ? { Running: true } : { Status: 'created' } });
    if (cmd[0] === 'info') result = {
      SecurityOptions: ['name=userns', 'name=apparmor', 'name=seccomp,profile=builtin'],
      CgroupVersion: '2', CgroupDriver: 'systemd', MemoryLimit: true,
      PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
    };
    else if (cmd[0] === 'image') result = [{ Id: image, Config: { Env: [] } }];
    else if (cmd[0] === 'run') result = {
      label: 'codex-security-container (enforce)',
      uidMap: '0 100000 65536', gidMap: '0 200000 65536',
    };
    else if (cmd[0] === 'network') result = [{ Name: egress.network, Driver: 'bridge',
      Internal: true,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Containers: { [gatewayId]: {},
        ...(controls.foreignNetwork ? { foreign: {} } : {}) },
    }];
    else if (cmd[0] === 'inspect' && cmd[1] === gatewayId) result = [{
      Id: gatewayId, State: { Running: true }, Config: { Image: image, Env: [],
        Entrypoint: ['node'], Cmd: ['/proxy/claude-package-proxy.mjs'] },
      HostConfig: { Privileged: false, ReadonlyRootfs: true,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
      NetworkSettings: { Networks: { [egress.network]: { IPAddress: '172.20.0.2' } } },
      Mounts: ['egress-proxy.mjs', 'claude-package-proxy.mjs'].map(name => ({
        Type: 'bind', Source: join(directory, name), Destination: `/proxy/${name}`,
        RW: false,
      })),
    }];
    else if (cmd[0] === 'create') {
      exists = true;
      const mounts = cmd.flatMap((value, i) => value === '--mount' ? [cmd[i + 1]] : [])
        .map(value => {
          const fields = Object.fromEntries(value.split(',').map(p => p.split('=')));
          return { Type: 'bind', Source: fields.src, Destination: fields.dst,
            RW: !value.includes('readonly'), Propagation: 'rprivate' };
        });
      container = { Id: id, Name: `/${cmd[cmd.indexOf('--name') + 1]}`,
        State: { Status: 'created' }, AppArmorProfile: 'codex-security-container',
        Config: { Image: image, User: '1000:1000', WorkingDir: '/work',
          Entrypoint: ['/usr/local/bin/python3'],
          Cmd: ['-I', '-B', '/opt/nibfin/work/claude-work-worker.py'],
          Env: cmd.flatMap((value, i) => value === '--env' ? [cmd[i + 1]] : []),
        }, HostConfig: { Privileged: controls.unsafe, ReadonlyRootfs: true,
          NetworkMode: egress.network, Dns: ['127.0.0.1'], IpcMode: 'none',
          Memory: 4294967296, MemorySwap: 8589934592, NanoCpus: 2000000000,
          PidsLimit: 256, CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges', 'apparmor=codex-security-container'],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=2g,mode=1777' },
        }, Mounts: mounts, NetworkSettings: { Networks: { [egress.network]: {} } },
      };
      controls.mutate?.(container);
      if (controls.contaminated) container.Config.Env.push('ANTHROPIC_API_KEY=bad');
      if (controls.lostCreate) throw new Error('lost create response');
      result = id;
    } else if (cmd[0] === 'inspect') result = [inspection()];
    else if (cmd[0] === 'start') {
      if (controls.executorFails) throw new Error('private executor failure');
      running = true;
    } else if (cmd[0] === 'ps') {
      if (cmd.at(-1).includes('apparmor')) result = '';
      else {
        if (controls.cleanupUnknown) throw new Error('daemon unreachable');
        result = exists ? id : '';
      }
    } else if (cmd[0] === 'rm') { exists = false; running = false; }
    else throw new Error(`Unexpected command: ${cmd[0]}`);
    return { stdout: Buffer.from(typeof result === 'string' ? result :
      JSON.stringify(result)), stderr: Buffer.alloc(0) };
  };
  const worker = new ClaudeWorkWorker(config, admission, { run, host, backend, egress });
  return { worker, controls, calls, admission, root, config, host, backend, egress,
    close: () => rm(root, { recursive: true, force: true }) };
}

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
        received.push(chunk);
        callback();
        if (mode === 'response') this.push(Buffer.alloc(262145, 65));
        else this.push(Buffer.from('{"result":"ok"}\n'));
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
      assert.equal(Buffer.concat(emitted).toString(), '{"result":"ok"}\n');
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
