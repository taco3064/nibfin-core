import test from 'node:test';
import assert from 'node:assert/strict';
import { readProtectedApproval } from '../src/github-approval.mjs';
import { repositoryIssuePin } from '../src/repository-admission.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { readIssueQuery } from '../src/github-issue-query.mjs';
import { readRunnerBinding } from '../src/runner-binding.mjs';
import { readDependencies } from '../src/dependencies.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { now } from './approval-fixture.mjs';

test('native Scope and assignment admit new Issues under one repository policy',
  async () => {
    const f = approvalProviderFixture();
    const member = f.pr.merged_by;
    const policy = {
      kind: 'repository-admission-v1',
      repository: f.pin.repository,
      repositoryId: f.pin.repositoryId,
      memberId: member.id,
      source: f.pin.source,
    };
    const issue = { ...f.record.issue, number: 42, id: 'I_new' };
    const pin = repositoryIssuePin(policy, issue);
    const live = {
      node_id: issue.id, number: issue.number, state: 'open', body: 'Scope',
      url: 'https://api.github.com/repos/example/core/issues/42',
      labels: [{ name: 'scope' }], assignees: [member],
    };
    f.reader.issue = async () => structuredClone(live);
    f.reader.blockedBy = async () => [];
    f.reader.get = async path => assert.fail(
      'Repository admission should not read ' + path,
    );
    const first = await readProtectedApproval(f.reader, pin, now);
    assert.deepEqual(first.record.issue, issue);
    live.body = 'Published Shape';
    const second = await readProtectedApproval(f.reader, pin, now);
    assert.equal(second.record.scope.body, live.body);
    assert.deepEqual(evidenceBinding({ approval: first }),
      evidenceBinding({ approval: second }));

    live.assignees = [];
    await assert.rejects(readProtectedApproval(f.reader, pin, now),
      /WAKE_TARGET_NOT_READY/);
  });

test('grouped repository admission uses one query and falls back on incomplete data',
  async () => {
    const f = approvalProviderFixture();
    const member = f.pr.merged_by;
    const issue = f.record.issue;
    const policy = {
      kind: 'repository-admission-v1', repository: issue.repository,
      repositoryId: issue.repositoryId, memberId: member.id, source: f.pin.source,
    };
    const pin = repositoryIssuePin(policy, issue);
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    const repo = {
      databaseId: issue.repositoryId, nameWithOwner: issue.repository,
      isPrivate: false, isArchived: false, isDisabled: false,
      defaultBranchRef: { name: 'main' },
      issue: { id: issue.id, number: issue.number, body: 'Scope', state: 'OPEN',
        assignees: connection([{ databaseId: member.id, login: member.login }]),
        labels: connection([{ name: 'scope' }]), blockedBy: connection([]) },
    };
    let queries = 0;
    let reads = 0;
    const grouped = () => readIssueQuery(issue, 'fixture', async () => {
      queries++;
      return repo;
    });
    const live = (await grouped()).issue;
    queries = 0;
    const reader = {
      repository: async () => { reads++; return f.repo; },
      issue: async () => { reads++; return live; },
      blockedBy: async () => { reads++; return []; },
    };
    const rest = await readProtectedApproval(reader, pin, now);
    assert.equal(reads, 3);
    reader.admissionIssue = () => grouped().catch(() => undefined);
    reads = 0;
    const graph = await readProtectedApproval(reader, pin, now);
    assert.deepEqual(graph.record, rest.record);
    assert.equal(reads, 0);
    assert.equal(queries, 1);
    repo.issue.blockedBy.pageInfo.hasNextPage = true;
    assert.deepEqual((await readProtectedApproval(reader, pin, now)).record, rest.record);
    assert.equal(reads, 3);
  });

test('shared Runner verifies the same current workflow revision only once', async () => {
  const f = runnerProviderFixture();
  const { sourceCommit, workflowPath } = f.expected;
  Object.assign(f.expected, {
    target: { repositoryId: 10 }, sourceAnchor: sourceCommit, nativePolicy: true,
  });
  f.job.labels.push('nibfin-shared');
  f.runner.labels.push({ name: 'nibfin-shared' });
  f.data['/branches/main'] = { commit: { sha: sourceCommit } };
  const get = f.reader.get;
  const reads = [];
  f.reader.get = path => { reads.push(path); return get(path); };
  await readRunnerBinding(f.reader, f.expected);
  assert.equal(reads.filter(path => path.includes('/contents/' + workflowPath)).length,
    1);
});

test('grouped prerequisites need only one REST read-back and preserve edge checks',
  async () => {
    const f = approvalProviderFixture();
    const issue = f.record.issue;
    const other = { ...issue, id: 'I_prerequisite', number: issue.number + 1 };
    const url = number =>
      `https://api.github.com/repos/${issue.repository}/issues/${number}`;
    const target = { node_id: issue.id, number: issue.number,
      state: 'open', url: url(issue.number) };
    const dependency = { node_id: other.id, number: other.number,
      state: 'closed', url: url(other.number),
      labels: ['scope', 'shaped', 'delivered'].map(name => ({ name })) };
    let reads = 0;
    let edges = [dependency];
    const reader = {
      issue: async () => { reads++; return dependency; },
      blockedBy: async () => { reads++; return edges; },
    };
    const observed = { repository: f.repo, issue: target };
    assert.equal((await readDependencies(reader, issue, [other], observed)).ready, true);
    assert.equal(reads, 3);
    reads = 0;
    observed.dependencies = [{
      identity: other, state: dependency.state, labels: dependency.labels,
    }];
    assert.equal((await readDependencies(reader, issue, [other], observed)).ready, true);
    assert.equal(reads, 1);
    edges = [];
    await assert.rejects(readDependencies(reader, issue, [other], observed),
      /Blocked by changed/);
  });
