import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceTarget, dispatchMaintenance }
  from '../src/core-maintenance-dispatch.mjs';

const commit = 'a'.repeat(40);
const root = '/repos/taco3064/nibfin-core';

function fixture(event = 'workflow_run') {
  const repo = { id: 12, full_name: 'taco3064/nibfin-core', default_branch: 'main',
    private: false, archived: false, disabled: false };
  const run = { id: 31, repository: { id: 12 }, head_repository: { id: 12 },
    head_branch: 'main', head_sha: commit, path: '.github/workflows/cd.yml',
    workflow_id: 8, status: 'completed', conclusion: 'success', event };
  const producer = { id: 8, path: '.github/workflows/cd.yml', state: 'active' };
  const artifacts = [{ id: 44, name: `nibfin-activate-${commit}`, expired: false,
    workflow_run: { id: 31 } }];
  const reader = { async get(path) {
    if (path === root) return repo;
    if (path === `${root}/actions/runs/31`) return run;
    if (path === `${root}/actions/workflows/cd.yml`) return producer;
    throw new Error(`Unexpected read: ${path}`);
  }, async list(path, key) {
    assert.equal(path, `${root}/actions/runs/31/artifacts`);
    assert.equal(key, 'artifacts');
    return artifacts;
  } };
  return { repo, run, producer, artifacts, reader };
}

for (const event of ['workflow_run', 'workflow_dispatch']) {
  test(`dispatches only the authoritative completed ${event} CD target`, async () => {
    const { reader } = fixture(event);
    const writes = [];
    const result = await dispatchMaintenance(reader, 31,
      async target => { writes.push(target); return { runId: 99 }; });
    assert.deepEqual(result, { status: 'dispatched', cdRunId: 31, artifactId: 44,
      maintenance: { runId: 99 } });
    assert.deepEqual(writes, [{ status: 'ready', runId: 31, artifactId: 44,
      repository: 'taco3064/nibfin-core', ref: 'main',
      workflow: '.github/workflows/core-maintenance.yml' }]);
  });
}

test('a successful docs-only producer does not create a maintenance job', async () => {
  const { artifacts, reader } = fixture();
  artifacts.length = 0;
  let writes = 0;
  assert.deepEqual(await dispatchMaintenance(reader, 31, async () => writes++),
    { status: 'unavailable', runId: 31 });
  assert.equal(writes, 0);
});

test('rejects changed native producer identity and unsuccessful results', async () => {
  for (const changes of [{ event: 'pull_request' }, { head_branch: 'feature' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { workflow_id: 9 },
    { head_repository: { id: 99 } }, { repository: { id: 99 } },
    { path: '.github/workflows/other.yml' }]) {
    const { reader, run } = fixture();
    Object.assign(run, changes);
    await assert.rejects(maintenanceTarget(reader, 31),
      { code: 'CORE_MAINTENANCE_CD_RUN_UNTRUSTED' });
  }
});

test('ambiguous or foreign activation is not dispatched', async () => {
  for (const duplicate of [false, true]) {
    const { artifacts, reader } = fixture();
    if (duplicate) artifacts.push({ ...artifacts[0], id: 45 });
    else artifacts[0].workflow_run.id = 32;
    await assert.rejects(maintenanceTarget(reader, 31),
      { code: 'CORE_MAINTENANCE_CD_TARGET_AMBIGUOUS' });
  }
});

test('an observation or dispatch failure stays with its normal retry', async () => {
  const { reader } = fixture();
  reader.list = async () => { throw new Error('GitHub unavailable'); };
  let writes = 0;
  await assert.rejects(dispatchMaintenance(reader, 31, async () => writes++),
    /GitHub unavailable/);
  assert.equal(writes, 0);
  const current = fixture();
  await assert.rejects(dispatchMaintenance(current.reader, 31,
    async () => { throw new Error('dispatch response lost'); }), /response lost/);
  assert.equal((await dispatchMaintenance(current.reader, 31, async () => writes++))
    .status, 'dispatched');
  assert.equal(writes, 1);
});
