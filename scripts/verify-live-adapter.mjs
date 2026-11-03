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

const image = process.env.NIBFIN_CODEX_TEST_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const socket = `/run/user/${process.getuid()}/docker.sock`;
const docker = args => command('/usr/bin/docker', ['--host', `unix://${socket}`, ...args], {
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' } });
const root = await mkdtemp(join(tmpdir(), 'nibfin-live-adapter-'));
const network = `nibfin-adapter-${randomUUID()}`, gatewayName = `${network}-proxy`;
try {
  await docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network]);
  const proxyScript = resolve('src/egress-proxy.mjs');
  const gatewayId = (await docker(['run', '-d', '--name', gatewayName, '--read-only', '--network', network,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--mount', `type=bind,src=${proxyScript},dst=/proxy.mjs,readonly`,
    '--entrypoint', 'node', image, '/proxy.mjs'])).stdout.toString().trim();
  const adapter = new CodexSandbox({ docker: '/usr/bin/docker', image, socket, gatewayId, network,
    codexVersion: 'codex-cli 0.138.0', coreRoot: resolve('.'), proxyScript });
  const request = { executionId: randomUUID() };
  for (const key of ['work', 'main', 'input', 'output', 'session']) {
    request[key] = join(root, key); await mkdir(request[key], { mode: 0o700 });
  }
  request.auth = join(root, 'original-auth.json');
  await writeFile(request.auth, '{}', { mode: 0o600 });
  const content = 'Synthetic adapter verification; no inference permitted.';
  request.plan = codexPlan('shape', { model: 'probe-only', context: {}, skill: { identity: 'shape', content, hash: digest(content) } });
  const result = await adapter.execute(request);
  // Denied because no subscription exists; never invent an Agent completion.
  assert.equal(result.status, 'denied', JSON.stringify(result));
  const proof = JSON.parse(await readFile(join(request.output, 'probe.json'), 'utf8'));
  assert.equal(proof.stdout, 'NIBFIN_PROBE_PASSED\n');
  assert.equal(proof.policyHash, request.plan.policyHash);
  assert.equal((await stat(request.auth)).mode & 0o777, 0o600);
  assert.equal(await readFile(request.auth, 'utf8'), '{}');
  assert.ok(!(await readdir(root)).some(name => name.startsWith('agent-auth-')));
  assert.equal((await docker(['ps', '-aq', '--filter', 'name=nibfin-agent-'])).stdout.toString().trim(), '');
  assert.deepEqual(await readdir(request.session), []);
  assert.ok(!(await readdir(request.output)).includes('stream.json'));
} finally {
  await docker(['rm', '--force', gatewayName]);
  await docker(['network', 'rm', network]);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: 'passed', kind: 'real-production-adapter',
  sandboxVerified: true, missingLoginDenied: true, cleanupVerified: true, authenticatedAgentVerified: false }));
