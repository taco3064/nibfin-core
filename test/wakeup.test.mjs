import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WakeDispatcher, observeWake, fanout } from '../src/wakeup.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { now, approvalRecord } from './approval-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';

async function dispatchFixture(t, failure) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = {
    repository: 'example/core',
    repositoryId: 10,
    id: 'I_target',
    number: 2,
  };
  const workflow = {
    id: 5,
    path: '.github/workflows/nibfin.yml',
    ref: 'main',
    commit: '1'.repeat(40),
  };
  const observed = {
    issue,
    workflow,
    actorId: 3,
    approvalHash: 'a'.repeat(64),
    stateHash: 'b'.repeat(64),
    route: { userId: 1 },
  };
  let writes = 0,
    reads = 0,
    runReads = 0;
  const options = {
    token: 'fixture-token',
    journal: new OperationJournal(root, issue),
    observe: async () => {
      reads++;
      if (failure === 'revoked' && reads > 1) throw new Error('Revoked');
      if (failure === 'http' && reads > 1)
        throw Object.assign(new Error('Private provider diagnostic'), { status: 401 });
      if (failure === 'changed' && reads > 1)
        return { ...observed, stateHash: 'c'.repeat(64) };
      return observed;
    },
    fetcher: async (url, options) => {
      if (options.method === 'POST') {
        writes++;
        assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
        assert.deepEqual(JSON.parse(options.body), {
          ref: 'main',
          inputs: { issue_number: '2', issue_id: 'I_target', repository_id: '10' },
        });
        if (failure === 'disconnect') throw new Error('Lost acknowledgement');
        return {
          status: failure === 'legacy' ? 204 : 200,
          json: async () => ({
            workflow_run_id: 9,
            run_url: 'https://api.github.com/repos/example/core/actions/runs/9',
            html_url: 'https://github.com/example/core/actions/runs/9',
          }),
        };
      }
      runReads++;
      if (failure === 'readback' && runReads === 1)
        return { ok: false, status: 401 };
      return {
        ok: true,
        json: async () => ({
          id: 9,
          event: 'workflow_dispatch',
          workflow_id: 5,
          path: workflow.path,
          repository: { id: 10 },
          head_repository: { id: 10 },
          head_sha: failure === 'source' ? '2'.repeat(40) : workflow.commit,
          head_branch: 'main',
          actor: { id: 3 },
          run_attempt: 1,
        }),
      };
    },
  };
  return {
    dispatcher: new WakeDispatcher(options),
    restart: () =>
      new WakeDispatcher({
        ...options,
        journal: new OperationJournal(root, issue),
      }),
    writes: () => writes,
  };
}

test(
  'dispatch observes the returned native run without ' +
    'claiming execution and suppresses local duplicate ' +
    'effects',
  async (t) => {
    const f = await dispatchFixture(t);
    const result = await f.dispatcher.dispatch();
    assert.equal(result.status, 'scheduled');
    assert.equal(result.runId, 9);
    assert.equal(result.stageAdmitted, false);
    assert.equal((await f.restart().dispatch()).code, 'REPLAYED_OPERATION');
    assert.equal(f.writes(), 1);
  },
);

test('wake reports why its second observation failed before sending a dispatch',
  async (t) => {
    for (const [failure, code] of [
      ['http', 'GITHUB_READ_HTTP_401'], ['changed', 'WAKE_ADMISSION_CHANGED'],
    ]) {
      const f = await dispatchFixture(t, failure);
      assert.deepEqual(await f.dispatcher.dispatch(), { status: 'denied', code });
      assert.equal(f.writes(), 0);
    }
  },
);

test('wake recovers an acknowledged run after a failed read without dispatching again',
  async (t) => {
    const f = await dispatchFixture(t, 'readback');
    const first = await f.dispatcher.dispatch();
    assert.equal(first.status, 'pending');
    assert.equal(first.runId, 9);
    const resumed = await f.restart().dispatch();
    assert.equal(resumed.status, 'scheduled');
    assert.equal(resumed.runId, 9);
    assert.equal((await f.restart().dispatch()).code, 'REPLAYED_OPERATION');
    assert.equal(f.writes(), 1);
  },
);

test(
  'revocation prevents dispatch; lost/legacy responses and ' +
    'foreign source remain Pending without retry',
  async (t) => {
    for (const failure of ['revoked', 'disconnect', 'legacy', 'source']) {
      const f = await dispatchFixture(t, failure),
        result = await f.dispatcher.dispatch();
      assert.equal(result.status, failure === 'revoked' ? 'denied' : 'pending');
      const second = await f.restart().dispatch();
      if (failure !== 'revoked') assert.equal(second.code, 'EXTERNAL_EFFECT_UNKNOWN');
      assert.equal(f.writes(), failure === 'revoked' ? 0 : 1);
    }
  },
);

