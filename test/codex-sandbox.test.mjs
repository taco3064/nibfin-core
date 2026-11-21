import { pressureFixture } from './host-pressure-fixture.mjs';
import { hostMemoryPressure } from '../src/host-memory-pressure.mjs';
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
  chmod,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { CodexSandbox } from '../src/codex-sandbox.mjs';
import { digest, sha256 } from '../src/identity.mjs';
import { dockerBackend, rootfulSocket } from '../src/docker-backend.mjs';
import { inheritUserMcp } from '../src/mcp-profile.mjs';
import { claudePolicyHash } from '../src/claude-agent-plan.mjs';

const claudeToken = 'sk-ant-oat01-' + 'f'.repeat(40);

async function fixture(t, fault, rootful = false, mcp = false, project = false,
  pressureObserver, provider = 'codex') {
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
    image: `sha256:${(fault === 'selected-image' ? 'b' : 'a').repeat(64)}`,
    gatewayId: 'c'.repeat(64),
    network: 'nibfin-private',
    codexVersion: 'codex-cli 0.138.0',
    coreRoot: resolve('.'),
    proxyScript: resolve('src/egress-proxy.mjs'),
  };
  if (mcp || project) {
    config.mcpPolicyDirectory = join(root, 'mcp-policy');
    await mkdir(config.mcpPolicyDirectory, { mode: 0o755 });
  }
  if (project) {
    config.additionalDomains = ['API.Example.com'];
    request.plan.additionalDomains = ['api.example.com'];
  }
  if (mcp) {
    request.mcp = inheritUserMcp({ notion: {
      url: 'https://mcp.notion.com/mcp',
      http_headers: { Authorization: 'Bearer private-mcp-token' },
    } });
    request.plan.mcpPolicyHash = request.mcp.policyHash;
  }
  if (provider === 'claude') {
    config.provider = 'claude';
    config.codexVersion = '2.1.326 (Claude Code)';
    const { additionalDomains } = request.plan;
    request.plan = { provider: 'claude', args: ['-p'], prompt: 'Role prompt',
      environment: { HOME: '/agent-home' }, writable: false,
      toolEnvironment: { PATH: '/bin', LANG: 'C.UTF-8' },
      ...(additionalDomains ? { additionalDomains } : {}) };
    request.plan.policyHash = claudePolicyHash(request.plan);
    delete request.auth;
    request.credential = claudeToken;
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
  const calls = [], startOptions = [];
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
      value = [{ Id: cmd[2], Config: { Env: [cmd[2] === config.image
        ? 'PATH=/usr/bin' : 'PATH=/usr/local/bin:/usr/bin'] } }];
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
            Image: fault === 'selected-image' ? gatewayImage : config.image,
            Entrypoint: [fault === 'gateway-entrypoint'
              ? '/usr/local/bin/node' : 'node'],
            Cmd: ['/proxy.mjs'],
            Env: [fault === 'selected-image' ? 'PATH=/usr/local/bin:/usr/bin'
              : 'PATH=/usr/bin', ...((mcp || project) ?
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
            ...(fault === 'gateway-mount-extra' ? [{ Type: 'bind',
              Source: '/unexpected', Destination: '/unexpected', RW: false }] : []),
            ...((mcp || project) ? [{ Type: 'bind', Source: config.mcpPolicyDirectory,
              Destination: '/mcp-policy', RW: fault === 'gateway-mount-writable' }] : []),
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
      if (project) {
        const policy = JSON.parse(await readFile(
          join(config.mcpPolicyDirectory, 'project.json'), 'utf8'));
        assert.deepEqual(policy.hosts, ['api.example.com']);
        assert.ok(!JSON.stringify(cmd).includes('dst=/mcp-policy'));
        if (fault === 'project-tamper') {
          await chmod(join(config.mcpPolicyDirectory, 'project.json'), 0o644);
        }
      }
      exists = true;
      const profile = cmd.find(v => v.startsWith('--security-opt=apparmor='))
        .slice('--security-opt=apparmor='.length);
      const stdin = cmd.includes('--interactive');
      container = {
        Id: 'b'.repeat(64),
        Name: `/${cmd[cmd.indexOf('--name') + 1]}`,
        Image: config.image,
        AppArmorProfile: profile,
        State: { Status: 'created' },
        Config: {
          Image: config.image,
          User: '1000:1000',
          WorkingDir: '/session',
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['/input/bootstrap.mjs'],
          OpenStdin: stdin,
          StdinOnce: stdin && fault !== 'stdin-once',
          Env: ['PATH=/usr/bin', ...cmd.filter((_v, i) => cmd[i - 1] === '--env')],
        },
        HostConfig: {
          Tmpfs: { '/tmp': cmd[cmd.indexOf('--tmpfs') + 1].slice('/tmp:'.length) },
          Init: cmd.includes('--init') && fault !== 'missing-init',
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
            `apparmor=${profile}`,
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
      if (fault === 'scratch-owner') container.HostConfig.Tmpfs['/tmp'] = 'rw,mode=1777';
      if (fault === 'seccomp')
        container.HostConfig.SecurityOpt.push('seccomp=unconfined');
      if (fault === 'lost-create') throw new Error('Response lost');
      value = container.Id;
    } else if (cmd[0] === 'inspect') {
      if (fault === 'ownership-timeout' && container.State.Running && !ended)
        throw Object.assign(new Error('Timed out'), { code: 'PROCESS_TIMEOUT' });
      value = [
        {
          ...container,
          State: ended
            ? {
              Running: false,
              ExitCode: { idle: 75, 'missing-login': 81 }[fault] ?? 0,
              OOMKilled: false,
            }
            : container.State,
        },
      ];
    } else if (cmd[0] === 'start') {
      startOptions.push(options);
      if (fault === 'ownership-timeout') {
        container.State = { Running: true };
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (fault === 'timeout') {
        throw Object.assign(new Error('Timed out'), { code: 'PROCESS_TIMEOUT' });
      }
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
      const profile = cmd.find(v => v.startsWith('--security-opt=apparmor='))
        .slice('--security-opt=apparmor='.length);
      value =
        fault === 'ignored-apparmor'
          ? 'rootlesskit (unconfined)'
          : fault === 'complain-apparmor'
            ? `${profile} (complain)`
            : `${profile} (enforce)`;
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
      stderr: Buffer.from(cmd[0] === 'start' && fault === 'idle' ?
        'NIBFIN_IDLE_PROGRESS tool running\n' : ''),
    };
  };
  if (fault === 'source-changed') {
    config.proxyScript = join(root, 'changed-proxy.mjs');
    await writeFile(config.proxyScript, '// changed');
  }
  if (fault === 'project-unadopted') delete config.mcpPolicyDirectory;
  const backend = rootful
    ? dockerBackend({
        kind: 'linux-rootful-docker-v1',
        namespace: { uidStart: 231072, gidStart: 231072, size: 65536 },
      })
    : undefined;
  const gatewayImage = `sha256:${'a'.repeat(64)}`;
  return { sandbox: new CodexSandbox(config, { host, run, backend,
    ...(pressureObserver ? { pressureObserver } : {}),
    ...(fault === 'selected-image' ? { gatewayImage } : {}) }),
    request, calls, config, startOptions };
}

// Normalizes only per-run random names and fixture directories.
function goldenText(f, value) {
  return JSON.stringify(value)
    .replaceAll(dirname(f.request.work), '<root>')
    .replaceAll(f.config.coreRoot, '<core>')
    .replace(/nibfin-(agent|apparmor)-[a-f0-9-]{36}/g, 'nibfin-$1-<id>')
    .replace(/agent-auth-[A-Za-z0-9]+/g, 'agent-auth-<id>');
}

async function codexGolden(t) {
  const f = await fixture(t);
  const result = await f.sandbox.execute(f.request);
  const m = await fixture(t, undefined, true, true, true);
  const combined = await m.sandbox.execute(m.request);
  return {
    status: [result.status, combined.status],
    create: JSON.parse(goldenText(f, f.calls.find(c => c[0] === 'create'))),
    calls: sha256(goldenText(f, f.calls)),
    start: JSON.parse(goldenText(f, f.startOptions)),
    invocation: await readFile(join(f.request.input, 'invocation.json'), 'utf8'),
    inputs: (await readdir(f.request.input)).sort(),
    modes: Object.fromEntries(await Promise.all((await readdir(f.request.input))
      .sort().map(async name => [name,
        ((await stat(join(f.request.input, name))).mode & 0o777).toString(8)]))),
    combinedCalls: sha256(goldenText(m, m.calls)),
  };
}

// Captured from origin/main before the Claude provider branch was added.
test('Codex container argv, mounts, env and invocation stay byte-identical',
  async t => {
    const golden = JSON.parse(await readFile(
      new URL('./fixtures/codex-sandbox-golden.json', import.meta.url), 'utf8'));
    assert.deepEqual(await codexGolden(t), golden);
  });

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

test('gateway entrypoint must match the production contract', async t => {
  const positive = await fixture(t);
  await positive.sandbox.preflight();
  const changed = await fixture(t, 'gateway-entrypoint');
  await assert.rejects(changed.sandbox.preflight(), /AGENT_EGRESS_NOT_ISOLATED/);
  assert.equal(changed.calls.some(call => call[0] === 'create'), false);
});

test('MCP gateway rejects added or duplicate Env keys, tolerates order', async t => {
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
  const create = f.calls.find((c) => c[0] === 'create');
  assert.equal(create[create.indexOf('--tmpfs') + 1],
    '/tmp:rw,exec,nosuid,nodev,size=2g,mode=0700,uid=1000,gid=1000');
  const mounts = f.calls
    .find((c) => c[0] === 'create')
    .filter((v) => v.startsWith('type=bind'));
  assert.equal(mounts.length, 7);
  assert.ok(mounts.some((v) => v.includes('dst=/work,readonly')));
});

test('Policy changes deny launch and unknown cleanup remains Pending', async (t) => {
  for (const fault of [
    'environment',
    'scratch-owner',
    'seccomp',
    'apparmor',
    'root-user',
    'missing-init',
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

test('a timeout with confirmed container cleanup carries termination proof', async t => {
  const f = await fixture(t, 'timeout');
  const result = await f.sandbox.execute(f.request);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.code, 'PROCESS_TIMEOUT');
  assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.some(c => c[0] === 'rm'));
});

test('idle and failed startup are reported after confirmed cleanup', async (t) => {
  for (const [fault, code] of [
    ['idle', 'CODEX_IDLE_TIMEOUT'],
    ['missing-login', 'SUBSCRIPTION_LOGIN_UNAVAILABLE'],
  ]) {
    const f = await fixture(t, fault);
    const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.code, code);
    assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
    assert.ok(f.calls.some((c) => c[0] === 'rm'));
  }
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
  const result = await f.sandbox.execute(f.request);
  assert.equal(result.status, 'completed');
  // Native absence alone is insufficient: the MCP wrapper scans outputs
  // before calling this capability to retire private configuration/leases.
  assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), ['current.json']);
  await result.retireMcp();
  assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), []);
  const mounts = f.calls.find(c => c[0] === 'create')
    .filter(v => v.startsWith('type=bind'));
  assert.ok(mounts.some(v => v.includes('dst=/auth/mcp.toml,readonly')));
  const uncertain = await fixture(t, 'cleanup', false, true);
  assert.equal((await uncertain.sandbox.execute(uncertain.request)).status, 'pending');
  assert.deepEqual(await readdir(uncertain.config.mcpPolicyDirectory),
    ['current.json', 'project.json']);
});

