import test from 'node:test';
import assert from 'node:assert/strict';
import { hostWakeAdoption } from '../src/host-issue-wake.mjs';
import { hostWakeExecution, hostExecution } from '../src/host-launcher.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

test('event entry derives only fixed host adoption and a distinct execution', () => {
  const { expected: runner } = runnerProviderFixture();
  const commit = 'c'.repeat(40);
  const adopted = {
    runner,
    approval: { issueId: 'I_target' },
    eventRunner: {
      ...runner,
      reusable: {
        repository: 'taco3064/nibfin-core',
        path: '.github/workflows/issue.yml',
        commit,
      },
    },
    eventCaller: { eventName: 'issues' },
  };
  const host = {
    runnerId: runner.runnerId,
    memberId: runner.memberId,
    installation: { pin: { commit } },
    issues: { 2: adopted },
  };
  const result = hostWakeAdoption(host, adopted);
  assert.equal(result.coreCommit, commit);
  assert.deepEqual(result.issues[0].approvalPin, adopted.approval);
  assert.equal(result.issues[0].actorId, host.memberId);
  const actionAdopted = structuredClone(adopted);
  actionAdopted.runner.actionCommit = 'd'.repeat(40);
  const actionHost = { ...host, issues: { 2: actionAdopted } };
  const actionWake = hostWakeAdoption(actionHost, actionAdopted);
  assert.equal(actionWake.issues[0].workflow.actionCommit, 'd'.repeat(40));
  assert.equal(actionWake.eventWorkflow.actionCommit, undefined);
  const event = hostWakeExecution(runner);
  assert.equal(event.role, 'publisher');
  assert.notEqual(event.id, hostExecution(runner, 'publish-shape').id);
  assert.notEqual(event.sessionId, hostExecution(runner, 'publish-shape').sessionId);
  for (const mutate of [
    (item) => {
      item.eventRunner.runnerId++;
    },
    (item) => {
      item.eventRunner.memberId++;
    },
    (item) => {
      item.eventRunner.repositoryId++;
    },
    (item) => {
      item.eventRunner.reusable.commit = 'd'.repeat(40);
    },
    (item) => {
      item.eventRunner.reusable.path = '.github/workflows/stage.yml';
    },
    (item) => {
      item.eventCaller.eventName = 'workflow_dispatch';
    },
    (item) => {
      item.eventRunner.wakeWorkflow = {};
    },
  ]) {
    const changed = structuredClone(adopted);
    mutate(changed);
    assert.throws(() => hostWakeAdoption(host, changed), /EVENT_HOST_NOT_ADOPTED/);
  }
});
