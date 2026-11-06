import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CodexSandbox } from '../src/codex-sandbox.mjs';
import { digest } from '../src/identity.mjs';
import { dockerBackend, rootfulSocket } from '../src/docker-backend.mjs';
import { inheritUserMcp } from '../src/mcp-profile.mjs';

async function fixture(t, fault, rootful = false, mcp = false) {
  const seccomp = JSON.parse(await readFile('src/security/seccomp.json', 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'nibfin-agent-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = {
    executionId: '00000000-0000-4000-8000-000000000001',
    plan: {
      config: {},
      requirements: 'fixed',
      environment: { HOME: '/session' },
      writable: false,
    },
  };
  request.plan.policyHash = digest({ config: {}, requirements: 'fixed' });
  for (const key of ['work', 'main', 'input', 'output', 'session']) {
    request[key] = join(root, key);
    await mkdir(request[key]);
  }
  request.auth = join(root, 'auth.json');
  await writeFile(request.auth, '{}');
  const config = {
    docker: '/usr/bin/docker',
    socket: rootful ? rootfulSocket : '/run/user/1000/docker.sock',
    image: `sha256:${'a'.repeat(64)}`,
    gatewayId: 'c'.repeat(64),
    network: 'nibfin-private',
    codexVersion: 'codex-cli 0.138.0',
    coreRoot: resolve('.'),
    proxyScript: resolve('src/egress-proxy.mjs'),
  };
  if (mcp) {
    config.mcpPolicyDirectory = join(root, 'mcp-policy');
    await mkdir(config.mcpPolicyDirectory, { mode: 0o755 });
    request.mcp = inheritUserMcp({ notion: {
      url: 'https://mcp.notion.com/mcp',
      http_headers: { Authorization: 'Bearer private-mcp-token' },
    } });
    request.plan.mcpPolicyHash = request.mcp.policyHash;
  }
  const host = {
    platform: 'linux',
    uid: 1000,
    gids: [986],
    rootOwnedPath: async () => {},
    realpath: async (p) => p,
    lstat: async () => ({
      isSocket: () => true,
      isFile: () => true,
      isDirectory: () => true,
      uid: rootful ? 0 : 1000,
      gid: 986,
      mode: rootful ? 0o660 : 0o600,
      nlink: 1,
    }),
  };
  const calls = [];
  let container,
    exists = false,
    ended = false;
  const run = async (_executable, args, options) => {
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    const cmd = args.slice(2);
    calls.push(cmd);
    let value;
    if (cmd[0] === 'info')
      value = {
        SecurityOptions: [
          'name=seccomp,profile=builtin',
          ...(rootful ? ['name=userns', 'name=apparmor'] : ['name=rootless']),
        ],
        CgroupVersion: '2',
        CgroupDriver: 'systemd',
        MemoryLimit: true,
        PidsLimit: true,
        CpuCfsPeriod: true,
        CpuCfsQuota: true,
      };
    else if (cmd[0] === 'image')
      value = [{ Id: config.image, Config: { Env: ['PATH=/usr/bin'] } }];
    else if (cmd[0] === 'network')
      value = [
        {
          Name: config.network,
          Driver: 'bridge',
          Internal: fault !== 'public-network',
          Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
          Containers: { [config.gatewayId]: {} },
        },
      ];
    else if (cmd[0] === 'inspect' && cmd[1] === config.gatewayId)
      value = [
        {
          Id: config.gatewayId,
          State: { Running: true },
          Config: {
            Image: config.image,
            Entrypoint: ['node'],
            Cmd: ['/proxy.mjs'],
            Env: ['PATH=/usr/bin', ...(mcp ?
              ['NIBFIN_MCP_POLICY_DIRECTORY=/mcp-policy'] : [])]
              .sort()
              .concat(fault === 'gateway-env-extra' ? ['FOREIGN=1'] : [])
              .concat(fault === 'gateway-env-duplicate' ? ['PATH=/usr/bin'] : []),
          },
          HostConfig: {
            UsernsMode: fault === 'gateway-host-userns' ? 'host' : '',
            Privileged: false,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
          },
          Mounts: [
            ...(mcp ? [{ Type: 'bind', Source: config.mcpPolicyDirectory,
              Destination: '/mcp-policy', RW: false }] : []),
            {
              Type: 'bind',
              Source: config.proxyScript,
              Destination: '/proxy.mjs',
              RW: false,
            },
          ],
          NetworkSettings: {
            Networks: { [config.network]: { IPAddress: '172.20.0.2' } },
          },
        },
      ];
    else if (cmd[0] === 'create') {
      if (mcp) {
        assert.ok(!JSON.stringify(cmd).includes('private-mcp-token'));
        const invocation = await readFile(join(request.input, 'invocation.json'));
        assert.ok(!invocation.toString().includes('private-mcp-token'));
        const policy = JSON.parse(await readFile(
          join(config.mcpPolicyDirectory, 'current.json'), 'utf8'));
        assert.deepEqual(policy.hosts, ['mcp.notion.com']);
      }
      exists = true;
      container = {
        Id: 'b'.repeat(64),
        Name: `/${cmd[cmd.indexOf('--name') + 1]}`,
        Image: config.image,
        AppArmorProfile: 'codex-security-container',
        State: { Status: 'created' },
        Config: {
          Image: config.image,
          User: '1000:1000',
          WorkingDir: '/session',
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['/input/bootstrap.mjs'],
          Env: ['PATH=/usr/bin', ...cmd.filter((_v, i) => cmd[i - 1] === '--env')],
        },
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          NetworkMode: config.network,
          IpcMode: 'none',
          Memory: 4294967296,
          NanoCpus: 2000000000,
          PidsLimit: 256,
          CapDrop: ['ALL'],
          SecurityOpt: [
            'no-new-privileges',
            `seccomp=${JSON.stringify(seccomp)}`,
            'apparmor=codex-security-container',
          ],
        },
        Mounts: cmd
          .filter((_v, i) => cmd[i - 1] === '--mount')
          .map((m) => ({
            Type: 'bind',
            Source: /src=([^,]+)/.exec(m)[1],
            Destination: /dst=([^,]+)/.exec(m)[1],
            RW: !m.includes(',readonly'),
          })),
      };
      if (fault === 'apparmor') container.AppArmorProfile = 'unconfined';
      if (fault === 'root-user') container.Config.User = '0:0';
      if (fault === 'environment') container.Config.Env.push('GITHUB_TOKEN=foreign');
      if (fault === 'seccomp')
        container.HostConfig.SecurityOpt.push('seccomp=unconfined');
      if (fault === 'lost-create') throw new Error('Response lost');
      value = container.Id;
    } else if (cmd[0] === 'inspect')
      value = [
        {
          ...container,
          State: ended
            ? { Running: false, ExitCode: 0, OOMKilled: false }
            : container.State,
        },
      ];
    else if (cmd[0] === 'start') {
      ended = true;
      value = '';
      await writeFile(
        join(request.output, 'probe.json'),
        JSON.stringify({
          policyHash: request.plan.policyHash,
          codexVersion: config.codexVersion,
          stdout: fault === 'probe' ? 'forged' : 'NIBFIN_PROBE_PASSED\n',
        }),
      );
      const stream = {
        stdout: 'bounded result',
        stderr: '',
        ...(fault === 'identity' ? { executionId: 'forged' } : {}),
      };
      const path = join(request.output, 'stream.json');
      if (fault === 'symlink') await symlink(request.auth, path);
      else await writeFile(path, JSON.stringify(stream));
    } else if (cmd[0] === 'ps' && cmd.at(-1).includes('nibfin-apparmor-')) value = '';
    else if (cmd[0] === 'ps') {
      if (fault === 'cleanup') throw new Error('Daemon unavailable');
      value = exists ? container.Id : '';
    } else if (cmd[0] === 'run' && cmd.includes('--name')) {
      value =
        fault === 'ignored-apparmor'
          ? 'rootlesskit (unconfined)'
          : fault === 'complain-apparmor'
            ? 'codex-security-container (complain)'
            : 'codex-security-container (enforce)';
      if (rootful)
        value = JSON.stringify({
          label: value,
          uidMap: '0 231072 65536',
          gidMap: '0 231072 65536',
        });
    } else if (cmd[0] === 'run') {
      if (fault === 'mapped-cleanup') throw new Error('Cleanup failed');
      value = '';
    } else if (cmd[0] === 'rm') {
      exists = false;
      value = '';
    } else throw new Error(`Unexpected command ${cmd[0]}`);
    return {
      stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
      stderr: Buffer.alloc(0),
    };
  };
  const backend = rootful
    ? dockerBackend({
        kind: 'linux-rootful-docker-v1',
        namespace: { uidStart: 231072, gidStart: 231072, size: 65536 },
      })
    : undefined;
  return { sandbox: new CodexSandbox(config, { host, run, backend }),
    request, calls, config };
}