test('project leases retire after proven cleanup for each outcome', async t => {
  for (const fault of [undefined, 'lost-create', 'environment', 'timeout',
    'missing-login', 'probe']) {
    const f = await fixture(t, fault, false, false, true);
    const result = await f.sandbox.execute(f.request);
    const expected = fault === undefined ? 'completed' :
      ['timeout', 'missing-login'].includes(fault) ? 'interrupted' : 'denied';
    assert.equal(result.status, expected, fault);
    assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), [], fault);
  }
  for (const fault of ['cleanup', 'project-tamper']) {
    const f = await fixture(t, fault, false, false, true);
    assert.equal((await f.sandbox.execute(f.request)).status, 'pending');
    assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), ['project.json']);
    const creates = f.calls.filter(c => c[0] === 'create').length;
    await assert.rejects(f.sandbox.execute(f.request));
    assert.equal(f.calls.filter(c => c[0] === 'create').length, creates);
  }
});

test('project policy binds the plan and stays outside Agent mounts', async t => {
  const f = await fixture(t, undefined, false, false, true);
  f.request.plan.additionalDomains = ['other.example.com'];
  await assert.rejects(f.sandbox.execute(f.request), /PROJECT_EGRESS_PLAN_CHANGED/);
  assert.equal(f.calls.some(c => c[0] === 'create'), false);
  const combined = await fixture(t, undefined, false, true, true);
  const result = await combined.sandbox.execute(combined.request);
  assert.equal(result.status, 'completed');
  assert.deepEqual(await readdir(combined.config.mcpPolicyDirectory), ['current.json']);
  await result.retireMcp();
  assert.deepEqual(await readdir(combined.config.mcpPolicyDirectory), []);
});

