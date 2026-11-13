import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, access, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ToolEnvironmentPreparer, ToolPreparationError,
} from '../src/tool-environment.mjs';
import { preparationRecipe } from '../src/tool-recipe.mjs';
import { toolCatalog, projectToolPath } from '../src/tool-catalog.mjs';
import { command } from '../src/process.mjs';
import { verifyLiveToolEnvironments } from
  '../scripts/verify-live-tool-environments.mjs';
import { digest } from '../src/identity.mjs';
import { codexPlan } from '../src/codex-plan.mjs';

const config = { docker: '/usr/bin/docker', socket: '/run/user/1000/docker.sock' };
const host = {
  platform: 'linux', uid: 1000,
  lstat: async () => ({ isSocket: () => true, mode: 0o660, uid: 1000 }),
  realpath: async path => path,
};
const daemon = {
  SecurityOptions: ['name=rootless', 'name=seccomp,profile=builtin'],
  CgroupVersion: '2', CgroupDriver: 'systemd', MemoryLimit: true,
  PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
  OSType: 'linux', Architecture: 'x86_64',
};
const output = (value, exitCode = 0) => ({
  stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  stderr: Buffer.alloc(0), exitCode,
});

function fixture({ info = daemon, observedHost = host, fail, backend,
  endpoint = config } = {}) {
  const calls = [], contexts = [], images = new Map(), cache = new Map();
  const run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    assert.equal(executable, endpoint.docker);
    assert.deepEqual(args.slice(0, 2), ['--host', `unix://${endpoint.socket}`]);
    if (args[2] !== 'build')
      assert.equal(options.env.DOCKER_CONFIG, '/nonexistent');
    assert.equal(options.env.HOME, '/nonexistent');
    assert.ok(options.timeout > 0 && options.timeout <= 20 * 60_000);
    assert.ok(options.limit <= 8 * 1024 * 1024);
    const a = args.slice(2);
    if (a[0] === 'info') return output(info);
    if (a[0] === 'build') {
      const context = a.at(-1);
      const root = dirname(context);
      contexts.push(root);
      assert.equal(context, join(root, 'context'));
      assert.deepEqual(options.env, {
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
        DOCKER_CONFIG: join(root, 'docker-config'), DOCKER_BUILDKIT: '1',
        BUILDX_CONFIG: join(root, 'buildx'),
      });
      for (const directory of [options.env.BUILDX_CONFIG,
        options.env.DOCKER_CONFIG]) {
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        assert.deepEqual(await readdir(directory), []);
        // Model Docker CLI build state writes without inheriting credentials.
        await writeFile(join(directory, 'build-state'), 'test', { mode: 0o600 });
      }
      assert.equal(a[a.indexOf('--iidfile') + 1], join(root, 'image-id'));
      assert.deepEqual((await readdir(root)).sort(),
        ['buildx', 'context', 'docker-config']);
      if (fail) {
        const failure = await fail(a, options);
        if (failure) return failure;
      }
      assert.deepEqual(await readdir(context), ['Dockerfile']);
      const recipe = await readFile(join(context, 'Dockerfile'), 'utf8');
      const key = /io.nibfin.tool-environment="([a-f0-9]+)"/.exec(recipe)[1];
      const id = `sha256:${digest(recipe)}`;
      images.set(id, { Id: id, Os: 'linux', Architecture: 'amd64',
        Config: { Labels: { 'io.nibfin.tool-environment': key } } });
      await writeFile(a[a.indexOf('--iidfile') + 1], id);
      return output('');
    }
    assert.equal(options.env.BUILDX_CONFIG, undefined);
    if (fail) await fail(a, options);
    if (a[0] === 'image' && a[1] === 'inspect') {
      const image = images.get(cache.get(a[2]) ?? a[2]);
      return image ? output([image]) : output('', 1);
    }
    if (a[0] === 'image' && a[1] === 'tag') {
      cache.set(a[3], a[2]);
      return output('');
    }
    if (a[0] === 'run') {
      if (a.some(arg => arg.startsWith('nibfin-apparmor-')))
        return output({ label: 'codex-security-container (enforce)',
          uidMap: '0 231072 65536', gidMap: '0 231072 65536' });
      assert.ok(a.includes('--network=none'));
      assert.ok(a.includes('--cap-drop=ALL'));
      assert.ok(a.includes('--read-only'));
      assert.ok(a.includes('--security-opt=no-new-privileges'));
      assert.equal(a[a.indexOf('--entrypoint') + 1], '/usr/local/bin/node');
      assert.ok(!a.includes('--mount'));
      return output('NIBFIN_TOOLS_VERIFIED\n');
    }
    if (a[0] === 'ps' || a[0] === 'rm') return output('');
    throw new Error(`Unexpected Docker operation ${a[0]}`);
  };
  return { calls, contexts, images, cache, run,
    preparer: new ToolEnvironmentPreparer(endpoint,
      { run, host: observedHost, backend }) };
}
const builds = f => f.calls.filter(c => c.args[2] === 'build').length;
async function cleaned(f) {
  for (const context of f.contexts)
    await assert.rejects(access(context), { code: 'ENOENT' });
}

