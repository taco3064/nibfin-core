import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gitBlob } from '../src/identity.mjs';
import { resumeRolloutWork } from '../src/rollout-resume.mjs';
import { currentRelayOrigins, bindRelayOrigin } from '../src/relay-host.mjs';
import { providerHost } from './provider-fixture.mjs';

async function fixture() {
  const source = await readFile(new URL('../.github/workflows/shared-runner.yml',
    import.meta.url), 'utf8');
  const commit = 'a'.repeat(40);
  const actor = { id: 4, login: 'owner', type: 'User' };
  const repository = 'taco3064/nibfin-core';
  const workflowPath = '.github/workflows/shared-runner.yml';
  const items = [1, 2, 3, 4, 5, 6].map(number => ({ number,
    node_id: `I_${number}`, state: 'open', labels: [{ name: 'scope' }],
    assignees: [actor], url: `https://api.github.com/repos/${repository}` +
      `/issues/${number}` }));
  items[1].labels.push({ name: 'pause' });
  items[2].state = 'closed';
  items[3].assignees = [{ id: 8, login: 'other', type: 'User' }];
  items[5].pull_request = {};
  const f = { items, paused: false, calls: [], dependencies: new Map([[5,
    [{ state: 'open', labels: [] }]]]) };
  f.context = {
    journal: { control: async () => ({ paused: f.paused }) },
    configuration: { memberId: actor.id,
      origins: [{ repository, repositoryId: 1 }],
      runner: { repository, repositoryId: 1, workflowId: 50, workflowPath,
        sourceCommit: commit, workflowBlob: gitBlob(source) } },
    inspect: async () => {},
    reader: {
      list: async path => {
        assert.ok(path.includes('state=open&labels=scope&assignee=owner'));
        return items;
      },
      issue: async issue => items.find(item => item.number === issue.number),
      blockedBy: async issue => f.dependencies.get(issue.number) ?? [],
      repository: async () => ({ id: 1, full_name: repository,
        private: false, archived: false, disabled: false, default_branch: 'main' }),
      get: async path => {
        if (path === '/user') return actor;
        if (path.endsWith('/branches/main'))
          return { protected: true, commit: { sha: commit } };
        if (path.endsWith('/actions/workflows/50'))
          return { id: 50, path: workflowPath, state: 'active' };
        if (path.includes('/contents/')) return { type: 'file', path: workflowPath,
          sha: gitBlob(source), encoding: 'base64', size: Buffer.byteLength(source),
          content: Buffer.from(source).toString('base64') };
        throw new Error(`Unexpected read ${path}`);
      },
    },
    dispatch: async (destination, inputs) => {
      f.calls.push({ destination, inputs });
      return { runId: 60,
        url: 'https://github.com/taco3064/nibfin-core/actions/runs/60' };
    },
  };
  return f;
}

test('rollout discovers fresh origins from adoption without old relay source pins',
  async () => {
    const host = providerHost();
    host.sharedRunner.repositories = [1];
    host.repository.approval.repository = 'owner/project';
    host.repository.eventRunner = { repository: 'owner/project', repositoryId: 1,
      workflowId: 20, workflowPath: '.github/workflows/nibfin-issue.yml',
      sourceCommit: 'e'.repeat(40), workflowBlob: 'f'.repeat(40),
      reusable: { repository: 'taco3064/nibfin-core', path: '.github/workflows/issue.yml',
        commit: host.installation.pin.commit } };
    const origins = await currentRelayOrigins(host, async () => {
      throw new Error('Unexpected peer or relay configuration read');
    });
    assert.equal(origins[0].workflow.commit, 'e'.repeat(40));
    assert.equal(origins[0].workflow.blob, 'f'.repeat(40));
    assert.equal(bindRelayOrigin(host, host, origins[0]).repositoryId, 1);
  });

test('rollout continues eligible work through the native workflow', async () => {
  const f = await fixture();
  const result = await resumeRolloutWork(f.context);
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(result.results.map(item => item.number), [1]);
  assert.equal(f.calls[0].destination.ref, 'main');
  assert.deepEqual(f.calls[0].inputs, { repository_id: '1', issue_number: '1',
    issue_id: 'I_1', stage: 'continue' });
});