test('required project policy rejects missing adoption and stale ownership', async t => {
  const absent = await fixture(t, 'project-unadopted', false, false, true);
  await assert.rejects(absent.sandbox.execute(absent.request),
    /PROJECT_EGRESS_NOT_ADOPTED/);
  for (const requested of [false, true]) {
    const f = await fixture(t, undefined, false, true, requested);
    await writeFile(join(f.config.mcpPolicyDirectory, 'project.json'), '{}',
      { mode: 0o444 });
    assert.equal((await f.sandbox.execute(f.request)).status, 'denied');
    assert.equal(f.calls.some(c => c[0] === 'create'), false);
    assert.equal(await readFile(join(f.config.mcpPolicyDirectory, 'project.json'),
      'utf8'), '{}');
  }
});

test('project gateway keeps source, environment, mount and isolation checks', async t => {
  for (const fault of ['source-changed', 'gateway-env-extra', 'gateway-env-duplicate',
    'gateway-mount-extra', 'gateway-mount-writable', 'public-network']) {
    const f = await fixture(t, fault, false, false, true);
    await assert.rejects(f.sandbox.preflight(),
      fault === 'source-changed' ? /EGRESS_SOURCE_CHANGED/ : /AGENT_EGRESS_NOT_ISOLATED/);
    assert.equal(f.calls.some(c => c[0] === 'create'), false);
  }
});

