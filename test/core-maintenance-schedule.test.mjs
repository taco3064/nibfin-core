import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleCoreMaintenance } from '../src/core-maintenance-schedule.mjs';
import { gitBlob } from '../src/identity.mjs';
import { upgradeRecipe, upgradeRecipeVariants }
  from '../src/upgrade-continuation-contract.mjs';

const target = { runId: 31, artifactId: 44 };
const producer = 'taco3064/nibfin-core';
const branch = 'main';
const commit = 'a'.repeat(40);

function fixture({ repository = 'example/execution', state = {}, legacy = false } = {}) {
  const root = '/repos/' + repository;
  const upstream = '/repos/' + producer;
  const repositoryId = repository === producer ? 12 : 53;
  const execution = { repositoryId, repository };
  const memberId = 9;
  const route = repository === producer
    ? 'core-maintenance.yml' : 'nibfin-upgrade-execute.yml';
  const path = '.github/workflows/' + route;
  const makeRepo = (name, id) => ({ full_name: name, id, default_branch: branch,
    private: false, archived: false, disabled: false, owner: { id: 91 } });
  const data = {
    [upstream]: makeRepo(producer, 12),
    [root]: makeRepo(repository, repositoryId),
    [upstream + '/actions/runs/31']: {
      id: 31, repository: { id: 12 }, head_repository: { id: 12 },
      head_branch: 'main', head_sha: commit, path: '.github/workflows/cd.yml',
      workflow_id: 8, status: 'completed', conclusion: 'success', event: 'workflow_run',
      created_at: '2026-11-20T12:00:00Z',
    },
    [upstream + '/actions/workflows/cd.yml']: {
      id: 8, path: '.github/workflows/cd.yml', state: 'active',
    },
    [root + '/branches/main']: { name: branch, commit: { sha: commit }, protected: true },
    [root + '/actions/workflows/' + route]: { id: 29, path, state: 'active' },
  };
  const source = Buffer.from(legacy
    ? upgradeRecipeVariants('execution', memberId).at(-1)
    : upgradeRecipe('execution', memberId));
  data[root + '/contents/' + path + '?ref=' + commit] = {
    type: 'file', path, encoding: 'base64', content: source.toString('base64'),
    sha: gitBlob(source),
  };
  const native = {
    id: 88, workflow_id: 29, repository: { id: repositoryId },
    head_repository: { id: repositoryId }, path, head_branch: branch,
    display_title: 'Core maintenance · CD 31 · artifact 44', status: 'queued',
    ...state,
  };
  const runs = [];
  const reader = {
    async get(key) {
      assert(Object.hasOwn(data, key), key);
      return data[key];
    },
    async list(key, field) {
      if (field === 'artifacts') {
        assert.equal(key, upstream + '/actions/runs/31/artifacts');
        return [{ id: 44, name: 'nibfin-activate-' + commit, expired: false,
          workflow_run: { id: 31 } }];
      }
      assert.match(key, /actions\/workflows\/29\/runs\?/);
      return runs;
    },
  };
  const actions = [];
  const ports = {
    async dispatch(destination, input, token) {
      assert.equal(token, 'synthetic');
      actions.push({ operation: 'dispatch', destination, input });
      return { runId: 89 };
    },
    async rerun(repo, id) { actions.push({ operation: 'rerun', repo, id }); },
  };
  return { native, runs, actions, ports, invoke: (more = {}) =>
    scheduleCoreMaintenance(reader, 'synthetic', execution, memberId, target,
      { ...ports, ...more }) };
}

test('the adopted maintenance run returns its exact repository and native identity',
  async () => {
    const context = fixture();
    context.runs.push({ ...context.native,
      display_title: 'Core maintenance · CD 31 · artifact 45' });
    const result = await context.invoke();
    assert.equal(result.status, 'pending');
    assert.equal(result.installation, 'pending');
    assert.equal(result.coreRunURL,
      'https://github.com/example/execution/actions/runs/89');
    assert.deepEqual(context.actions, [{ operation: 'dispatch',
      destination: { repository: 'example/execution', ref: 'main', id: 29 },
      input: { cd_run_id: '31', activation_artifact_id: '44' } }]);
    context.actions.length = 0;
    context.runs.push(context.native);
    assert.equal((await context.invoke()).coreRunId, 88);
    assert.deepEqual(context.actions, []);
  });

test('failed native attempts retry with separate installation readback', async () => {
  const context = fixture({ repository: producer,
    state: { status: 'completed', conclusion: 'failure' } });
  context.runs.push(context.native);
  assert.equal((await context.invoke()).coreRunId, 88);
  assert.deepEqual(context.actions, [{ operation: 'rerun', repo: producer, id: 88 }]);
  const observed = await context.invoke({
    installed: async fact => fact.commit === commit,
  });
  assert.equal(observed.installation, 'complete');
  assert.equal(context.actions.length, 1);
});

test('legacy adopted workflow never receives unsupported activation inputs', async () => {
  const context = fixture({ legacy: true });
  await assert.rejects(context.invoke(),
    { code: 'UPGRADE_CORE_EXECUTION_ROUTE_REQUIRED' });
  assert.deepEqual(context.actions, []);
});