test('rootful gateway cannot override the adopted user namespace', async (t) => {
  const positive = await fixture(t, undefined, true);
  await positive.sandbox.preflight();
  const changed = await fixture(t, 'gateway-host-userns', true);
  await assert.rejects(changed.sandbox.preflight(), /AGENT_EGRESS_NOT_ISOLATED/);
  assert.equal(
    changed.calls.some((c) => c[0] === 'create'),
    false,
  );
});

test('MCP gateway ignores Env order but rejects additions and duplicate keys', async t => {
  const reordered = await fixture(t, 'gateway-env-order', true, true);
  await reordered.sandbox.preflight();
  for (const fault of ['gateway-env-extra', 'gateway-env-duplicate']) {
    const changed = await fixture(t, fault, true, true);
    await assert.rejects(changed.sandbox.preflight(), /AGENT_EGRESS_NOT_ISOLATED/);
  }
});

test('Agent policy, private outputs and termination are verified', async (t) => {
  const f = await fixture(t);
  const result = await f.sandbox.execute(f.request);
  assert.equal(result.status, 'completed');
  assert.equal(result.stdout, 'bounded result');
  assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
  assert.match(result.probeHash, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.some((c) => c[0] === 'rm'));
  const mounts = f.calls
    .find((c) => c[0] === 'create')
    .filter((v) => v.startsWith('type=bind'));
  assert.equal(mounts.length, 7);
  assert.ok(mounts.some((v) => v.includes('dst=/work,readonly')));
});