test('prepared Agent image retains the fixed gateway image and environment', async t => {
  const f = await fixture(t, 'selected-image');
  const proof = await f.sandbox.preflight();
  assert.equal(proof.imageId, f.config.image);
  assert.notEqual(f.config.image, `sha256:${'a'.repeat(64)}`);
  assert.ok(f.calls.some(args => args[0] === 'image' &&
    args[2] === `sha256:${'a'.repeat(64)}`));
});

test('adapter pressure proof never replaces container and workspace retirement',
  async t => {
  for (const failedCleanup of [false, true]) {
    let finished = false;
    const memoryPressure = pressureFixture();
    const f = await fixture(t, failedCleanup ? 'mapped-cleanup' : 'timeout',
      false, false, false, async () => ({ active: false,
        finish: async () => { finished = true; return memoryPressure; } }));
    const result = await f.sandbox.execute(f.request);
    assert.ok(finished);
    if (failedCleanup) {
      assert.equal(result.status, 'pending');
      assert.equal(result.terminationHash, undefined);
      assert.equal(result.memoryPressure, undefined);
    } else {
      assert.equal(result.status, 'interrupted');
      assert.equal(result.code, hostMemoryPressure);
      assert.deepEqual(result.memoryPressure, memoryPressure);
      assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
      assert.ok(f.calls.some(call => call[0] === 'rm'));
    }
  }
});

test('an unresolved ownership-reader process remains Pending after container cleanup',
  async t => {
    const f = await fixture(t, 'ownership-timeout', false, false, false,
      async () => ({ active: true, own: async () => {},
        finish: async () => pressureFixture() }));
    const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'WRITER_TERMINATION_UNKNOWN');
    assert.equal(result.terminationHash, undefined);
    assert.equal(result.memoryPressure, undefined);
  });


test('only complete interrupted Docker cleanup reports trusted local handback',
  async t => {
  for (const fault of ['timeout', 'idle', 'mapped-cleanup', 'cleanup']) {
    const f = await fixture(t, fault, false, true);
    let handback = 0, consumers = 0;
    f.request.onLocalHandback = () => { handback++; };
    f.request.onInterruptedCleanup = () => { consumers++; };
    await f.sandbox.execute(f.request);
    const expected = ['timeout', 'idle'].includes(fault) ? 1 : 0;
    assert.equal(handback, expected);
    assert.equal(consumers, expected);
  }
});

const claudeFixture = (t, fault, options = {}) => fixture(t, fault, false,
  false, options.project ?? false, undefined, 'claude');

