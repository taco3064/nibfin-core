import test from 'node:test';
import assert from 'node:assert/strict';
import { OfflineSandbox, rootlessInfo } from '../src/sandbox.mjs';

function fixture() {
  const config = { docker: '/usr/bin/docker', socket: '/run/user/1000/docker.sock', image: `sha256:${'a'.repeat(64)}` };
  const info = { SecurityOptions: ['name=rootless', 'name=seccomp,profile=builtin'], CgroupVersion: '2', CgroupDriver: 'systemd',
    MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true };
  const calls = []; let container, running = false, exists = false, unsafe = false, cleanupFailed = false;
  const host = { platform: 'linux', uid: 1000, realpath: async path => path, lstat: async () => ({
    isSocket: () => true, isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o600 }) };
  const run = async (executable, args, options) => {
    assert.equal(executable, config.docker); assert.deepEqual(args.slice(0, 2), ['--host', `unix://${config.socket}`]);
    assert.equal(options.env.GITHUB_TOKEN, undefined); assert.equal(options.env.DOCKER_CONTEXT, undefined);
    const cmd = args.slice(2); calls.push(cmd);
    let output;
    if (cmd[0] === 'info') output = JSON.stringify(info);
    else if (cmd[0] === 'image') output = JSON.stringify([{ Id: config.image }]);
    else if (cmd[0] === 'create') {
      exists = true;
      container = { Id: 'b'.repeat(64), Name: `/${cmd[cmd.indexOf('--name') + 1]}`, State: { Status: 'created' },
        Config: { Image: config.image, User: '0:0', Entrypoint: ['/bin/sh'], Cmd: ['-c', cmd.at(-1)] },
        HostConfig: { Privileged: unsafe, ReadonlyRootfs: true, NetworkMode: 'none', IpcMode: 'none', PidMode: '',
          Memory: 1073741824, NanoCpus: 1000000000, PidsLimit: 128, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
        Mounts: [{ Type: 'bind', Source: '/safe/work', Destination: '/work', RW: true },
          { Type: 'bind', Source: '/safe/baseline', Destination: '/baseline-git', RW: false }] };
      output = container.Id;
    } else if (cmd[0] === 'inspect') output = JSON.stringify([{ ...container, State: running ? { Running: false, ExitCode: 0, OOMKilled: false } : container.State }]);
    else if (cmd[0] === 'start') { running = true; output = 'hooks passed'; }
    else if (cmd[0] === 'ps') { if (cleanupFailed) throw new Error('Daemon disconnected'); output = exists ? 'b'.repeat(64) : ''; }
    else if (cmd[0] === 'rm') { exists = false; output = container.Id; }
    else throw new Error(`Unexpected Docker command ${cmd[0]}`);
    return { stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
  };
  return { config, info, calls, host, run, unsafe: () => { unsafe = true; }, failCleanup: () => { cleanupFailed = true; } };
}
const request = { work: '/safe/work', baseline: '/safe/baseline', script: 'exit 0', executionId: '00000000-0000-4000-8000-000000000001' };

test('offline hook profile inspects real requested constraints before starting and confirms cleanup', async () => {
  const f = fixture(); const result = await new OfflineSandbox(f.config, f).execute(request);
  assert.equal(result.status, 'passed');
  const commands = f.calls.map(call => call[0]);
  assert.ok(commands.indexOf('inspect') < commands.indexOf('start')); assert.ok(commands.includes('rm'));
  const create = f.calls.find(call => call[0] === 'create');
  assert.ok(create.includes('--network')); assert.ok(create.includes('none')); assert.ok(create.includes('--pull=never'));
  assert.equal(create.filter(arg => arg === '--mount').length, 2);
  assert.equal(create.some(arg => /auth|docker\.sock|GITHUB_TOKEN/.test(arg)), false);
});

test('rootful, missing seccomp, unenforced limits, privileged container and cleanup uncertainty refuse success', async () => {
  for (const mutate of [f => { f.info.SecurityOptions = ['name=rootless']; }, f => { f.info.CgroupVersion = '1'; },
    f => { f.info.MemoryLimit = false; }, f => { f.host.uid = 0; }]) {
    const f = fixture(); mutate(f); await assert.rejects(new OfflineSandbox(f.config, f).execute(request));
    assert.equal(f.calls.some(call => call[0] === 'start'), false);
  }
  const unsafe = fixture(); unsafe.unsafe();
  assert.equal((await new OfflineSandbox(unsafe.config, unsafe).execute(request)).status, 'denied');
  assert.equal(unsafe.calls.some(call => call[0] === 'start'), false);
  const unknown = fixture(); unknown.failCleanup();
  assert.equal((await new OfflineSandbox(unknown.config, unknown).execute(request)).code, 'WRITER_TERMINATION_UNKNOWN');
  assert.throws(() => rootlessInfo({}), /ROOTLESS_ISOLATION_UNAVAILABLE/);
});

test('unsafe, overlapping or symlink mount paths reject before Docker execution', async () => {
  for (const change of [{ work: '/' }, { work: '/safe/baseline/work' }, { baseline: '/safe/work' }, { work: '/safe/work,readonly=false' }]) {
    const f = fixture();
    if (change.work === '/') f.host.realpath = async path => path === '/' ? '/different' : path;
    await assert.rejects(new OfflineSandbox(f.config, f).execute({ ...request, ...change }));
    assert.equal(f.calls.length, 0);
  }
});
