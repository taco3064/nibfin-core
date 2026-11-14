import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedRepository, sharedRunner } from '../src/shared-runner.mjs';
import { readForwardedWake } from '../src/shared-wake.mjs';
import { sharedHostRegistrations } from '../src/shared-host-inspect.mjs';
import { coreRoot } from '../src/host-adoption.mjs';

const central = 'taco3064/nibfin-core';
const cli = 'taco3064/gh-nibfin';
const issue = { repository: cli, repositoryId: 2, number: 78, id: 'I_cli' };
const caller = { repository: central, repositoryId: 1 };
const runner = {
  ...caller,
  memberId: 5,
  runnerId: 42,
  workflowId: 50,
  workflowPath: '.github/workflows/shared-runner.yml',
  jobName: 'shared-stage',
};

test('host discovery exposes only the two adopted registration identities', () => {
  const host = {
    schemaVersion: 1, kind: 'single-host-linux-v1', uid: 90, runnerUid: 91,
    memberId: 5, installation: { directory: coreRoot },
    tokenFile: '/private/token',
    repository: {
      approval: { repositoryId: 1 },
      runner,
      isolation: { kind: 'linux-rootful-docker-v1' },
    },
    sharedRunner: {
      runner: { ...runner, runnerName: 'slot-1' }, caller, repositories: [1],
      additionalRunner: { uid: 92, id: 43, name: 'slot-2' },
    },
  };
  assert.deepEqual(sharedHostRegistrations(host), {
    schemaVersion: 1, repository: central, repositoryId: 1, memberId: 5,
    runners: [{ id: 42, name: 'slot-1' }, { id: 43, name: 'slot-2' }],
  });
  host.sharedRunner.additionalRunner.id = 42;
  assert.throws(() => sharedHostRegistrations(host), {
    code: 'SHARED_RUNNER_NOT_ADOPTED',
  });
});

test('the shared job keeps its native Runner and uses the slot gateway', () => {
  const executionRepository = 'example/execution';
  const host = {
    memberId: 5,
    repository: { runner: { repositoryId: 3, runnerId: 22 } },
    sharedRunner: {
      runner: { ...runner, repository: executionRepository },
      caller: { ...caller, repository: executionRepository },
      repositories: [1, 2, 3],
    },
  };
  const actual = sharedRunner(host, issue);
  assert.equal(actual.runner.repository, executionRepository);
  assert.equal(actual.runner.runnerId, 42);
  assert.deepEqual(actual.runner.target, issue);
  assert.deepEqual(actual.runner.gateway, { repositoryId: 3, runnerId: 22 });
  assert.throws(() => sharedRunner(host, { repositoryId: 4 }), {
    code: 'SHARED_RUNNER_NOT_ADOPTED',
  });
});

test('a target repository must be an installed, unambiguous peer', async () => {
  const host = {
    repository: { approval: { repositoryId: 1 } },
    wakePeerFiles: ['/etc/nibfin/host.cli.json'],
  };
  const peer = { repository: { approval: { repositoryId: 2 } } };
  assert.equal(await sharedRepository(host, 1, assert.fail), host);
  assert.equal(await sharedRepository(host, 2, async () => peer), peer);
  await assert.rejects(sharedRepository(host, 3, async () => peer), {
    code: 'SHARED_REPOSITORY_NOT_ADOPTED',
  });
});

test('forwarded wake must identify the same live adopted repository and issue', () => {
  const forwarded = {
    runId: 45,
    event: {
      action: 'closed',
      issue: { number: 78, node_id: 'I_cli' },
      repository: { id: 2, full_name: cli },
    },
  };
  const request = { inputs: {
    stage: 'wake',
    repository_id: '2',
    issue_number: '78',
    issue_id: 'I_cli',
    wake_event: JSON.stringify(forwarded),
  } };
  assert.deepEqual(readForwardedWake(JSON.stringify(request), issue), forwarded);
  assert.throws(() => readForwardedWake(JSON.stringify(request), {
    ...issue, repositoryId: 1,
  }), { code: 'INVALID_SHARED_WAKE' });
});