test('Claude mode attaches the credential on stdin, never in argv, env or files',
  async t => {
    const f = await claudeFixture(t);
    const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'completed');
    assert.equal(result.stdout, 'bounded result');
    const create = f.calls.find(c => c[0] === 'create');
    assert.deepEqual(create.slice(0, 3), ['create', '--init', '--interactive']);
    assert.ok(create.includes('--security-opt=apparmor=nibfin-claude-container'));
    const start = f.calls.find(c => c[0] === 'start');
    assert.deepEqual(start, ['start', '--attach', '--interactive', 'b'.repeat(64)]);
    assert.equal(f.startOptions[0].input, `${claudeToken}\nRole prompt`);
    assert.ok(!JSON.stringify(f.calls).includes(claudeToken));
    const mounts = create.filter(v => v.startsWith('type=bind'))
      .map(v => /dst=([^,]+)/.exec(v)[1]);
    assert.deepEqual(mounts, ['/main', '/work', '/input', '/io', '/agent-home']);
    assert.deepEqual((await readdir(f.request.input)).sort(),
      ['bootstrap.mjs', 'invocation.json', 'tool-environment']);
    assert.equal(await readFile(join(f.request.input, 'bootstrap.mjs'), 'utf8'),
      await readFile('src/claude-bootstrap.mjs', 'utf8'));
    const invocation = JSON.parse(await readFile(
      join(f.request.input, 'invocation.json'), 'utf8'));
    assert.equal(invocation.plan.prompt, undefined);
    assert.equal(invocation.codexVersion, '2.1.326 (Claude Code)');
    assert.equal(invocation.jobVm, false);
    assert.equal(await readFile(join(f.request.input, 'tool-environment'), 'utf8'),
      'PATH=/bin\0LANG=C.UTF-8\0');
    for (const path of [f.request.input, f.request.output, f.request.session])
      for (const name of await readdir(path))
        assert.ok(!(await readFile(join(path, name), 'utf8')).includes(claudeToken));
  });

test('Claude mode rejects Codex login, MCP, job VM, bad credentials and plans',
  async t => {
    const changes = [
      r => { r.auth = r.work; }, r => { r.credential = 'not-a-credential'; },
      r => { r.mcp = inheritUserMcp({ notion: { url: 'https://mcp.notion.com/mcp' } }); },
      r => { r.jobVmSocket = r.input; },
      r => { r.plan = { ...r.plan, args: ['--dangerously-skip-permissions'] }; },
      r => { delete r.plan.provider; },
    ];
    for (const change of changes) {
      const f = await claudeFixture(t);
      change(f.request);
      await assert.rejects(f.sandbox.execute(f.request),
        /AGENT_PROVIDER_MODE_UNSUPPORTED|INVALID_AGENT_PLAN|USER_MCP_PROFILE_CHANGED/);
      assert.equal(f.calls.some(c => c[0] === 'create'), false);
    }
    const codex = await fixture(t);
    codex.request.credential = claudeToken;
    await assert.rejects(codex.sandbox.execute(codex.request),
      /AGENT_PROVIDER_MODE_UNSUPPORTED/);
  });

test('Claude mode requires its profile, attached stdin and its CLI version',
  async t => {
    for (const fault of ['stdin-once', 'apparmor']) {
      const f = await claudeFixture(t, fault);
      assert.equal((await f.sandbox.execute(f.request)).status, 'denied');
      assert.equal(f.calls.some(c => c[0] === 'start'), false);
    }
    const ignored = await claudeFixture(t, 'complain-apparmor');
    await assert.rejects(ignored.sandbox.execute(ignored.request),
      /AGENT_APPARMOR_NOT_ENFORCED/);
    const probe = ignored.calls.find(c => c[0] === 'run' && c.includes('--name'));
    assert.ok(probe.includes('--security-opt=apparmor=nibfin-claude-container'));
    const f = await claudeFixture(t);
    for (const [provider, version] of [['claude', 'codex-cli 0.138.0'],
      ['codex', '2.1.326 (Claude Code)'], ['other', '2.1.326 (Claude Code)']])
      assert.throws(() => new CodexSandbox({ ...f.config, provider,
        codexVersion: version }), /INVALID_CODEX_SANDBOX/);
  });