test('operator pause prevents all rollout continuation dispatches', async () => {
  const f = await fixture();
  f.paused = true;
  assert.equal((await resumeRolloutWork(f.context)).status, 'paused');
  assert.deepEqual(f.calls, []);
});

test('a failed authoritative read does not dispatch that Issue', async () => {
  const f = await fixture();
  f.context.reader.issue = async () => { throw new Error('GitHub unavailable'); };
  assert.equal((await resumeRolloutWork(f.context)).status, 'pending');
  assert.deepEqual(f.calls, []);
});

test('retry after dispatch failure re-observes current Issue state', async () => {
  const f = await fixture();
  const dispatch = f.context.dispatch;
  f.context.dispatch = async () => { throw new Error('Dispatch response lost'); };
  assert.equal((await resumeRolloutWork(f.context)).status, 'pending');
  f.items[0].state = 'closed';
  f.context.dispatch = dispatch;
  assert.equal((await resumeRolloutWork(f.context)).results.length, 0);
  assert.deepEqual(f.calls, []);
});

test('an interrupted scan reuses confirmed native dispatch results', async () => {
  const f = await fixture();
  const another = { ...f.items[0], number: 7, node_id: 'I_7',
    url: f.items[0].url.replace('/1', '/7') };
  f.items.push(another);
  const completed = [];
  f.context.completed = completed;
  f.context.onDispatched = async result => completed.push(result);
  const dispatch = f.context.dispatch;
  f.context.dispatch = async (destination, inputs) => {
    if (inputs.issue_number === '7') throw new Error('Temporary dispatch failure');
    return dispatch(destination, inputs);
  };
  assert.equal((await resumeRolloutWork(f.context)).status, 'pending');
  assert.equal(completed.length, 1);
  f.context.dispatch = dispatch;
  await resumeRolloutWork(f.context);
  assert.deepEqual(f.calls.map(call => call.inputs.issue_number), ['1', '7']);
});

test('an unreadable Issue does not prevent other eligible work from continuing',
  async () => {
    const f = await fixture();
    f.items.push({ ...f.items[0], number: 7, node_id: 'I_7',
      url: f.items[0].url.replace('/1', '/7') });
    const read = f.context.reader.issue;
    f.context.reader.issue = async issue => {
      if (issue.number === 1) throw Object.assign(new Error('GitHub unavailable'),
        { status: 503 });
      return read(issue);
    };
    const result = await resumeRolloutWork(f.context);
    assert.equal(result.status, 'pending');
    assert.equal(result.results[0].httpStatus, 503);
    assert.deepEqual(f.calls.map(call => call.inputs.issue_number), ['7']);
  });

test('a lost dispatch response can re-enter normal continuation for unfinished work',
  async () => {
    const f = await fixture();
    const dispatch = f.context.dispatch;
    f.context.dispatch = async (destination, inputs) => {
      await dispatch(destination, inputs);
      throw new Error('Response lost after native acceptance');
    };
    assert.equal((await resumeRolloutWork(f.context)).status, 'pending');
    f.context.dispatch = dispatch;
    assert.equal((await resumeRolloutWork(f.context)).status, 'dispatched');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.inputs.stage === 'continue'));
  });

test('pause during a partial scan leaves the remaining work resumable', async () => {
  const f = await fixture();
  f.items.push({ ...f.items[0], number: 7, node_id: 'I_7',
    url: f.items[0].url.replace('/1', '/7') });
  const completed = [];
  f.context.completed = completed;
  f.context.onDispatched = async result => { completed.push(result); f.paused = true; };
  assert.equal((await resumeRolloutWork(f.context)).status, 'paused');
  f.paused = false;
  f.context.onDispatched = async result => completed.push(result);
  assert.equal((await resumeRolloutWork(f.context)).status, 'dispatched');
  assert.deepEqual(f.calls.map(call => call.inputs.issue_number), ['1', '7']);
});