test('defaults and malformed or unsupported inputs never prepare', async () => {
  const f = fixture();
  assert.equal(await f.preparer.prepare(), null);
  assert.equal(await f.preparer.prepare({}), null);
  for (const tools of [null, [], new Date(), 'node', { ruby: '3.3.0' },
    { node: '22' }, { node: '22.15.1' }, { python: '$(secret)' },
    { go: 'https://evil.invalid' }, { node: '--privileged' },
    { node: '22.15.0', dockerfile: '/work/Dockerfile' }])
    await assert.rejects(f.preparer.prepare(tools), /request/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => new ToolEnvironmentPreparer({ ...config, path: '/work' }));
  assert.throws(() => new ToolEnvironmentPreparer({ ...config, socket: '/evil' }));
});

test('trusted recipes preserve exact requests, sources and separate bootstrap',
  async () => {
    const tools = { node: '22.15.0', python: '3.13.7', go: '1.27.1' };
    const recipe = await preparationRecipe(tools);
    const maintained = await readFile('src/security/agent.Dockerfile', 'utf8');
    assert.ok(recipe.dockerfile.startsWith(maintained.trimEnd().replace(
      /^(FROM node[^\n]+)$/m, '$1 AS nibfin-agent')));
    for (const image of ['node:22.15.0-bookworm-slim',
      'python:3.13.7-slim-bookworm', 'golang:1.27.1-bookworm'])
      assert.ok(recipe.dockerfile.includes(`docker.io/library/${image}`));
    assert.ok(recipe.dockerfile.includes('/opt/nibfin/project/node/'));
    assert.ok(recipe.dockerfile.includes('GOTOOLCHAIN=local exec'));
    assert.ok(!recipe.dockerfile.includes('ENV PATH='));
    const f = fixture();
    const image = await f.preparer.prepare(tools);
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const build = f.calls.find(c => c.args[2] === 'build');
    assert.deepEqual(build.args.slice(2, 5), ['build', '--platform', 'linux/amd64']);
    assert.ok(!build.args.some(a => a.includes('/work')));
    const probe = f.calls.find(c => c.args[2] === 'run').args.at(-1);
    assert.ok(probe.includes(JSON.stringify(tools)));
    assert.ok(probe.includes("check('/usr/local/bin/node'"));
    assert.ok(probe.includes("check('/usr/local/bin/codex'"));
    assert.ok(probe.includes(projectToolPath));
    await cleaned(f);
  });