test('Claude idle and preflight exits reuse the Codex codes after cleanup',
  async t => {
    for (const [fault, code] of [['idle', 'CODEX_IDLE_TIMEOUT'],
      ['missing-login', 'SUBSCRIPTION_LOGIN_UNAVAILABLE']]) {
      const f = await claudeFixture(t, fault, { project: true });
      const result = await f.sandbox.execute(f.request);
      assert.equal(result.status, 'interrupted');
      assert.equal(result.code, code);
      if (fault === 'idle')
        assert.equal(result.lastProgress, 'NIBFIN_IDLE_PROGRESS tool running');
      assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
      assert.ok(f.calls.some(c => c[0] === 'rm'));
      assert.deepEqual(await readdir(f.config.mcpPolicyDirectory), []);
    }
  });

test('Claude writers get the same private tool output as Codex writers', async t => {
  for (const provider of ['codex', 'claude']) {
    const f = await fixture(t, undefined, false, false, false, undefined, provider);
    f.request.plan.writable = true;
    f.request.plan.policyHash = provider === 'claude' ?
      claudePolicyHash(f.request.plan) : f.request.plan.policyHash;
    assert.equal((await f.sandbox.execute(f.request)).status, 'completed', provider);
    const cache = `.nibfin-cache/${f.request.executionId}`;
    const create = f.calls.find(c => c[0] === 'create');
    assert.ok(create.some(v => v.includes('dst=/work,bind-propagation')), provider);
    const cleanup = f.calls.find(c => c[0] === 'run' && !c.includes('--name'));
    assert.match(cleanup[cleanup.indexOf('-e') + 1], new RegExp(`/work/${cache}`));
  }
});

const vmMounts = create => create.filter(v => v.startsWith('type=bind'))
  .map(v => [/dst=([^,]+)/.exec(v)[1], !v.includes(',readonly')]);

test('Claude VM mode mounts only its guest shell socket and the Core client',
  async t => {
    const f = await claudeFixture(t);
    f.request.plan = { ...f.request.plan, writable: true, jobVm: true };
    f.request.plan.policyHash = claudePolicyHash(f.request.plan);
    f.request.jobVmSocket = join(dirname(f.request.work), 'shell.sock');
    const result = await f.sandbox.execute(f.request);
    assert.equal(result.status, 'completed');
    assert.deepEqual(vmMounts(f.calls.find(c => c[0] === 'create')), [
      ['/main', false], ['/work', false], ['/input', false], ['/io', true],
      ['/agent-home', true], ['/job-vm-shell.sock', false]]);
    assert.deepEqual((await readdir(f.request.input)).sort(),
      ['bootstrap.mjs', 'invocation.json', 'tool-environment', 'vm-shell.mjs']);
    assert.equal(await readFile(join(f.request.input, 'vm-shell.mjs'), 'utf8'),
      await readFile('src/claude-vm-shell.mjs', 'utf8'));
    const invocation = JSON.parse(await readFile(
      join(f.request.input, 'invocation.json'), 'utf8'));
    assert.equal(invocation.jobVm, true);
    assert.equal(invocation.plan.jobVm, true);
    for (const change of [r => { delete r.jobVmSocket; },
      r => { r.plan = { ...r.plan, jobVm: undefined };
        r.plan.policyHash = claudePolicyHash(r.plan); }]) {
      const g = await claudeFixture(t);
      g.request.plan = { ...g.request.plan, writable: true, jobVm: true };
      g.request.plan.policyHash = claudePolicyHash(g.request.plan);
      g.request.jobVmSocket = join(dirname(g.request.work), 'shell.sock');
      change(g.request);
      await assert.rejects(g.sandbox.execute(g.request),
        /AGENT_PROVIDER_MODE_UNSUPPORTED/);
      assert.equal(g.calls.some(c => c[0] === 'create'), false);
    }
  });

test('Codex VM mode keeps its exec socket mount and has no shell client',
  async t => {
    const f = await fixture(t);
    f.request.plan.writable = true;
    f.request.jobVmSocket = join(dirname(f.request.work), 'exec.sock');
    assert.equal((await f.sandbox.execute(f.request)).status, 'completed');
    const mounts = vmMounts(f.calls.find(c => c[0] === 'create'));
    assert.deepEqual(mounts.at(-1), ['/job-vm.sock', false]);
    assert.ok(mounts.some(([path, rw]) => path === '/work' && !rw));
    assert.ok(!(await readdir(f.request.input)).includes('vm-shell.mjs'));
    assert.equal(JSON.parse(await readFile(join(f.request.input, 'invocation.json'),
      'utf8')).jobVm, true);
  });
