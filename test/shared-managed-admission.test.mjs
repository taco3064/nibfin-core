import { providerHost, providerIsolation } from './provider-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedDispatchWorkflow, sharedRunner } from '../src/shared-runner.mjs';
import { readRunnerBinding } from '../src/runner-binding.mjs';
import { readSharedCaller } from '../src/shared-caller-query.mjs';
import { consumerContract } from '../src/public-api.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

function fixture() {
  const f = runnerProviderFixture();
  const { repository, repositoryId, memberId, sourceCommit } = f.expected;
  f.repository.owner = { id: 77 };
  f.expected.actorId = memberId;
  f.run.actor = f.run.triggering_actor = f.expected.member;
  Object.assign(f.expected, {
    target: { repositoryId: 10 }, sourceAnchor: sourceCommit, nativePolicy: true,
    sharedAdmission: { kind: 'repository-admission-v1', repository, repositoryId,
      memberId, ownerId: 77 },
  });
  f.job.labels.push('nibfin-shared');
  f.runner.labels.push({ name: 'nibfin-shared' });
  f.data['/branches/main'] = { protected: false, commit: { sha: sourceCommit } };
  return f;
}

test('managed dispatch exposes verified identity and ref on an unprotected branch',
  async () => {
    const f = fixture();
    const { repository, repositoryId, workflowId, workflowPath, sourceCommit } =
      f.expected;
    assert.deepEqual(await sharedDispatchWorkflow(f.reader, f.expected), {
      repository, repositoryId, id: workflowId, path: workflowPath,
      commit: sourceCommit, ref: 'main',
    });
    for (const mutate of [
      () => { f.repository.owner.id = 78; },
      () => { f.repository.disabled = true; },
      () => { f.workflow.state = 'disabled_manually'; },
    ]) {
      const originalRepository = structuredClone(f.repository);
      const originalWorkflow = structuredClone(f.workflow);
      mutate();
      await assert.rejects(sharedDispatchWorkflow(f.reader, f.expected));
      Object.assign(f.repository, originalRepository);
      Object.assign(f.workflow, originalWorkflow);
    }
    delete f.expected.sharedAdmission;
    await assert.rejects(sharedDispatchWorkflow(f.reader, f.expected),
      { code: 'SHARED_WAKE_BRANCH_UNPROTECTED' });
  });

test('installed Core independently binds managed runs and rejects wrong assignments',
  async () => {
    const f = fixture();
    assert.equal((await readRunnerBinding(f.reader, f.expected)).runnerId, 40);
    f.job.runner_id = 99;
    await assert.rejects(readRunnerBinding(f.reader, f.expected),
      { code: 'ACTIONS_JOB_BINDING_MISMATCH' });
    f.job.runner_id = 40;
    f.expected.sharedAdmission.kind = 'unknown';
    await assert.rejects(readRunnerBinding(f.reader, f.expected),
      { code: 'SHARED_ADMISSION_POLICY_INVALID' });
    delete f.expected.sharedAdmission;
    await assert.rejects(readRunnerBinding(f.reader, f.expected),
      { code: 'CALLER_BRANCH_UNPROTECTED' });
  });

test('versioned consumers can detect native managed policy support', () => {
  assert.equal(consumerContract.managedSharedAdmission.nativeRepositoryPolicy, true);
  assert.equal(consumerContract.managedSharedAdmission.dispatchObservation,
    'sharedDispatchWorkflow');
});

function advance(f) {
  const anchor = f.expected.sourceCommit, current = 'c'.repeat(40);
  const path = f.expected.workflowPath;
  f.data['/branches/main'].commit.sha = current;
  f.data[`/contents/${path}?ref=${current}`] =
    structuredClone(f.data[`/contents/${path}?ref=${anchor}`]);
  f.data[`/compare/${anchor}...${current}`] = {
    status: 'ahead', merge_base_commit: { sha: anchor },
  };
  const history = sha =>
    `/commits?sha=${sha}&path=${encodeURIComponent(path)}&per_page=1`;
  f.data[history(anchor)] = f.data[history(current)] = [{ sha: anchor }];
  return { anchor, current, history };
}