test('canonical requests reuse; different versions coexist; stale cache rebuilds',
  async () => {
    const f = fixture();
    const tools = { node: '22.15.0', python: '3.13.7' };
    const first = await f.preparer.prepare(tools);
    assert.equal(await f.preparer.prepare({ python: tools.python, node: tools.node }),
      first);
    assert.equal(builds(f), 1);
    const second = await f.preparer.prepare({ node: '24.22.1' });
    assert.notEqual(second, first);
    assert.equal(await f.preparer.prepare(tools), first);
    assert.ok(f.images.has(first) && f.images.has(second));
    const tag = `nibfin-tools:${(await preparationRecipe(tools)).key}`;
    const stale = structuredClone(f.images.get(first));
    stale.Id = `sha256:${'a'.repeat(64)}`;
    stale.Config.Labels['io.nibfin.tool-environment'] = 'obsolete';
    f.images.set(stale.Id, stale);
    f.cache.set(tag, stale.Id);
    assert.equal(await f.preparer.prepare(tools), first);
    assert.equal(builds(f), 3);
    assert.ok(f.images.has(second));
    f.cache.delete(tag);
    assert.equal(await f.preparer.prepare(tools), first);
    assert.equal(builds(f), 4);
    await cleaned(f);
  });

test('backend and platform denial precede build effects', async () => {
  for (const info of [{ ...daemon, SecurityOptions: [] },
    { ...daemon, Architecture: 'aarch64' }, { ...daemon, OSType: 'windows' }]) {
    const f = fixture({ info });
    await assert.rejects(f.preparer.prepare({ node: '22.15.0' }), /backend/);
    assert.equal(builds(f), 0);
  }
  for (const observedHost of [{ ...host, uid: 0 },
    { ...host, realpath: async () => '/redirected' },
    { ...host, lstat: async () => ({ isSocket: () => false }) }]) {
    const f = fixture({ observedHost });
    await assert.rejects(f.preparer.prepare({ node: '22.15.0' }), /backend/);
    assert.equal(f.calls.length, 0);
  }
});

test('build failure and timeout keep prior environments and redact raw output',
  async () => {
    for (const code of ['PROCESS_FAILED', 'PROCESS_TIMEOUT']) {
      let failing = false;
      const f = fixture({ fail: async a => {
        if (a[0] === 'build' && failing)
          throw Object.assign(new Error('secret installer diagnostics'), { code });
      } });
      const good = await f.preparer.prepare({ node: '22.15.0' });
      failing = true;
      await assert.rejects(f.preparer.prepare({ node: '24.22.1' }), error => {
        assert.equal(error.phase, 'build');
        assert.ok(!error.message.includes('secret'));
        assert.equal(error.message.includes('timed out'),
          code === 'PROCESS_TIMEOUT');
        assert.equal(error.diagnosticCode, code === 'PROCESS_TIMEOUT'
          ? 'TOOL_PREPARATION_TIMEOUT' : 'PROCESS_FAILED');
        return true;
      });
      assert.equal(await f.preparer.prepare({ node: '22.15.0' }), good);
      assert.equal(await f.preparer.prepare(), null);
      assert.equal(f.cache.size, 1);
      await cleaned(f);
    }
  });

test('image metadata, partial versions and cache probes fail closed', async () => {
  let tamper;
  const f = fixture({ fail: async a => {
    if (a[0] === 'image' && a[1] === 'inspect' && a[2].startsWith('sha256:'))
      tamper(f.images.get(a[2]));
  } });
  tamper = image => { image.Architecture = 'arm64'; };
  await assert.rejects(f.preparer.prepare({ node: '22.15.0' }), /image validation/);
  assert.equal(f.cache.size, 0);
  await cleaned(f);
  let failProbe = false;
  const g = fixture({ fail: async a => {
    if (a[0] === 'run' && failProbe) throw new Error('partial version');
  } });
  const good = await g.preparer.prepare({ node: '22.15.0' });
  failProbe = true;
  await assert.rejects(g.preparer.prepare({ node: '24.22.1' }), /image validation/);
  await assert.rejects(g.preparer.prepare({ node: '22.15.0' }), /cache validation/);
  failProbe = false;
  assert.equal(await g.preparer.prepare({ node: '22.15.0' }), good);
  assert.equal(g.cache.size, 1);
  await cleaned(g);
});

