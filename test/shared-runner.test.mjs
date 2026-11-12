import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedRepository, sharedRunner } from '../src/shared-runner.mjs';
import { forwardSharedWake, readForwardedWake } from '../src/shared-wake.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('the shared job keeps its native Runner and uses the slot gateway', () => {
  const host = {
    memberId: 5,
    repository: { runner: { repositoryId: 3, runnerId: 22 } },
    sharedRunner: { runner, caller, repositories: [1, 2, 3] },
  };
  const actual = sharedRunner(host, issue);
  assert.equal(actual.runner.repository, central);
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

test('shared pause wake preserves the actor and original Issue snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nibfin-shared-pause-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'event.json');
  const sender = { id: 5, type: 'User', login: 'labeler' };
  const snapshot = {
    number: issue.number, node_id: issue.id, state: 'open',
    updated_at: '2026-11-12T00:00:00Z',
    assignees: [{ id: 6 }], labels: [{ name: 'pause' }],
  };
  const event = {
    action: 'labeled', label: { name: 'pause' }, sender, issue: snapshot,
    repository: { id: issue.repositoryId, full_name: issue.repository },
  };
  const unrelated = Array.from({ length: 100 }, (_, index) => ({
    name: `unrelated-${index}-${'x'.repeat(40)}`,
  }));
  await writeFile(path, JSON.stringify({
    ...event, issue: { ...snapshot, labels: [...snapshot.labels, ...unrelated] },
  }));
  let request;
  await forwardSharedWake({ status: 'resolved', issue_number: '78' }, {
    GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: '45', GITHUB_RUN_ATTEMPT: '1',
    NIBFIN_WAKE_TOKEN: 'fixture-only',
  }, async (_url, options) => {
    request = options.body;
    return { status: 200, json: async () => ({
      workflow_run_id: 46,
      html_url: 'https://github.com/taco3064/nibfin-core/actions/runs/46',
    }) };
  });
  assert.deepEqual(readForwardedWake(request, issue), { runId: 45, event });
});
