import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CodexSandbox } from '../src/codex-sandbox.mjs';
import { digest } from '../src/identity.mjs';

async function fixture(t, fault) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-agent-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { executionId: '00000000-0000-4000-8000-000000000001',
    plan: { config: {}, requirements: 'fixed', environment: { HOME: '/session' }, writable: false } };
  request.plan.policyHash = digest({ config: {}, requirements: 'fixed' });
  for (const key of ['work', 'main', 'input', 'output', 'session']) { request[key] = join(root, key); await mkdir(request[key]); }
  request.auth = join(root, 'auth.json'); await writeFile(request.auth, '{}');
  const config = { docker: '/usr/bin/docker', socket: '/run/user/1000/docker.sock', image: `sha256:${'a'.repeat(64)}`,
    gatewayId: 'c'.repeat(64), network: 'nibfin-private', codexVersion: 'codex-cli 0.138.0',
    coreRoot: resolve('.'), proxyScript: resolve('src/egress-proxy.mjs') };
  const host = { platform: 'linux', uid: 1000, realpath: async p => p, lstat: async () => ({
    isSocket: () => true, isFile: () => true, isDirectory: () => true, uid: 1000, mode: 0o600, nlink: 1 }) };
  const calls = []; let container, exists = false, ended = false;
  const run = async (_executable, args, options) => {
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    const cmd = args.slice(2); calls.push(cmd); let value;
    if (cmd[0] === 'info') value = { SecurityOptions: ['name=rootless', 'name=seccomp,profile=builtin'],
      CgroupVersion: '2', CgroupDriver: 'systemd', MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true };
    else if (cmd[0] === 'image') value = [{ Id: config.image, Config: { Env: ['PATH=/usr/bin'] } }];
    else if (cmd[0] === 'network') value = [{ Name: config.network, Driver: 'bridge', Internal: fault !== 'public-network',
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' }, Containers: { [config.gatewayId]: {} } }];
    else if (cmd[0] === 'inspect' && cmd[1] === config.gatewayId) value = [{ Id: config.gatewayId, State: { Running: true },
      Config: { Image: config.image, Entrypoint: ['node'], Cmd: ['/proxy.mjs'], Env: ['PATH=/usr/bin'] },
      HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
      Mounts: [{ Type: 'bind', Source: config.proxyScript, Destination: '/proxy.mjs', RW: false }],
      NetworkSettings: { Networks: { [config.network]: { IPAddress: '172.20.0.2' } } } }];
    else if (cmd[0] === 'create') {
      exists = true;
      container = { Id: 'b'.repeat(64), Name: `/${cmd[cmd.indexOf('--name') + 1]}`, Image: config.image,
        AppArmorProfile: 'codex-security-container', State: { Status: 'created' }, Config: { Image: config.image, User: '1000:1000', WorkingDir: '/session',
          Entrypoint: ['/usr/local/bin/node'], Cmd: ['/input/bootstrap.mjs'],
          Env: ['PATH=/usr/bin', ...cmd.filter((_v, i) => cmd[i - 1] === '--env')] },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: config.network, IpcMode: 'none',
          Memory: 4294967296, NanoCpus: 2000000000, PidsLimit: 256, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges', `seccomp=${JSON.stringify(JSON.parse(await readFile('src/security/seccomp.json', 'utf8')))}`, 'apparmor=codex-security-container'] },
        Mounts: cmd.filter((_v, i) => cmd[i - 1] === '--mount').map(m => ({ Type: 'bind', Source: /src=([^,]+)/.exec(m)[1],
          Destination: /dst=([^,]+)/.exec(m)[1], RW: !m.includes(',readonly') })) };
      if (fault === 'apparmor') container.AppArmorProfile = 'unconfined';
      if (fault === 'root-user') container.Config.User = '0:0';
      if (fault === 'environment') container.Config.Env.push('GITHUB_TOKEN=foreign');
      if (fault === 'seccomp') container.HostConfig.SecurityOpt.push('seccomp=unconfined');
      if (fault === 'lost-create') throw new Error('Response lost');
      value = container.Id;
    } else if (cmd[0] === 'inspect') value = [{ ...container,
      State: ended ? { Running: false, ExitCode: 0, OOMKilled: false } : container.State }];
    else if (cmd[0] === 'start') {
      ended = true; value = '';
      await writeFile(join(request.output, 'probe.json'), JSON.stringify({ policyHash: request.plan.policyHash,
        codexVersion: config.codexVersion, stdout: fault === 'probe' ? 'forged' : 'NIBFIN_PROBE_PASSED\n' }));
      const stream = { stdout: 'bounded result', stderr: '', ...(fault === 'identity' ? { executionId: 'forged' } : {}) };
      const path = join(request.output, 'stream.json');
      if (fault === 'symlink') await symlink(request.auth, path); else await writeFile(path, JSON.stringify(stream));
    } else if (cmd[0] === 'ps') { if (fault === 'cleanup') throw new Error('Daemon unavailable'); value = exists ? container.Id : ''; }
    else if (cmd[0] === 'run') { if (fault === 'mapped-cleanup') throw new Error('Cleanup failed'); value = ''; }
    else if (cmd[0] === 'rm') { exists = false; value = ''; }
    else throw new Error(`Unexpected command ${cmd[0]}`);
    return { stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: Buffer.alloc(0) };
  };
  return { sandbox: new CodexSandbox(config, { host, run }), request, calls };
}

test('Agent container verifies actual policy, private outputs and proven process removal', async t => {
  const f = await fixture(t); const result = await f.sandbox.execute(f.request);
  assert.equal(result.status, 'completed'); assert.equal(result.stdout, 'bounded result');
  assert.match(result.terminationHash, /^[a-f0-9]{64}$/); assert.match(result.probeHash, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.some(c => c[0] === 'rm'));
  const mounts = f.calls.find(c => c[0] === 'create').filter(v => v.startsWith('type=bind'));
  assert.equal(mounts.length, 7); assert.ok(mounts.some(v => v.includes('dst=/work,readonly')));
});

test('changed container policy rejects before launch and uncertain cleanup remains Pending', async t => {
  for (const fault of ['environment', 'seccomp', 'apparmor', 'root-user', 'lost-create']) {
    const f = await fixture(t, fault); assert.equal((await f.sandbox.execute(f.request)).status, 'denied');
    assert.equal(f.calls.some(c => c[0] === 'start'), false); assert.ok(f.calls.some(c => c[0] === 'rm'));
  }
  const f = await fixture(t, 'cleanup'); assert.equal((await f.sandbox.execute(f.request)).status, 'pending');
  const mapped = await fixture(t, 'mapped-cleanup'); assert.equal((await mapped.sandbox.execute(mapped.request)).status, 'pending');
  const network = await fixture(t, 'public-network'); await assert.rejects(network.sandbox.execute(network.request));
  assert.equal(network.calls.some(c => c[0] === 'create'), false);
});

test('missing probe, symlink output and injected result identity cannot yield execution proof', async t => {
  for (const fault of ['probe', 'symlink', 'identity']) {
    const f = await fixture(t, fault); const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'denied'); assert.equal(result.terminationHash, undefined);
    assert.ok(f.calls.some(c => c[0] === 'rm'));
  }
});
