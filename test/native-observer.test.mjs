import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture as fixture } from './native-observer-fixture.mjs';
import { decideStage } from '../src/stages.mjs';
import { now } from './approval-fixture.mjs';
import { nativeObserver } from '../src/native-observer.mjs';
import { readSharedCaller } from '../src/shared-caller-query.mjs';

test('observer composes live grant, Issue, dependencies and Job', async (t) => {
  const f = await fixture(t),
    context = await f.observe('shape');
  assert.equal(context.runner.memberId, 1);
  assert.equal(context.route.userId, 1);
  assert.deepEqual(context.receipts, {});
  assert.equal(decideStage('shape', context, now).status, 'allowed');
});

test('observer reads live Issue edits and revocation', async (t) => {
  const f = await fixture(t);
  await f.observe('shape');
  f.issue.body = 'Edited outside protected publication';
  assert.equal(
    decideStage('shape', await f.observe('shape'), now).status,
    'allowed',
  );
  f.data['/collaborators/reviewer/permission'].permission = 'read';
  await assert.rejects(f.observe('shape'), /MEMBER_PERMISSION_REVOKED/);
});

test('offline Runner cannot fall back to another member', async (t) => {
  const f = await fixture(t);
  f.issue.assignees.push({ id: 9, login: 'backup', type: 'User' });
  f.runner.runner.status = 'offline';
  await assert.rejects(f.observe('shape'), /ACTUAL_RUNNER_BINDING_MISMATCH/);
});

test('shared stage observation uses four REST reads and sees revocation', async t => {
  const f = await fixture(t);
  const { reader, config } = f.adapters;
  const expected = config.runner;
  const issue = f.authority.record.issue;
  config.approval = { ...config.approval, kind: 'repository-admission-v1', memberId: 1,
    issueId: issue.id, issueNumber: issue.number };
  f.issue.labels = [{ name: 'scope' }];
  Object.assign(expected, {
    nativePolicy: true, target: issue, sourceAnchor: expected.sourceCommit,
  });
  f.runner.job.labels.push('nibfin-shared');
  f.runner.runner.labels.push({ name: 'nibfin-shared' });
  const reads = [];
  const get = reader.get;
  reader.get = path => {
    reads.push(path.split('/').slice(4).join('/'));
    return get(path);
  };
  reader.repository = reader.issue = reader.blockedBy = () => assert.fail('extra REST');
  let issueQueries = 0;
  reader.admissionIssue = async () => {
    issueQueries++;
    return { repository: f.authority.repo, issue: f.issue, prerequisites: [],
      dependencies: [] };
  };
  const anchor = expected.sourceAnchor;
  const current = 'c'.repeat(40);
  const commit = oid => ({ oid,
    file: { oid: expected.workflowBlob, mode: 0o100644, object: { byteSize: 42 } },
    history: { nodes: [{ oid: anchor }] } });
  const branch = {
    name: 'main', target: commit(current),
    compare: { status: 'BEHIND', baseTarget: { oid: current },
      headTarget: { oid: anchor } },
  };
  const workflow = { databaseId: expected.workflowId, state: 'ACTIVE',
    resourcePath: '/example/core/actions/workflows/execute.yml' };
  let callerQueries = 0;
  const observe = nativeObserver({
    ...f.adapters,
    hostMain: async () => ({ head: current }),
    observeSharedCaller: runner => readSharedCaller(runner, 'W_node', 'fixture',
      async (_repo, _token, _query, vars) => {
        callerQueries++;
        assert.equal(vars.workflow, 'W_node');
        return { node: workflow, repository: { databaseId: expected.repositoryId,
          nameWithOwner: expected.repository, isPrivate: false, isArchived: false,
          isDisabled: false, object: commit(anchor), defaultBranchRef: branch } };
      }),
  });
  assert.equal((await observe('shape')).pause.status, 'clear');
  assert.deepEqual(reads.sort(), [
    'actions/jobs/30', 'actions/runners/40', 'actions/runs/20', 'issues/2/events',
  ]);
  assert.equal(issueQueries, 1);
  assert.equal(callerQueries, 1);
  f.issue.labels.push({ name: 'pause' });
  assert.equal((await observe('shape')).pause.status, 'pending');
  f.runner.job.status = 'completed';
  await assert.rejects(observe('shape'), /ACTIONS_JOB_BINDING_MISMATCH/);
  f.runner.job.status = 'in_progress';
  workflow.state = 'DISABLED_MANUALLY';
  await assert.rejects(observe('shape'), /WORKFLOW_DISABLED_OR_CHANGED/);
  workflow.state = 'ACTIVE';
  branch.target.history.nodes[0].oid = current;
  await assert.rejects(observe('shape'), /CALLER_REVOKED_OR_SUPERSEDED/);
});
