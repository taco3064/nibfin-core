import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { retryDelay } from '../scripts/retry-shared-runner.mjs';

// Controlled host adapters exercise the real fence, receipt store, journal and
// continuation. No Docker, provider or external GitHub mutation is performed.
export async function runPreparationScenario({
  scenario, root, issue, approval, env, launchStage, diagnostic,
  issueProgress, OperationJournal, setBeforeProgress, setUnsafe, counters,
}) {
  const state = join(root, 'issue-2-189');
  const lock = join(state, 'stage.lock');
  await mkdir(join(state, 'receipts'), { recursive: true, mode: 0o700 });
  const progress = await issueProgress(state, approval);
  const workspace = progress.workspaceRoot;
  const initial = scenario === 'prep-initial';
  let prior;
  let writes = 0;
  const journal = new OperationJournal(join(state, 'receipts'), issue);
  const request = { operation: 'shape', bindingHash: 'd'.repeat(64) };
  const adapters = {
    admit: async () => request.bindingHash,
    perform: async () => { writes++; },
    readBack: async () => request.bindingHash,
  };
  if (!initial) {
    await mkdir(join(workspace, 'work'), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, 'work', '.nibfin.json'),
      '{"tools":{"node":"22.15.0"}}');
    await progress.store.put(progress.marker);
    for (const [stage, outcome] of [
      ['shape', 'ready'], ['validate-shape', 'approved'],
      ['publish-shape', 'published'],
    ]) {
      await progress.store.append({ schemaVersion: 1, stage, outcome,
        binding: progress.binding, artifacts: {}, requirementsBody: 'requirements' });
    }
    prior = await progress.store.load();
    assert.equal((await journal.run(request, adapters)).status, 'completed');
  }
  if (scenario === 'prep-journal') {
    const unknown = await journal.run({ ...request, operation: 'deliver' }, {
      ...adapters,
      perform: async () => { throw diagnostic(); },
    });
    assert.equal(unknown.code, 'EXTERNAL_EFFECT_UNKNOWN');
  }
  if (scenario === 'prep-active') {
    const subject = digest({ issueId: issue.id, repositoryId: issue.repositoryId });
    await writeFile(join(state, 'receipts', subject, 'execution.lock'), 'retained');
  }
  const early = !['prep-mcp', 'prep-mcp-read', 'prep-compose',
    'prep-compose-read', 'prep-incomplete', 'prep-inspection'].includes(scenario);
  let original;
  let competing;
  setBeforeProgress(async () => {
    if (!early) return;
    original = JSON.parse(await readFile(lock, 'utf8')).binding.execution;
    competing = await launchStage('189', 'continue', {
      ...env, GITHUB_RUN_ID: '21',
    });
    throw diagnostic();
  });
  setUnsafe();
  const result = await launchStage('189', 'continue', env);
  assert.equal(result.status, 'pending');
  assert.equal(result.retrySettled, undefined);
  assert.equal(retryDelay(JSON.stringify(result), 20, 1), null);
  assert.equal(counters().runs, 0);
  const safe = ['prep-success', 'prep-initial'].includes(scenario);
  if (early) assert.equal(competing.code, 'HOST_EXECUTION_UNRESOLVED');
  if (safe) {
    assert.equal(result.code, 'LIVE_OBSERVATION_UNAVAILABLE');
    assert.deepEqual(result.preparationSettlement,
      { status: 'settled', execution: original });
    await assert.rejects(access(lock), { code: 'ENOENT' });
    assert.equal(counters().prepared, 0);
    if (initial) return;
    assert.deepEqual(await progress.store.load(), prior);
    setBeforeProgress(async () => {});
    const resumed = await launchStage('189', 'continue', {
      ...env, GITHUB_RUN_ID: '22',
    });
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.terminalStage, 'deliver');
    assert.equal(counters().runs, 1);
    assert.equal(counters().retired, 1);
    await assert.rejects(access(lock), { code: 'ENOENT' });
    assert.deepEqual(await progress.store.load(), prior);
    assert.equal((await journal.run(request, adapters)).code, 'REPLAYED_OPERATION');
    assert.equal(writes, 1);
  } else {
    if (early) assert.deepEqual(result.preparationSettlement,
      { execution: original, status: 'pending' });
    else assert.equal(result.preparationSettlement, undefined);
    const expected = {
      'prep-journal': 'EXTERNAL_EFFECT_UNKNOWN',
      'prep-active': 'WRITER_NOT_PROVEN_TERMINATED',
      'prep-containers': 'WRITER_NOT_PROVEN_TERMINATED',
      'prep-changed': 'HOST_FENCE_CHANGED',
      'prep-unobserved': 'HOST_EXECUTION_UNRESOLVED',
      'prep-mcp-read': 'LIVE_OBSERVATION_HTTP_429',
      'prep-compose-read': 'LIVE_OBSERVATION_HTTP_429',
    };
    assert.equal(result.code, expected[scenario] ?? 'LIVE_OBSERVATION_UNAVAILABLE');
    await access(lock);
    const blocked = await launchStage('189', 'continue', {
      ...env, GITHUB_RUN_ID: '23',
    });
    assert.equal(blocked.code, 'HOST_EXECUTION_UNRESOLVED');
    assert.equal(counters().retired, 0);
    if (scenario === 'prep-changed')
      assert.equal(await readFile(lock, 'utf8'), 'changed');
  }
}