test('Policy changes deny launch and unknown cleanup remains Pending', async (t) => {
  for (const fault of [
    'environment',
    'seccomp',
    'apparmor',
    'root-user',
    'lost-create',
  ]) {
    const f = await fixture(t, fault);
    assert.equal((await f.sandbox.execute(f.request)).status, 'denied');
    assert.equal(
      f.calls.some((c) => c[0] === 'start'),
      false,
    );
    assert.ok(f.calls.some((c) => c[0] === 'rm'));
  }
  const f = await fixture(t, 'cleanup');
  assert.equal((await f.sandbox.execute(f.request)).status, 'pending');
  const mapped = await fixture(t, 'mapped-cleanup');
  assert.equal((await mapped.sandbox.execute(mapped.request)).status, 'pending');
  const network = await fixture(t, 'public-network');
  await assert.rejects(network.sandbox.execute(network.request));
  assert.equal(
    network.calls.some((c) => c[0] === 'create'),
    false,
  );
});

test('Missing probe, symlinks and forged identity deny execution proof', async (t) => {
  for (const fault of ['probe', 'symlink', 'identity']) {
    const f = await fixture(t, fault);
    const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'denied');
    assert.equal(result.terminationHash, undefined);
    assert.ok(f.calls.some((c) => c[0] === 'rm'));
  }
});

test('ignored or non-enforcing AppArmor denies before credential copies', async (t) => {
  for (const fault of ['ignored-apparmor', 'complain-apparmor']) {
    const f = await fixture(t, fault);
    await assert.rejects(f.sandbox.execute(f.request), {
      message: 'AGENT_APPARMOR_NOT_ENFORCED',
    });
    assert.equal(
      f.calls.some((c) => c[0] === 'create'),
      false,
    );
    for (const path of [f.request.session, f.request.input, f.request.output]) {
      assert.deepEqual(await readdir(path), []);
    }
  }
});

test('MCP private mount and egress lease retire only after proven termination', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, undefined, false, true);
  assert.equal((await f.sandbox.execute(f.request)).status, 'completed');
  assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), []);
  const mounts = f.calls.find(c => c[0] === 'create')
    .filter(v => v.startsWith('type=bind'));
  assert.ok(mounts.some(v => v.includes('dst=/auth/mcp.toml,readonly')));
  const uncertain = await fixture(t, 'cleanup', false, true);
  assert.equal((await uncertain.sandbox.execute(uncertain.request)).status, 'pending');
  assert.deepEqual(await readdir(uncertain.config.mcpPolicyDirectory), ['current.json']);
});
