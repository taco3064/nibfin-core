import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';

let root;
let context, protectedCalls = 0, dispatches = 0;
const adoption = await import('../src/host-adoption.mjs');
mock.module('../src/host-adoption.mjs', { namedExports: {
  ...adoption,
  loadHostAdoption: async () => context,
  inspectHostAdoption: async () => {},
  readGlobalInstructions: async () => '',
} });
const approval = await import('../src/github-approval.mjs');
mock.module('../src/github-approval.mjs', { namedExports: {
  ...approval, readProtectedApproval: async () => ({
    approvalHash: 'same', record: {
      issue: { id: 'I_target', number: 2 },
      roles: { author: 2, publisher: 2 }, operations: ['wake'],
    },
  }),
} });
const actions = await import('../src/actions-identity.mjs');
mock.module('../src/actions-identity.mjs', { namedExports: {
  ...actions,
  actionsCaller: () => async () => {},
} });
const relay = await import('../src/host-relay.mjs');
mock.module('../src/host-relay.mjs', { namedExports: {
  ...relay,
  relayHostCommand: async () => null,
} });
const fence = await import('../src/host-fence.mjs');
mock.module('../src/host-fence.mjs', { namedExports: {
  ...fence,
  issueStatePath: () => root,
  acquireHostFence: async () => ({ inspect: async () => 'fence' }),
  privateHostDirectory: async () => {},
} });
const containers = await import('../src/host-containers.mjs');
mock.module('../src/host-containers.mjs', { namedExports: {
  ...containers,
  idleContainers: async () => [],
} });
const mcp = await import('../src/mcp-job-host.mjs');
mock.module('../src/mcp-job-host.mjs', { namedExports: {
  ...mcp,
  prepareHostJobMcp: async () => {
    protectedCalls++;
    throw Object.assign(new Error('test boundary'), { code: 'TEST_BOUNDARY' });
  },
} });
const wake = await import('../src/issue-wake.mjs');
mock.module('../src/issue-wake.mjs', { namedExports: {
  ...wake,
  dispatchIssueWake: async ({ inspect }) => {
    await inspect();
    dispatches++;
    return { status: 'dispatched' };
  },
} });
const { launchStage, readSelectedHost } = await import('../src/host-launcher.mjs');
const { launchIssueWake } = await import('../src/host-issue-wake.mjs');

async function scenario(kind, selected, change = () => {}, invalid = false) {
  const f = runnerProviderFixture();
  if (selected === 41) {
    f.expected.runnerId = f.runner.id = f.job.runner_id = 41;
    f.expected.runnerName = f.runner.name = f.job.runner_name = 'second-host';
    f.data['/actions/runners/41'] = f.runner;
  }
  const other = { ...f.runner, id: selected === 40 ? 41 : 40, name: 'other' };
  let registered = [f.runner, other, {
    ...f.runner, id: 99, name: 'unrelated', labels: [{ name: 'nibfin-user-99' }],
  }];
  f.data['/branches/main'] = {
    protected: true, commit: { sha: f.expected.sourceCommit },
  };
  const eventRunner = { ...f.expected, reusable: {
    repository: 'taco3064/nibfin-core', path: '.github/workflows/issue.yml',
    commit: 'c'.repeat(40), blob: gitBlob('fixture'),
  } };
  eventRunner.reusable.ref = 'taco3064/nibfin-core/.github/workflows/issue.yml@' +
    eventRunner.reusable.commit;
  if (kind === 'wake') {
    f.run.event = 'issues';
    f.run.referenced_workflows = [{
      path: eventRunner.reusable.ref, sha: eventRunner.reusable.commit,
    }];
    f.data['/contents/.github/workflows/issue.yml?ref=' +
      eventRunner.reusable.commit] = {
      type: 'file', path: eventRunner.reusable.path, sha: eventRunner.reusable.blob,
      encoding: 'base64', content: Buffer.from('fixture').toString('base64'), size: 7,
    };
    const get = f.reader.get;
    f.reader.get = path => get(path.replace(
      '/repos/taco3064/nibfin-core/', '/repos/example/core/'));
    const repository = f.reader.repository;
    f.reader.repository = name => name === 'taco3064/nibfin-core'
      ? { full_name: name, private: false } : repository(name);
  }
  f.reader.list = async (path, key) => {
    if (key === 'runners') return structuredClone(registered);
    assert.equal(path, '/repos/example/core/actions/runs/20/attempts/1/jobs');
    return [structuredClone(f.job)];
  };
  const adopted = {
    runner: f.expected, eventRunner, eventCaller: { eventName: 'issues' },
    approval: {}, isolation: { issue: { id: 'I_target' } },
  };
  context = { adopted, reader: f.reader, hostBytes: 'host', host: {
    stateRoot: root, runnerId: selected, memberId: 2, issues: { 2: adopted },
    installation: { pin: { commit: eventRunner.reusable.commit } },
  } };
  const before = await readSelectedHost(f.reader, f.expected);
  change({ f, registered, other, remove: () => { registered = [other]; } });
  const env = {
    GITHUB_REPOSITORY: 'example/core', GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_EVENT_NAME: kind === 'wake' ? 'issues' : 'workflow_dispatch',
  };
  protectedCalls = dispatches = 0;
  let result;
  try {
    result = kind === 'stage' ? await launchStage('2', 'shape', env) :
      await launchIssueWake('2', env, JSON.stringify({
        action: 'edited', issue: { number: 2, node_id: 'I_target' },
      }));
  } catch (error) {
    if (!invalid) throw error;
  }
  assert.equal(protectedCalls, kind === 'stage' && !invalid ? 1 : 0);
  assert.equal(dispatches, kind === 'wake' && !invalid ? 1 : 0);
  if (!invalid) {
    assert.equal(await readSelectedHost(f.reader, f.expected), before);
    assert.equal(result.status, kind === 'wake' ? 'dispatched' : 'pending');
  }
}

try {
  root = await mkdtemp(join(tmpdir(), 'nibfin-admission-'));
  for (const kind of ['stage', 'wake']) {
    for (const selected of [40, 41]) {
      await scenario(kind, selected);
      await scenario(kind, selected, ({ other }) => {
        other.status = 'offline'; other.busy = false;
      });
      await scenario(kind, selected, ({ registered }) => { registered.splice(1); });
    }
    for (const mutate of [
      ({ remove }) => remove(),
      ({ f, registered }) => registered.push({ ...f.runner }),
      ({ f }) => { f.runner.id = 77; },
      ({ f }) => { f.runner.name = 'forged'; },
      ({ f }) => { f.runner.labels = []; },
      ({ f }) => { f.runner.status = 'offline'; },
      ({ f }) => { f.runner.busy = false; },
      ({ f }) => { f.job.runner_id = 99; },
      ({ f }) => { f.job.runner_name = 'wrong'; },
      ({ f }) => { f.job.run_id = 99; },
      ({ f }) => { f.job.run_attempt = 2; },
      ({ f }) => { f.job.status = 'completed'; },
      ({ f }) => { f.job.head_sha = 'f'.repeat(40); },
      ({ f }) => { f.reader.list = async () => []; },
      ({ f }) => { f.reader.list = async () => [f.job, { ...f.job, id: 31 }]; },
      ({ f }) => { f.reader.list = async () => { throw new Error('403'); }; },
    ]) await scenario(kind, 40, mutate, true);
  }
  console.log('Both launcher paths: multi-host admission and rejection passed.');
} finally {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
