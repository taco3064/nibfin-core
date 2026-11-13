// Real production adapter and bootstrap; intentionally stop at absent login.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from '../src/process.mjs';
import { CodexSandbox } from '../src/codex-sandbox.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { digest } from '../src/identity.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

export async function verifyLiveAdapter(
  image = process.env.NIBFIN_CODEX_TEST_IMAGE,
) {
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const { socket, backend } = liveDockerProfile();
  const docker = (args, options = {}) =>
    command('/usr/bin/docker', ['--host', `unix://${socket}`, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' },
      ...options,
    });
  const root = await mkdtemp(join(tmpdir(), 'nibfin-live-adapter-'));
  const network = `nibfin-adapter-${randomUUID()}`,
    gatewayName = `${network}-proxy`;
  try {
    await docker([
      'network',
      'create',
      '--internal',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      network,
    ]);
    const proxyScript = resolve('src/egress-proxy.mjs');
    const gatewayId = (
      await docker([
        'run',
        '-d',
        '--name',
        gatewayName,
        '--read-only',
        '--network',
        network,
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--mount',
        `type=bind,src=${proxyScript},dst=/proxy.mjs,readonly`,
        '--entrypoint',
        'node',
        image,
        '/proxy.mjs',
      ])
    ).stdout
      .toString()
      .trim();
    const label = '{{index .Config.Labels "io.nibfin.codex-version"}}';
    const version = await docker(['image', 'inspect', '--format', label, image]);
    const adapter = new CodexSandbox(
      {
        docker: '/usr/bin/docker',
        image,
        socket,
        gatewayId,
        network,
        codexVersion: version.stdout.toString().trim(),
        coreRoot: resolve('.'),
        proxyScript,
      },
      {
        backend,
        async run(executable, args, options) {
          try {
            return await command(executable, args, options);
          } catch (error) {
            if (args[2] === 'start' && args[3] === '--attach') {
              const logs = await docker(['logs', args[4]]);
              process.stderr.write(logs.stderr);
            }
            throw error;
          }
        },
      },
    );
    const request = { executionId: randomUUID() };
    for (const key of ['work', 'main', 'input', 'output', 'session']) {
      request[key] = join(root, key);
      await mkdir(request[key], { mode: 0o700 });
    }
    request.auth = join(root, 'original-auth.json');
    // An empty object can be reported as logged in by the CLI.
    const invalidLogin = 'null';
    await writeFile(request.auth, invalidLogin, { mode: 0o600 });
    const content = 'Synthetic adapter verification; no inference permitted.';
    request.plan = codexPlan('shape', {
      model: 'probe-only',
      context: {},
      skill: { identity: 'shape', content, hash: digest(content) },
    });
    const result = await adapter.execute(request);
    // Denied because no subscription exists; never invent an Agent completion.
    assert.equal(result.status, 'interrupted', JSON.stringify(result));
    assert.equal(result.code, 'SUBSCRIPTION_LOGIN_UNAVAILABLE');
    const proof = JSON.parse(await readFile(join(request.output, 'probe.json'), 'utf8'));
    assert.equal(proof.stdout, 'NIBFIN_PROBE_PASSED\n');
    assert.equal(proof.policyHash, request.plan.policyHash);
    assert.equal((await stat(request.auth)).mode & 0o777, 0o600);
    assert.equal(await readFile(request.auth, 'utf8'), invalidLogin);
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('agent-auth-')));
    assert.equal(
      (await docker(['ps', '-aq', '--filter', 'name=nibfin-agent-'])).stdout
        .toString()
        .trim(),
      '',
    );
    assert.deepEqual(await readdir(request.session), []);
    assert.ok(!(await readdir(request.output)).includes('stream.json'));
  } finally {
    await docker(['rm', '--force', gatewayName]);
    await docker(['network', 'rm', network]);
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      kind: 'real-production-adapter',
      sandboxVerified: true,
      missingLoginDenied: true,
      cleanupVerified: true,
      authenticatedAgentVerified: false,
    }),
  );
}

