import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat } from '../src/identity.mjs';
import { sharedTarget } from '../src/shared-platform.mjs';
import { readInstalledRunnerIdentity } from '../src/installed-runner-state.mjs';
import { checkRegistrationEndpoints }
  from '../src/security/shared-runner-start-check.mjs';
import { applyRolloutTransaction } from '../src/rollout-apply.mjs';

const oldSource = await readFile(new URL(
  './fixtures/legacy-runner-start-check.txt', import.meta.url), 'utf8');
const currentSource = await readFile(new URL(
  '../src/security/shared-runner-start-check.mjs', import.meta.url), 'utf8');
const shim = async name => readFile(new URL(
  '../src/security/' + name, import.meta.url), 'utf8');
const legacyShim = await shim('shared-worker-dispatcher-legacy.sh');
const currentShim = await shim('shared-worker-dispatcher.sh');

function bindGuard(source, ports) {
  const start = source.indexOf('export async function checkSharedRunnerSlot(');
  const next = source.indexOf('\nexport function checkRegistrationEndpoints', start);
  assert.ok(start >= 0, 'Use the maintained or archived whole slot guard');
  const body = source.slice(start, next < 0 ? undefined : next)
    .replace('export ', '').replace('import.meta.url', 'moduleUrl');
  // Preserve the complete guard. Only module location and host I/O are injected;
  // no ownership, program identity, permission or dispatcher assertion is removed.
  return new Function(...Object.keys(ports), `return (${body});`)(
    ...Object.values(ports));
}

export function legacyStartFixture() {
  const target = sharedTarget('amd64');
  const registration = { agentId: 42, agentName: 'existing-slot',
    gitHubUrl: 'https://github.com/owner/repo', workFolder: '_work',
    disableUpdate: true, serverUrl: 'https://pipelinesghub1.actions.' +
      'githubusercontent.com/one/',
    serverUrlV2: 'https://broker.actions.githubusercontent.com/', useV2Flow: true };
  const credential = { scheme: 'OAuth', data: {
    authorizationUrl: 'https://tokenghub.actions.githubusercontent.com/' +
      '_apis/oauth2/token/existing' } };
  const state = { packages: { live: 'old', staged: 'new', backup: 'absent' },
    worker: legacyShim, registration, target,
    credentialMode: 0o640, untrusted: false, programChanged: false,
    moves: [], writes: [], saved: null };
  const missing = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const inspect = async () => requireThat(!state.untrusted, 'UNTRUSTED_HOST_PATH');
  const verify = async (path, expected) => {
    const hash = path.endsWith('Runner.Listener') ? target.listenerSha256 :
      target.workerSha256;
    requireThat(!state.programChanged && hash === expected,
      'SHARED_ARTIFACT_DIGEST_MISMATCH');
  };
  const ports = { join: posix.join, URL, requireThat,
    fileURLToPath: value => fileURLToPath(value, { windows: false }),
    moduleUrl: 'file:///fixture/core/src/security/shared-runner-start-check.mjs',
    constants: { R_OK: 4 }, process: { getuid: () => 1001, getgid: () => 1001 },
    installedSharedRuntime: async () => target,
    verifySharedSlotIdentity: async (path, expected, repository) => {
      assert.equal(expected.id, registration.agentId);
      assert.equal(expected.name, registration.agentName);
      assert.equal(registration.gitHubUrl, 'https://github.com/' + repository);
      return registration;
    },
    rootOwnedPath: inspect, checkRegistrationEndpoints,
    boundedHostFile: async path => path.endsWith('.credentials') ?
      JSON.stringify(credential) : state.worker,
    readFile: async () => state.packages.live === 'new' ? currentShim : legacyShim,
    realpath: async () => '/usr/bin/python3.12',
    verifySharedFile: verify, verifyProgramTree: inspect, access: inspect,
    readInstalledRunnerIdentity: (path, local, runtime) =>
      readInstalledRunnerIdentity(path, local, runtime,
        { inspect: missing, verify }),
    lstat: async path => ({ isFile: () => true, isDirectory: () => true,
      nlink: 1, uid: 1001, gid: 1001,
      mode: path.endsWith('_work') || path.endsWith('_diag') ? 0o700 :
        state.credentialMode }),
  };
  const guards = { old: bindGuard(oldSource, ports),
    new: bindGuard(currentSource, ports) };
  const plan = { pin: { commit: 'a'.repeat(40) }, phase: 'applying', apply: {
    source: {}, targets: [{ path: 'host', current: 'old',
      next: JSON.stringify({ repository: { runner: { repository: 'owner/repo' } } }) }],
  } };
  let host = 'old';
  return { state,
    bootstrap: () => { state.worker = currentShim; },
    ready: () => guards[state.packages.live]('/fixture/slot',
      { id: 42, name: 'existing-slot' }, 'owner/repo'),
    promote: (interrupt = false) => applyRolloutTransaction(plan, {
      backup: 'backup', package: async name => state.packages[name],
      move: async (from, to) => {
        state.packages[to] = state.packages[from];
        state.packages[from] = 'absent';
        state.moves.push([from, to]);
        if (interrupt) throw new Error('interrupted after move');
      },
      read: async () => host,
      replace: async (path, value) => { host = value; state.writes.push(path); },
      save: async value => { state.saved = value; },
    }),
  };
}