test(
  'hosted wake observation composes real native approval ' +
    'and live dependency/assignee reads',
  async () => {
    const record = approvalRecord();
    record.operations.push('wake');
    const f = approvalProviderFixture(record),
      member = { id: 1, login: 'member', type: 'User' };
    const issue = {
      node_id: f.record.issue.id,
      number: 2,
      state: 'open',
      body: f.record.scope.body,
      url: 'https://api.github.com/repos/example/core/issues/2',
      labels: [{ name: 'scope' }],
      assignees: [member],
    };
    const old = f.reader.get;
    f.reader.get = (path) =>
      path === '/user' ? structuredClone(f.pr.merged_by) : old(path);
    f.reader.issue = async () => structuredClone(issue);
    f.reader.blockedBy = async () => [];
    f.data['/collaborators/member/permission'] = { user: member, permission: 'write' };
    const text = 'Pinned hosted preflight recipe\n',
      workflow = {
        id: 5,
        path: '.github/workflows/nibfin.yml',
        commit: '9'.repeat(40),
        blob: gitBlob(text),
      };
    f.data['/actions/workflows/5'] = { id: 5, path: workflow.path, state: 'active' };
    f.data[`/contents/${workflow.path}?ref=${workflow.commit}`] = {
      type: 'file',
      path: workflow.path,
      sha: workflow.blob,
      encoding: 'base64',
      content: Buffer.from(text).toString('base64'),
      size: Buffer.byteLength(text),
    };
    const options = { approvalPin: f.pin, workflow, actorId: 3 };
    const observed = await observeWake(f.reader, options, () => now);
    assert.equal(observed.route.label, 'nibfin-user-1');
    issue.labels = [];
    await assert.rejects(
      observeWake(f.reader, options, () => now),
      /INACTIVE_WAKE_TARGET/,
    );
  },
);

test(
  'fanout uses current native edges and adopted targets ' +
    'only; graph changes prevent all wake effects',
  async () => {
    const upstream = {
      id: 'I_up',
      repository: 'example/up',
      number: 1,
      repositoryId: 11,
    };
    const target = {
      id: 'I_down',
      repository: 'example/down',
      number: 2,
      repositoryId: 12,
    };
    const edge = {
      node_id: target.id,
      number: target.number,
      url: 'https://api.github.com/repos/example/down/issues/2',
    };
    for (const changed of [false, true]) {
      let reads = 0,
        wakes = 0;
      const reader = {
        repository: async () => ({
          id: upstream.repositoryId,
          full_name: upstream.repository,
          private: false,
        }),
        issue: async () => ({
          node_id: upstream.id,
          number: upstream.number,
          state: 'closed',
          labels: ['scope', 'shaped', 'delivered'].map((name) => ({ name })),
          url: 'https://api.github.com/repos/example/up/issues/1',
        }),
        blocking: async () => {
          reads++;
          return changed && reads > 1 ? [] : [edge];
        },
        blockedBy: async () => [
          {
            node_id: upstream.id,
            url: 'https://api.github.com/repos/example/up/issues/1',
          },
        ],
      };
      const promise = fanout(reader, upstream, {
        approvedTarget: async (id) => (id === target.id ? target : null),
        wake: async (actual) => {
          assert.deepEqual(actual, target);
          wakes++;
          return { status: 'scheduled' };
        },
      });
      if (changed) await assert.rejects(promise, /FANOUT_GRAPH_CHANGED/);
      else assert.equal((await promise).length, 1);
      assert.equal(wakes, changed ? 0 : 1);
    }
  },
);

test(
  'fanout refuses manually closed upstream and rechecks ' + 'lifecycle before every wake',
  async () => {
    const upstream = {
      id: 'I_up',
      repository: 'example/up',
      number: 1,
      repositoryId: 11,
    };
    const target = {
      id: 'I_down',
      repository: 'example/down',
      number: 2,
      repositoryId: 12,
    };
    const url = 'https://api.github.com/repos/example/up/issues/1';
    for (const revoke of [false, true]) {
      let reads = 0,
        wakes = 0;
      const reader = {
        repository: async () => ({
          id: 11,
          full_name: upstream.repository,
          private: false,
        }),
        issue: async () => ({
          node_id: upstream.id,
          number: 1,
          state: 'closed',
          url,
          labels:
            revoke && ++reads === 1
              ? ['scope', 'shaped', 'delivered'].map((name) => ({ name }))
              : [],
        }),
        blocking: async () => [
          {
            node_id: target.id,
            number: 2,
            url: 'https://api.github.com/repos/example/down/issues/2',
          },
        ],
        blockedBy: async () => [{ node_id: upstream.id, url }],
      };
      await assert.rejects(
        fanout(reader, upstream, {
          approvedTarget: async () => target,
          wake: async () => {
            wakes++;
          },
        }),
        /UPSTREAM_NOT_DELIVERED/,
      );
      assert.equal(wakes, 0);
    }
  },
);

test('fanout skips known ineligible targets and stops on unknown effects', async () => {
  const upstream = { id: 'I_up', repository: 'example/up', number: 1, repositoryId: 11 };
  const url = 'https://api.github.com/repos/example/up/issues/1';
  const targets = [2, 3].map((number) => ({
    id: `I_${number}`,
    number,
    repository: 'example/down',
    repositoryId: 12,
  }));
  const edges = targets.map((item) => ({
    node_id: item.id,
    number: item.number,
    url: `https://api.github.com/repos/example/down/issues/${item.number}`,
  }));
  const reader = {
    repository: async () => ({ id: 11, full_name: upstream.repository, private: false }),
    issue: async () => ({
      node_id: upstream.id,
      number: 1,
      state: 'closed',
      url,
      labels: ['scope', 'shaped', 'delivered'].map((name) => ({ name })),
    }),
    blocking: async () => edges,
    blockedBy: async () => [{ node_id: upstream.id, url }],
  };
  for (const status of ['pending', 'skipped']) {
    let calls = 0;
    const results = await fanout(reader, upstream, {
      approvedTarget: async (id) => targets.find((item) => item.id === id),
      wake: async () => {
        calls++;
        return calls === 1
          ? { status, code: 'FIRST_TARGET_RESULT' }
          : { status: 'scheduled' };
      },
    });
    assert.equal(calls, status === 'pending' ? 1 : 2);
    assert.equal(results[0].result.status, status);
  }
});