test('managed dispatch and binding allow advancement but reject edit/restore and rewrite',
  async () => {
    const f = fixture();
    const { anchor, current, history } = advance(f);
    const observe = () => sharedDispatchWorkflow(f.reader, f.expected);
    assert.equal((await observe()).commit, current);
    const binding = await readRunnerBinding(f.reader, f.expected);
    assert.equal(binding.sourceCommit, anchor);
    f.data[history(current)] = [{ sha: current }];
    for (const run of [observe, () => readRunnerBinding(f.reader, f.expected)])
      await assert.rejects(run(), { code: 'CALLER_REVOKED_OR_SUPERSEDED' });
    f.data[history(current)] = [{ sha: anchor }];
    f.data[`/compare/${anchor}...${current}`].status = 'diverged';
    for (const run of [observe, () => readRunnerBinding(f.reader, f.expected)])
      await assert.rejects(run(), { code: 'CALLER_SOURCE_NOT_DESCENDANT' });
  });

test('managed policy binds repository, owner and member', async () => {
  const host = fixture().expected;
  for (const change of [
    { repositoryId: 11 }, { repository: 'other/repo' }, { memberId: 99 },
    { kind: 'unknown' }, { ownerId: null },
  ]) {
    const runner = { ...host, sharedAdmission: { ...host.sharedAdmission, ...change } };
    await assert.rejects(readRunnerBinding(fixture().reader, runner),
      { code: 'SHARED_ADMISSION_POLICY_INVALID' });
  }
});

test('later grouped managed observations retain owner and source revocation checks',
  async () => {
    const f = fixture(), expected = f.expected;
    const anchor = expected.sourceAnchor, current = 'd'.repeat(40);
    const commit = oid => ({ oid,
      file: { oid: expected.workflowBlob, mode: 0o100644, object: { byteSize: 42 } },
      history: { nodes: [{ oid: anchor }] },
    });
    const observed = {
      node: { databaseId: expected.workflowId, state: 'ACTIVE',
        resourcePath: '/example/core/actions/workflows/execute.yml' },
      repository: { databaseId: expected.repositoryId, nameWithOwner: expected.repository,
        isPrivate: false, isArchived: false, isDisabled: false,
        owner: { databaseId: 77 }, object: commit(anchor),
        defaultBranchRef: { name: 'main', target: commit(current),
          compare: { status: 'BEHIND', baseTarget: { oid: current },
            headTarget: { oid: anchor } } } },
    };
    const observe = runner => readSharedCaller(runner, 'W_node', 'fixture',
      async () => observed);
    const binding = await readRunnerBinding(f.reader, expected, observe);
    assert.equal(binding.sourceCommit, anchor);
    observed.repository.owner.databaseId = 78;
    await assert.rejects(readRunnerBinding(f.reader, expected, observe),
      { code: 'RUNNER_REPOSITORY_CHANGED' });
    observed.repository.owner.databaseId = 77;
    observed.repository.defaultBranchRef.target.history.nodes[0].oid = current;
    await assert.rejects(readRunnerBinding(f.reader, expected, observe),
      { code: 'CALLER_REVOKED_OR_SUPERSEDED' });
    observed.repository.defaultBranchRef.target.history.nodes[0].oid = anchor;
    observed.node.state = 'DISABLED_MANUALLY';
    await assert.rejects(readRunnerBinding(f.reader, expected, observe),
      { code: 'WORKFLOW_DISABLED_OR_CHANGED' });
  });

test('trusted host selection carries managed policy to both isolated slots', () => {
  const f = fixture(), runner = { ...f.expected,
    workflowPath: '.github/workflows/shared-runner.yml', jobName: 'shared-stage' };
  const caller = { repository: runner.repository, repositoryId: runner.repositoryId };
  const host = { ...providerHost(), memberId: runner.memberId, runnerUid: 91,
    repository: { runner, isolation: providerIsolation },
    sharedRunner: { runner, caller, repositories: [10, 11],
      additionalRunner: { uid: 92, id: 41, name: 'slot-2' } },
  };
  for (const uid of [91, 92]) {
    const selected = sharedRunner(host, { repositoryId: 11 }, uid).runner;
    assert.deepEqual(selected.sharedAdmission, runner.sharedAdmission);
    assert.equal(selected.runnerId, uid === 91 ? 40 : 41);
  }
  assert.throws(() => sharedRunner(host, { repositoryId: 12 }),
    { code: 'SHARED_RUNNER_NOT_ADOPTED' });
  host.sharedRunner.runner.sharedAdmission = {
    ...runner.sharedAdmission, repositoryId: 99,
  };
  assert.throws(() => sharedRunner(host, { repositoryId: 11 }),
    { code: 'SHARED_ADMISSION_POLICY_INVALID' });
});