test('overlap deduplicates and isolates another failure', async () => {
  const f = fixture();
  const [a, b, c] = await Promise.all([
    f.preparer.prepare({ node: '22.15.0', go: '1.27.1' }),
    f.preparer.prepare({ go: '1.27.1', node: '22.15.0' }),
    f.preparer.prepare({ node: '24.22.1' }),
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(builds(f), 2);
  const g = fixture({ fail: async a => {
    if (a[0] === 'run' && a.at(-1).includes('22.15.0')) throw new Error('failed');
  } });
  const results = await Promise.allSettled([
    g.preparer.prepare({ node: '22.15.0' }),
    g.preparer.prepare({ node: '24.22.1' }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(await g.preparer.prepare({ node: '24.22.1' }), results[1].value);
  assert.equal(g.cache.size, 1);
  await cleaned(f);
  await cleaned(g);
});

test('uncertain validation container cleanup reports the recovery target', async () => {
  const f = fixture({ fail: async a => {
    if (a[0] === 'ps') throw new Error('daemon disconnected');
  } });
  await assert.rejects(f.preparer.prepare({ node: '22.15.0' }), error => {
    assert.equal(error.code, 'WRITER_TERMINATION_UNKNOWN');
    assert.match(error.message, /termination unknown for nibfin-tools-[a-f0-9-]{36}/);
    return true;
  });
  assert.equal(f.cache.size, 0);
  await cleaned(f);
});

test('development PATH reaches Codex tools and documented catalog stays exact',
  async () => {
    const content = 'test';
    const plan = codexPlan('deliver', { model: 'test', context: {},
      additionalDomains: ['API.Example.com', 'api.example.com'],
      skill: { identity: 'deliver', content, hash: digest(content) } });
    assert.equal(plan.config['shell_environment_policy.set'].PATH, projectToolPath);
    assert.equal(plan.environment.PATH, '/usr/local/bin:/usr/bin:/bin');
    assert.deepEqual(plan.additionalDomains, ['api.example.com']);
    assert.ok(plan.requirements.includes('"api.example.com"'));
    for (const additionalDomains of [undefined, []]) {
      const defaults = codexPlan('deliver', { model: 'test', context: {},
        additionalDomains,
        skill: { identity: 'deliver', content, hash: digest(content) } });
      assert.deepEqual(defaults.additionalDomains, []);
      assert.equal(defaults.config['shell_environment_policy.set'].PATH,
        projectToolPath);
    }
    const documentation = await readFile('docs/tool-environments.md', 'utf8');
    for (const [name, versions] of Object.entries(toolCatalog))
      for (const version of versions) assert.ok(documentation.includes(`${name} |` +
        ` ${version} |`));
  });

test('separate preparers share Docker cache safely during equal builds', async () => {
  const f = fixture();
  const other = new ToolEnvironmentPreparer(config, { run: f.run, host });
  const [a, b] = await Promise.all([
    f.preparer.prepare({ node: '22.15.0' }), other.prepare({ node: '22.15.0' }),
  ]);
  assert.equal(a, b);
  assert.equal(f.cache.size, 1);
  assert.ok(!f.calls.some(c => c.args[2] === 'rmi' || c.args.includes('prune')));
  await cleaned(f);
});

test('rootful preparation uses existing namespace proof and fences uncertain cleanup',
  async () => {
    const rootful = {
      endpoint: { docker: '/usr/bin/docker', socket: '/run/nibfin-engine/docker.sock' },
      backend: { kind: 'linux-rootful-docker-v1',
        namespace: { uidStart: 231072, gidStart: 231072, size: 65536 } },
      info: { ...daemon, SecurityOptions: [
        'name=userns', 'name=apparmor', 'name=seccomp,profile=builtin',
      ] },
      observedHost: { ...host, gids: [42], rootOwnedPath: async () => {},
        lstat: async () => ({ isSocket: () => true, mode: 0o660, uid: 0, gid: 42 }) },
    };
    const f = fixture(rootful);
    await f.preparer.prepare({ node: '22.15.0' });
    const runs = f.calls.filter(c => c.args[2] === 'run');
    assert.equal(runs.length, 2);
    assert.ok(runs.every(c => c.args.includes(
      '--security-opt=apparmor=codex-security-container')));
    const g = fixture({ ...rootful, fail: async a => {
      if (a[0] === 'ps') throw new Error('lost daemon response');
    } });
    await assert.rejects(g.preparer.prepare({ node: '22.15.0' }), error => {
      assert.equal(error.code, 'WRITER_TERMINATION_UNKNOWN');
      assert.match(error.message, /termination unknown for nibfin-apparmor-/);
      return true;
    });
    assert.equal(g.cache.size, 0);
    await cleaned(f);
    await cleaned(g);
  });

test('nonzero build output becomes safe diagnostics through the command helper',
  async () => {
    const cases = [
      ['network bridge not found', 'TOOL_BUILD_NETWORK_BRIDGE_MISSING'],
      ['failed to resolve source metadata', 'TOOL_BUILD_ACQUISITION_FAILED'],
      ['failed to fetch oauth token', 'TOOL_BUILD_ACQUISITION_FAILED'],
      ['manifest unknown', 'TOOL_BUILD_ACQUISITION_FAILED'],
      ['pull access denied', 'TOOL_BUILD_ACQUISITION_FAILED'],
      ['no space left on device', 'TOOL_BUILD_STORAGE_EXHAUSTED'],
      ['Cannot connect to the Docker daemon', 'TOOL_BUILD_DAEMON_UNAVAILABLE'],
      ['mkdir /nonexistent: permission denied',
        'TOOL_BUILD_CONFIG_PERMISSION_DENIED'],
      ['failed to mount /private: operation not permitted',
        'TOOL_BUILD_MOUNT_DENIED'],
      ['permission denied', 'TOOL_BUILD_PERMISSION_DENIED'],
      ['unrecognized installer failure', 'TOOL_BUILD_FAILED'],
    ];
    for (const [diagnostic, expected] of cases) {
      for (const stream of ['stdout', 'stderr']) {
        const f = fixture({ fail: async (args, options) => {
          if (args[0] !== 'build') return;
          // Exercise actual nonzero process capture rather than thrown mocks.
          return command(process.execPath, ['-e',
            `process.${stream}.write(${JSON.stringify(diagnostic +
              ' credential=private-secret https://private.invalid')});` +
            'process.exit(1)',
          ], options);
        } });
        const probe = async () => {
          try { await f.preparer.prepare({ node: '22.15.0' }); }
          catch (error) {
            assert.ok(error instanceof ToolPreparationError);
            assert.equal(error.code, 'TOOL_PREPARATION_FAILED');
            assert.equal(error.phase, 'build');
            assert.equal(error.diagnosticCode, expected);
            assert.equal(error.message, `Tool environment build: ${expected}`);
            throw error;
          }
        };
        await assert.rejects(verifyLiveToolEnvironments(probe), error => {
          assert.equal(error.constructor, Error);
          assert.equal(error.toString(), `Error: ${expected}`);
          return true;
        });
        assert.equal(f.cache.size, 0);
        await cleaned(f);
      }
    }
  });

test('native probe forwards preparation diagnostics as plain Error codes', async () => {
  const failure = new ToolPreparationError('build',
    'TOOL_BUILD_NETWORK_BRIDGE_MISSING', 'TOOL_BUILD_NETWORK_BRIDGE_MISSING');
  await assert.rejects(verifyLiveToolEnvironments(async () => { throw failure; }),
    error => {
      assert.equal(error.constructor, Error);
      assert.equal(error.toString(), 'Error: TOOL_BUILD_NETWORK_BRIDGE_MISSING');
      return true;
    });
  const uncertain = new ToolPreparationError('cleanup', 'termination unknown');
  uncertain.code = 'WRITER_TERMINATION_UNKNOWN';
  await assert.rejects(verifyLiveToolEnvironments(async () => { throw uncertain; }),
    error => error === uncertain);
  const unrelated = new Error('unrelated assertion');
  await assert.rejects(verifyLiveToolEnvironments(async () => { throw unrelated; }),
    error => error === unrelated);
});
