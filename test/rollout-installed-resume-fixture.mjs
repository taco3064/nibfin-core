import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { writeRelayState, readRelayState } from '../src/relay-state.mjs';

const root = await mkdtemp(join(tmpdir(), 'installed-legacy-resume-'));
try {
  const wakeRoot = join(root, 'wake');
  await mkdir(wakeRoot, { mode: 0o700 });
  const uid = process.getuid();
  const old = 'a'.repeat(40), current = 'b'.repeat(40);
  const issue = { id: 'I_old', repositoryId: 1,
    repository: 'example/core', number: 2 };
  const workflow = { id: 5, path: '.github/workflows/wake.yml',
    ref: 'main', commit: old };
  const initial = { issue, coreCommit: old, actorId: 3, route: { userId: 3 }, workflow };
  const host = { uid, stateRoot: root, installation: { pin: { commit: current } } };
  const original = new OperationJournal(wakeRoot, issue);
  const bindingHash = digest(initial);
  await original.run({ operation: 'wake', bindingHash, observation: initial }, {
    admit: async () => bindingHash, perform: async () => 10,
    readBack: async () => bindingHash,
  });
  const receiptPath = join(wakeRoot, digest({ issueId: issue.id, repositoryId: 1 }),
    'receipts.json');
  const before = await readFile(receiptPath, 'utf8');
  async function replace(path, overrides) {
    const actual = await import(path);
    mock.module(path, { namedExports: { ...actual, ...overrides } });
  }
  await replace('../src/host-adoption.mjs', {
    coreRoot: '/opt/nibfin/core', boundedHostFile: async () => JSON.stringify(host),
  });
  await replace('../src/host-paths.mjs', { rootOwnedPath: async () => {} });
  await replace('../src/source-package.mjs', { verifyInstalledSource: async () => {} });
  await replace('../src/managed-credential-files.mjs', {
    lifecycleState: async () => null, readPrivate: async () => 'fixture',
  });
  await replace('../src/retirement-admission.mjs', {
    requireNoRetirement: async () => {}, requirePoolOpen: async () => {},
  });
  await replace('../src/rollout-gates.mjs', {
    rolloutHasRelay: async () => false,
    withRolloutGates: async (unused, action) => action(),
  });
  let settlements = 0;
  await replace('../src/retirement-observe.mjs', {
    settlePoolWork: async () => { settlements++; },
  });
  await replace('../src/issue-wake.mjs', { adoptedWake: () => ({}) });
  await replace('../src/host-issue-wake.mjs', { hostWakeAdoption: () => ({}) });
  await replace('../src/shared-runner.mjs', {
    sharedRepository: async () => ({ repository: {} }),
  });
  await replace('../src/caller-source.mjs', { readCallerSource: async () => {} });
  await replace('../src/caller-recipes.mjs', { wakeRecipe: () => ({}) });
  let observationFailure = true, observations = 0;
  await replace('../src/wakeup.mjs', {
    observeWake: async () => {
      if (observationFailure && ++observations > 1)
        throw Object.assign(new Error('Interrupted'), { code: 'TEST_INTERRUPTION' });
      return { ...initial, coreCommit: current,
        workflow: { ...workflow, commit: current } };
    },
  });
  // Keep real nested settlement, including the wake and replacement scanners.
  await replace('../src/rollout-pool.mjs', {
    bindRolloutPool: async () => ({ adoptions: [] }),
  });
  let posts = 0;
  mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') {
      posts++;
      assert.equal(JSON.parse(options.body).inputs.issue_id, issue.id);
      return Response.json({ workflow_run_id: 20,
        run_url: 'https://api.github.com/repos/example/core/actions/runs/20',
        html_url: 'https://github.com/example/core/actions/runs/20' });
    }
    if (path.includes('/compare/')) return Response.json({ status: 'ahead',
      merge_base_commit: { sha: old } });
    const id = path.includes('/runs/10') ? 10 : 20;
    assert.ok(path.includes('/actions/runs/' + id), path);
    return Response.json({ id, event: 'workflow_dispatch', workflow_id: workflow.id,
      path: workflow.path, repository: { id: 1 }, head_repository: { id: 1 },
      head_sha: id === 10 ? old : current, head_branch: 'main',
      actor: { id: 3 }, run_attempt: 1, status: 'completed', conclusion: 'failure' });
  });
  mock.method(process, 'getuid', () => 0);
  const { recoverInstalledLegacyWakes } = await import('../src/rollout-legacy-wake.mjs');
  // First admission succeeds; dispatch observation then fails before any POST.
  const interrupted = (await recoverInstalledLegacyWakes()).results[0];
  assert.equal(interrupted.code, 'TEST_INTERRUPTION');
  assert.equal(posts, 0);
  const { readWakeOrigins } = await import('../src/operation-journal.mjs');
  const origin = { repositoryId: 1, runId: 10, attempt: 1,
    decisionId: (await readWakeOrigins(wakeRoot, uid))[0].decisionId };
  const name = 'legacy-' + digest(origin) + '.json';
  assert.equal((await readRelayState(wakeRoot, name, uid)).status, 'pending');
  observationFailure = false;
  const unrelated = 'legacy-' + 'c'.repeat(64) + '.json';
  await writeRelayState(wakeRoot, unrelated, { status: 'pending' }, uid);
  assert.equal((await recoverInstalledLegacyWakes()).results[0].code,
    'ROLLOUT_REPLACEMENT_PENDING');
  assert.equal(posts, 0);
  await writeRelayState(wakeRoot, unrelated, { status: 'scheduled' }, uid);
  const result = (await recoverInstalledLegacyWakes()).results[0];
  assert.equal(result.status, 'scheduled', JSON.stringify(result));
  assert.equal(result.runId, 20);
  assert.equal(settlements, 2);
  assert.equal(posts, 1);
  assert.equal((await readRelayState(wakeRoot, name, uid)).replacementRunId, 20);
  await recoverInstalledLegacyWakes();
  assert.equal(posts, 1);
  assert.equal(await readFile(receiptPath, 'utf8'), before);
} finally {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
