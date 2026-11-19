import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { RelayJournal, readRelayState, writeRelayState } from '../src/relay-state.mjs';

async function replace(path, overrides) {
  const actual = await import(path);
  mock.module(path, { namedExports: { ...actual, ...overrides } });
}
const old = 'a'.repeat(40), current = 'b'.repeat(40);
const issue = { id: 'I_large', repositoryId: 1,
  repository: 'example/core', number: 2 };
const workflow = { id: 5, path: '.github/workflows/wake.yml',
  ref: 'main', commit: current };
const initial = { issue, coreCommit: current, actorId: 3, workflow,
  state: { body: 'Valid Issue content. '.repeat(2000) } };
assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 16384);
for (const [path, names] of [
  ['../src/retirement-admission.mjs',
    ['requirePoolOpen', 'requirePoolConsumersSettled']],
  ['../src/managed-credentials.mjs', ['assertNoCredentialConsumers']],
  ['../src/managed-credential-settlement.mjs', ['managedSettlement']],
  ['../src/retirement-copies.mjs', ['inspectRetirementSessions']],
  ['../src/host-containers.mjs', ['idleContainers']],
  ['../src/retirement-observe.mjs', ['assertRetirementJobs']],
  ['../src/relay-observe.mjs',
    ['reconcileRelayAttempt', 'observeRelayOrigin', 'observeRelayAttempt']],
]) await replace(path, Object.fromEntries(names.map(name => [name, async () => {}])));
await replace('../src/issue-wake.mjs', {
  resolveSharedIssueWake: async () => {}, adoptedWake: () => ({}),
});
await replace('../src/host-issue-wake.mjs', { hostWakeAdoption: () => ({}) });
await replace('../src/shared-runner.mjs', {
  sharedRepository: async () => ({ repository: {} }),
  sharedDispatchWorkflow: async () => workflow, sharedSlotIsolation: () => ({}),
});
let observations, interruption, posts, reads;
await replace('../src/wakeup.mjs', { observeWake: async () => {
  observations++;
  if (interruption === 'admission' && observations === 4)
    throw Object.assign(new Error('Interrupted'), { code: 'TEST_INTERRUPTION' });
  return initial;
} });
mock.method(globalThis, 'fetch', async (url, options = {}) => {
  if (options.method === 'POST') {
    posts++;
    if (interruption === 'post') throw new Error('Lost POST');
    return Response.json({ workflow_run_id: 20,
      run_url: 'https://api.github.com/repos/example/core/actions/runs/20',
      html_url: 'https://github.com/example/core/actions/runs/20' });
  }
  reads++;
  assert.ok(new URL(url).pathname.endsWith('/actions/runs/20'));
  return Response.json({ id: 20, event: 'workflow_dispatch', workflow_id: 5,
    path: workflow.path, repository: { id: 1 }, head_repository: { id: 1 },
    head_sha: interruption === 'readback' ? old : current, head_branch: 'main',
    actor: { id: 3 }, run_attempt: 1 });
});
const { recoverRolloutOrigins } = await import('../src/rollout-recovery.mjs');
for (const mode of ['none', 'admission', 'readback', 'post']) {
  const root = await mkdtemp(join(tmpdir(), 'relay-replacement-'));
  try {
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot, { mode: 0o700 });
    const journal = new RelayJournal(root);
    await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: false });
    const origin = { repositoryId: 1, runId: 2, attempt: 1 };
    const record = { origin, status: 'pending', intent: { origin, issue,
      source: { coreCommit: old }, destination: { repository: issue.repository },
      inputs: { wake_event: JSON.stringify({ event: {} }) } } };
    await journal.write(record);
    await journal.write({ ...record, status: 'consumed', runId: 10 });
    const before = await journal.read(origin);
    const context = { journal, token: 'fixture',
      host: { stateRoot, runnerUid: 1,
        sharedRunner: { runner: {}, additionalRunner: { uid: 2 } } },
      configuration: { coreCommit: current, runner: {},
        origins: [{ repositoryId: 1, repository: issue.repository }] },
      inspect: async () => {}, reader: { get: async () => ({ id: 10,
        run_attempt: 1, status: 'completed', conclusion: 'failure' }) } };
    observations = posts = reads = 0;
    interruption = mode;
    const first = (await recoverRolloutOrigins(context))[0];
    const name = 'replacement-' + digest(origin);
    const directory = join(root, name);
    if (mode === 'admission') {
      assert.equal(first.code, 'TEST_INTERRUPTION');
      assert.equal(posts, 0);
    } else if (mode === 'post' || mode === 'readback') {
      assert.equal(first.status, 'pending');
      assert.equal(posts, 1);
      const saved = await new OperationJournal(directory, issue).wakeObservation();
      assert.deepEqual(saved.state, initial.state);
    } else assert.equal(first.status, 'scheduled', JSON.stringify(first));
    const previousObservations = observations;
    interruption = 'none';
    const second = (await recoverRolloutOrigins(context))[0];
    if (mode === 'post') {
      assert.equal(second.code, 'EXTERNAL_EFFECT_UNKNOWN');
      assert.equal(reads, 0);
    } else {
      assert.equal(second.status, 'scheduled', JSON.stringify(second));
      assert.equal((await readRelayState(root, name + '.json')).replacementRunId, 20);
      assert.ok(reads > 0);
    }
    if (mode === 'readback' || mode === 'post')
      assert.equal(observations, previousObservations);
    assert.equal(posts, 1);
    assert.deepEqual(await journal.read(origin), before);
    assert.ok(!(await readdir(directory)).includes('observation.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
}
