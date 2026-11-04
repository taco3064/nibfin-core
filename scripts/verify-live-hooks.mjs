// Real Docker integration, deliberately separate from simulated unit tests.
// Run only on a disposable remote test host; no production credentials needed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineSandbox } from '../src/sandbox.mjs';
import { command } from '../src/process.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

const image = process.env.NIBFIN_TEST_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const { socket, backend } = liveDockerProfile();
const config = { docker: '/usr/bin/docker', socket, image };
const sandbox = new OfflineSandbox(config, { backend });
const root = await mkdtemp(join(tmpdir(), 'nibfin-live-hooks-'));
try {
  const work = join(root, 'work'),
    baseline = join(root, 'baseline'),
    secret = join(root, 'host-secret');
  await mkdir(work);
  await mkdir(baseline);
  await writeFile(secret, 'synthetic-host-secret', { mode: 0o600 });
  await writeFile(join(baseline, 'sentinel'), 'immutable-baseline');
  const proof = await sandbox.preflight();
  const script = `set -eu
test ! -e '${secret}'
test ! -e /var/run/docker.sock
test ! -e '${socket}'
test -z "\${GITHUB_TOKEN:-}"
test -z "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"
test -z "\${NIBFIN_TEST_PRIVATE:-}"
test ! -e /auth/auth.json
test ! -e /agent-home/auth.json
test "$(cat /baseline-git/sentinel)" = immutable-baseline
if echo modified >/baseline-git/sentinel 2>/dev/null; then exit 41; fi
if touch /host-write-probe 2>/dev/null; then exit 42; fi
node <<'NETWORK_PROBE'
const n = require('node:net');
const s = n.connect({host: '1.1.1.1', port: 443});
s.on('connect', () => process.exit(43));
s.on('error', () => process.exit(0));
setTimeout(() => { s.destroy(); process.exit(0); }, 1500);
NETWORK_PROBE
printf passed >/work/result
`;
  process.env.NIBFIN_TEST_PRIVATE = 'synthetic-parent-secret';
  const result = await sandbox.execute({ work, baseline, script });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(await readFile(join(work, 'result'), 'utf8'), 'passed');
  assert.equal(await readFile(join(baseline, 'sentinel'), 'utf8'), 'immutable-baseline');
  const failure = await sandbox.execute({ work, baseline, script: 'exit 17' });
  assert.equal(failure.status, 'failed', JSON.stringify(failure));
  const containers = await command(
    config.docker,
    ['--host', `unix://${socket}`, 'ps', '-aq', '--filter', 'name=nibfin-hooks-'],
    {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' },
    },
  );
  assert.equal(containers.stdout.toString().trim(), '', 'Sandbox left containers behind');
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'real-offline-hook-isolation',
      status: 'passed',
      image,
      profile: proof.profile,
      observationHash: proof.observationHash,
      positive: result.status,
      failingHook: failure.status,
      containersRemaining: 0,
      authenticatedAgentVerified: false,
      selfHostedRunnerBindingVerified: false,
    }),
  );
} finally {
  delete process.env.NIBFIN_TEST_PRIVATE;
  await rm(root, { recursive: true, force: true });
}
