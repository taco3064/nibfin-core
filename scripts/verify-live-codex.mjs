// No inference or real login: test the actual CLI's sandbox enforcement only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexPlan } from '../src/codex-plan.mjs';
import {
  sandboxProbeArguments, subscriptionStatusArguments,
} from '../src/codex-bootstrap.mjs';
import { digest } from '../src/identity.mjs';
import { command } from '../src/process.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';
import { verifyAppArmor } from '../src/apparmor-proof.mjs';

const image = process.env.NIBFIN_CODEX_TEST_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const seccomp = process.env.NIBFIN_CODEX_TEST_SECCOMP;
assert.ok(seccomp?.startsWith('/'));
const root = await mkdtemp(join(tmpdir(), 'nibfin-live-codex-'));
const { socket: path, backend } = liveDockerProfile();
const socket = `unix://${path}`;
const docker = (args) =>
  command('/usr/bin/docker', ['--host', socket, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' },
    timeout: 120000,
  });
const name = `nibfin-cli-probe-${randomUUID()}`;
let failure;
try {
  if (backend.mode === 'rootful') {
    await verifyAppArmor(docker, image, backend.namespace);
  }
  const content = 'Synthetic isolation probe; never invoke a model.';
  const plan = codexPlan('shape', {
    model: 'probe-only',
    context: {},
    skill: { identity: 'shape', content, hash: digest(content) },
  });
  for (const part of ['work', 'main', 'input', 'io', 'auth', 'agent-home'])
    await mkdir(join(root, part));
  // Test-only writable mounts stay beneath the private 0700 host parent.
  for (const part of ['io', 'agent-home']) await chmod(join(root, part), 0o777);
  await writeFile(join(root, 'auth/auth.json'), 'synthetic-sentinel');
  await writeFile(join(root, 'agent-home/auth.json'), 'synthetic-sentinel');
  await writeFile(join(root, 'io/probe-sentinel'), 'synthetic-sentinel');
  await writeFile(join(root, 'input/requirements.toml'), plan.requirements);
  const script = `import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
mkdirSync('/tmp/tool-home', { recursive: true });
mkdirSync('/tmp/empty-codex-home', { recursive: true });
const loginEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/tool-home', CODEX_HOME: '/tmp/empty-codex-home' };
const plain = spawnSync('/usr/local/bin/codex', ['login', 'status'],
  { env: loginEnvironment, encoding: 'utf8' });
if (plain.status !== 1 ||
    !/undefined profile .nibfin./.test(plain.stderr)) process.exit(4);
const statusArgs = ${JSON.stringify(subscriptionStatusArguments(plan))};
const configured = spawnSync('/usr/local/bin/codex', statusArgs,
  { env: loginEnvironment, encoding: 'utf8' });
if (configured.status !== 1 ||
    !/not logged in/i.test(configured.stderr + configured.stdout)) process.exit(5);
writeSync(2, 'MANAGED_LOGIN_PROFILE_CHECK_PASSED\\n');
for (const path of ['/auth/auth.json', '/agent-home/auth.json', '/io/probe-sentinel']) {
  if (readFileSync(path, 'utf8') !== 'synthetic-sentinel') process.exit(3);
}
const server = createServer();
await new Promise(resolve => server.listen(3128, '127.0.0.1', resolve));
for (const args of [['--version'], ['sandbox', '--help']]) {
  const help = spawnSync('/usr/local/bin/codex', args, { encoding: 'utf8' });
  process.stderr.write(help.stdout ?? ''); process.stderr.write(help.stderr ?? '');
}
const probeArgs = ${JSON.stringify(sandboxProbeArguments(plan, '127.0.0.1'))};
probeArgs.push(String(process.pid));
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/tool-home', CODEX_HOME: '/agent-home' };
const result = spawnSync('/usr/local/bin/codex', probeArgs,
  { env: environment, encoding: 'utf8' });
writeSync(1, result.stdout ?? ''); writeSync(2, result.stderr ?? '');
writeSync(2, JSON.stringify({ probeExitCode: result.status,
  signal: result.signal, stdout: result.stdout }) + '\\n');
const controlArgs = ${JSON.stringify(sandboxProbeArguments(plan, '1.1.1.1'))};
controlArgs[controlArgs.length - 2] =
  "require('node:fs').writeSync(1, 'CONTROL_EXECUTED'); " + 'process.exit(37)';
const control = spawnSync('/usr/local/bin/codex', controlArgs,
  { env: environment, encoding: 'utf8' });
writeSync(2, JSON.stringify({ controlExitCode: control.status,
  stdout: control.stdout, stderr: control.stderr }) + '\\n');
if (control.status !== 37 || control.stdout !== 'CONTROL_EXECUTED') process.exit(2);
process.exit(result.status === 0 && result.stdout === 'NIBFIN_PROBE_PASSED\\n' ? 0 : 1);
`;
  await writeFile(join(root, 'input/probe.mjs'), script);
  const mounts = ['work', 'main', 'input', 'io', 'auth', 'agent-home'].flatMap((part) => {
    const readonly = ['work', 'main', 'input', 'auth'].includes(part) ? ',readonly' : '';
    return ['--mount', `type=bind,src=${join(root, part)},dst=/${part}${readonly}`];
  });
  await docker([
    'create',
    '--pull=never',
    '--name',
    name,
    '--read-only',
    '--network',
    'none',
    '--ipc',
    'none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--security-opt',
    `seccomp=${seccomp}`,
    '--security-opt=apparmor=codex-security-container',
    '--pids-limit=256',
    '--memory=4g',
    '--cpus=2',
    '--user',
    '1000:1000',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--workdir',
    '/session',
    ...mounts,
    '--mount',
    `type=bind,src=${join(root, 'input/requirements.toml')},` +
      'dst=/etc/codex/requirements.toml,readonly',
    '--entrypoint',
    '/usr/local/bin/node',
    image,
    '/input/probe.mjs',
  ]);
  try {
    await docker(['start', '--attach', name]);
  } catch (error) {
    // The fixed probe uses synthetic sentinels only; container logs contain no login.
    const logs = await docker(['logs', name]);
    process.stderr.write(logs.stdout);
    process.stderr.write(logs.stderr);
    throw error;
  }
} catch (error) {
  failure = error;
} finally {
  try {
    const remaining = async () =>
      (await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout
        .toString()
        .trim();
    const id = await remaining();
    if (id) {
      assert.match(id, /^[a-f0-9]{12,64}$/);
      await docker(['rm', '--force', name]);
    }
    assert.equal(await remaining(), '', 'Probe termination is unproven');
    const home = await lstat(join(root, 'agent-home')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (home)
      await docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        '1000:1000',
        '--mount',
        `type=bind,src=${join(root, 'agent-home')},dst=/cleanup`,
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        'find /cleanup -uid 1000 ! -type l -exec chmod a+rwX {} +',
      ]);
    await rm(root, { recursive: true, force: true });
  } catch (cleanup) {
    throw new AggregateError(
      [failure, cleanup].filter(Boolean),
      `Probe cleanup is unresolved; retained ${root}`,
    );
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    status: 'passed',
    kind: 'real-codex-sandbox-probe',
    image,
    cleanupVerified: true,
    authenticatedAgentVerified: false,
  }),
);
