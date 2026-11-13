import { pauseFixture, people } from './pause-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observeIssueEvent,
  fanoutOutcome,
  resolveIssueWake,
  resolveSharedIssueWake,
  dispatchIssueWake,
} from '../src/issue-wake.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { resolveWakeDispatch } from '../src/wake-entry.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';
import { readFile } from 'node:fs/promises';

function fixture(kind = 'wake') {
  const record = approvalRecord();
  record.operations.push('wake');
  record.source.repository = 'taco3064/nibfin-core';
  const f = approvalProviderFixture(record),
    member = { id: 1, login: 'writer', type: 'User' };
  const issue = {
    node_id: record.issue.id,
    number: 2,
    state: 'open',
    body: record.scope.body,
    url: 'https://api.github.com/repos/example/core/issues/2',
    labels: [{ name: 'scope' }],
    assignees: [member],
  };
  const body = callerRecipe(kind, record.source.commit);
  const workflow = {
    id: 5,
    path: kind === 'issue' ? '.github/workflows/nibfin-issue.yml'
      : '.github/workflows/nibfin.yml',
    commit: '9'.repeat(40),
    blob: gitBlob(body),
  };
  f.data['/collaborators/writer/permission'] = { user: member, permission: 'write' };
  f.data['/actions/workflows/5'] = { id: 5, path: workflow.path, state: 'active' };
  f.data[`/contents/${workflow.path}?ref=${workflow.commit}`] = {
    type: 'file',
    path: workflow.path,
    sha: workflow.blob,
    encoding: 'base64',
    content: Buffer.from(body).toString('base64'),
    size: Buffer.byteLength(body),
  };
  const run = {
    id: 80,
    run_attempt: 1,
    event: 'workflow_dispatch',
    status: 'in_progress',
    workflow_id: 5,
    path: workflow.path,
    head_sha: workflow.commit,
    head_branch: 'main',
    repository: f.repo,
    head_repository: f.repo,
    actor: f.pr.merged_by,
    triggering_actor: f.pr.merged_by,
    referenced_workflows: [
      {
        path: `taco3064/nibfin-core/.github/workflows/wake.yml@${record.source.commit}`,
        sha: record.source.commit,
      },
    ],
  };
  f.data['/actions/runs/80'] = run;
  const original = f.reader.get;
  f.reader.get = async (path) =>
    path === '/user' ? structuredClone(f.pr.merged_by) : original(path);
  f.reader.issue = async () => structuredClone(issue);
  f.reader.blockedBy = async () => [];
  const adoption = {
    schemaVersion: 1,
    coreCommit: record.source.commit,
    issues: [{ approvalPin: f.pin, workflow, actorId: 3 }],
  };
  const event = {
    repository: f.repo,
    inputs: { issue_number: '2', issue_id: record.issue.id, repository_id: '10' },
  };
  const invocation = {
    coreCommit: record.source.commit,
    repository: 'example/core',
    eventName: 'workflow_dispatch',
    runId: 80,
    attempt: 1,
  };
  return {
    ...f,
    issue,
    run,
    adoption,
    event,
    invocation,
    resolve: () => resolveWakeDispatch(f.reader, adoption, event, invocation, () => now),
  };
}

test(
  'dispatch Issue identity resolves to current authorized ' +
    'stage/member inputs with no execution grant',
  async () => {
    const f = fixture();
    assert.deepEqual(await f.resolve(), {
      status: 'resolved',
      issue_number: '2',
      member_id: '1',
      stage: 'shape',
      stageAdmitted: false,
    });
    f.issue.labels.push({ name: 'shaped' });
    f.issue.body = 'Current published Shape';
    assert.equal((await f.resolve()).stage, 'deliver');
  },
);

test(
  'untrusted dispatch overrides, source/caller changes and ' +
    'ineligible work cannot select a Runner',
  async () => {
    const mutations = [
      (f) => {
        f.event.inputs.stage = 'merge';
      },
      (f) => {
        f.event.inputs.member_id = '999';
      },
      (f) => {
        f.event.inputs.issue_number = '3';
      },
      (f) => {
        f.event.inputs.repository_id = '99';
      },
      (f) => {
        f.invocation.eventName = 'pull_request';
      },
      (f) => {
        f.invocation.attempt = 2;
      },
      (f) => {
        f.run.actor = { id: 99 };
      },
      (f) => {
        f.run.triggering_actor = { id: 99 };
      },
      (f) => {
        f.run.head_sha = 'b'.repeat(40);
      },
      (f) => {
        f.run.referenced_workflows = [];
      },
      (f) => {
        f.run.referenced_workflows[0].path =
          'taco3064/nibfin-core/.github/workflows/wake.yml@main';
      },
      (f) => {
        f.run.referenced_workflows.push({
          path: 'other/core/.github/workflows/evil.yml@main',
          sha: f.adoption.coreCommit,
        });
      },
      (f) => {
        f.adoption.coreCommit = 'b'.repeat(40);
      },
      (f) => {
        f.adoption.issues.push(f.adoption.issues[0]);
      },
      (f) => {
        f.issue.labels = [];
      },
      (f) => {
        f.issue.labels.push({ name: 'delivered' });
      },
      (f) => {
        f.issue.assignees = [];
      },
      (f) => {
        f.data['/collaborators/writer/permission'].permission = 'read';
      },
      (f) => {
        f.issue.body = ' ';
      },
      (f) => {
        f.reader.blockedBy = async () => [{ node_id: 'I_foreign' }];
      },
    ];
    for (const change of mutations) {
      const f = fixture();
      change(f);
      await assert.rejects(f.resolve());
    }
  },
);

test(
  'resolution accepts only the pinned wake/stage chain, ' + 'independent of API ordering',
  async () => {
    const f = fixture();
    f.run.referenced_workflows.unshift({
      path: `taco3064/nibfin-core/.github/workflows/stage.yml@${f.adoption.coreCommit}`,
      sha: f.adoption.coreCommit,
    });
    assert.equal((await f.resolve()).stage, 'shape');
    f.run.referenced_workflows.push(f.run.referenced_workflows[0]);
    await assert.rejects(f.resolve(), /UNTRUSTED_WAKE_CALLER/);
  },
);

test('caller rerun during resolution invalidates routing before any output', async () => {
  const f = fixture(),
    original = f.reader.get;
  let reads = 0;
  f.reader.get = async (path) => {
    if (path.endsWith('/actions/runs/80') && ++reads === 2) f.run.run_attempt = 2;
    return original(path);
  };
  await assert.rejects(f.resolve(), /UNTRUSTED_WAKE_CALLER/);
});

test(
  'Issue events are hosted locators bound to adopted ' +
    'caller source; reruns and forks deny',
  async () => {
    const f = fixture('issue');
    f.adoption.eventWorkflow = f.adoption.issues[0].workflow;
    f.invocation.eventName = 'issues';
    f.run.event = 'issues';
    f.run.referenced_workflows[0].path =
      'taco3064/nibfin-core/.github/workflows/issue.yml@' + f.adoption.coreCommit;
    const event = {
      repository: f.repo,
      action: 'labeled',
      label: { name: 'scope' },
      issue: f.issue,
    };
    const observe = () => observeIssueEvent(f.reader, f.adoption, event, f.invocation);
    assert.deepEqual(await observe(), {
      repository: 'example/core',
      repositoryId: 10,
      number: 2,
      id: 'I_target',
    });
    for (const action of ['assigned', 'reopened', 'closed']) {
      event.action = action;
      await observe();
    }
    event.action = 'labeled';
    event.label.name = 'shaped';
    await assert.rejects(observe(), /UNSUPPORTED_ISSUE_EVENT/);
    event.label.name = 'scope';
    f.invocation.attempt = 2;
    await assert.rejects(observe(), /INVALID_ISSUE_WAKE/);
    f.invocation.attempt = 1;
    f.run.head_repository = { id: 999 };
    await assert.rejects(observe(), /UNTRUSTED_ISSUE_EVENT_RUN/);
    f.run.head_repository = f.repo;
    f.run.head_sha = 'b'.repeat(40);
    await assert.rejects(observe());
  },
);

test('shared Issue wake uses the GitHub workflow identity without an adoption secret',
  async () => {
    const f = fixture('issue');
    const commit = f.invocation.coreCommit;
    f.run.event = f.invocation.eventName = 'issues';
    f.run.referenced_workflows[0].path =
      `taco3064/nibfin-core/.github/workflows/issue.yml@${commit}`;
    f.issue.assignees = [f.pr.merged_by];
    const event = { repository: f.repo, action: 'assigned', issue: f.issue };
    const invocation = { ...f.invocation, shared: true };
    const resolve = () => resolveSharedIssueWake(f.reader, event, invocation);
    assert.deepEqual(await resolve(), {
      status: 'resolved', issue_number: '2',
      member_id: String(f.pr.merged_by.id), stageAdmitted: false,
    });
    f.reader.blockedBy = async () => [{ state: 'open' }];
    await assert.rejects(resolve(), /WAKE_TARGET_NOT_READY/);
    event.action = 'labeled';
    event.label = { name: 'pause' };
    event.sender = f.pr.merged_by;
    assert.equal((await resolve()).status, 'resolved');
    event.action = 'closed';
    f.issue.state = 'closed';
    f.issue.labels.push({ name: 'shaped' }, { name: 'delivered' });
    assert.equal((await resolve()).status, 'resolved');
    invocation.coreCommit = 'f'.repeat(40);
    await assert.rejects(resolve(), /UNTRUSTED_ISSUE_EVENT_RUN/);
  });

test('shared Issue wake checks out the reusable workflow source provided by GitHub',
  async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/issue.yml', import.meta.url), 'utf8',
    );
    assert.ok(workflow.includes('repository: ${{ job.workflow_repository }}'));
    assert.ok(workflow.includes('ref: ${{ job.workflow_sha }}'));
    assert.ok(workflow.includes('NIBFIN_CORE_COMMIT: ${{ job.workflow_sha }}'));
    assert.ok(!workflow.includes('inputs.core_commit'));
  });

test('the installed Core can read a forwarded event from before a rollout', async () => {
  const f = fixture('issue');
  const workflow = f.adoption.eventWorkflow = f.adoption.issues[0].workflow;
  const current = f.adoption.coreCommit;
  const old = 'f'.repeat(40);
  f.run.event = f.invocation.eventName = 'issues';
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  f.run.referenced_workflows = [{
    path: `taco3064/nibfin-core/.github/workflows/issue.yml@${old}`, sha: old,
  }];
  const oldHead = 'e'.repeat(40);
  f.run.head_sha = oldHead;
  const source = f.data[`/contents/${workflow.path}?ref=${workflow.commit}`];
  f.data[`/contents/${workflow.path}?ref=${oldHead}`] = {
    ...source, content: Buffer.from(callerRecipe('issue', old)).toString('base64'),
  };
  const event = { repository: f.repo, action: 'assigned', issue: f.issue };
  const observe = () => observeIssueEvent(f.reader, f.adoption, event, {
    ...f.invocation, forwarded: true,
  });
  assert.equal((await observe()).id, f.issue.node_id);
  f.run.referenced_workflows[0].sha = current;
  await assert.rejects(observe(), /UNTRUSTED_ISSUE_EVENT_RUN/);
});

test('fanout preserves unknown and denied dispatch results at the CLI boundary', () => {
  const results = [
    { issueId: 'I_one', result: { status: 'scheduled', runId: 1 } },
    { issueId: 'I_two', result: { status: 'pending', code: 'DISPATCH_RESULT_UNKNOWN' } },
  ];
  assert.equal(fanoutOutcome(results).status, 'pending');
  assert.deepEqual(fanoutOutcome(results).results, results);
  results[1].result.status = 'denied';
  assert.equal(fanoutOutcome(results).status, 'denied');
});

test(
  'manual closure is refused before Runner routing or ' + 'durable dispatch intent',
  async () => {
    const f = fixture('issue');
    f.adoption.eventWorkflow = f.adoption.issues[0].workflow;
    f.invocation.eventName = 'issues';
    f.run.event = 'issues';
    f.run.referenced_workflows[0].path =
      'taco3064/nibfin-core/.github/workflows/issue.yml@' + f.adoption.coreCommit;
    f.issue.state = 'closed';
    const event = { repository: f.repo, action: 'closed', issue: f.issue };
    await assert.rejects(
      resolveIssueWake(f.reader, f.adoption, event, f.invocation),
      /UPSTREAM_NOT_DELIVERED/,
    );
    const result = await dispatchIssueWake({
      reader: f.reader,
      adoption: f.adoption,
      event,
      invocation: f.invocation,
      token: 'fixture-not-used',
      stateRoot: '/nonexistent/must-not-create',
      inspect: () => assert.fail('No journal admission expected'),
      fetcher: () => assert.fail('No dispatch expected'),
    });
    assert.deepEqual(result, { status: 'denied', code: 'UPSTREAM_NOT_DELIVERED' });
  },
);

test('pause reconciliation traverses read-only routing and authenticated controller',
  async t => {
  const f = fixture('issue');
  t.mock.method(Date, 'now', () => now);
  const p = await pauseFixture(t);
  Object.assign(p.repository, f.repo, { owner: f.pr.merged_by });
  p.issue.body = f.record.scope.body;
  p.issue.assignees = f.issue.assignees;
  f.reader.repository = p.reader.repository;
  f.reader.issue = p.reader.issue;
  const list = f.reader.list;
  f.reader.list = path => path.endsWith('/events') ? p.reader.list(path) : list(path);
  f.adoption.eventWorkflow = f.adoption.issues[0].workflow;
  f.invocation.eventName = 'issues';
  f.run.event = 'issues';
  f.run.referenced_workflows[0].path =
    'taco3064/nibfin-core/.github/workflows/issue.yml@' + f.adoption.coreCommit;
  const dispatch = event => dispatchIssueWake({
    reader: f.reader, adoption: f.adoption, invocation: f.invocation,
    event: { ...event, repository: f.repo }, token: 'fixture-token',
    stateRoot: p.root, inspect: async () => {}, fetcher: p.fetcher,
  });
  const pause = p.emit(f.pr.merged_by, 'labeled');
  const route = await resolveIssueWake(f.reader, f.adoption,
    { ...pause, repository: f.repo }, f.invocation);
  assert.equal(route.status, 'resolved');
  assert.equal(route.stageAdmitted, false);
  assert.deepEqual(await dispatch(pause), { status: 'skipped', code: 'ISSUE_PAUSED' });
  f.data['/collaborators/stranger/permission'] = {
    user: people.stranger, permission: 'write',
  };
  const removal = p.emit(people.stranger, 'unlabeled');
  f.run.actor = people.stranger;
  f.run.triggering_actor = people.stranger;
  assert.equal((await resolveIssueWake(f.reader, f.adoption,
    { ...removal, repository: f.repo }, f.invocation)).status, 'resolved');
  assert.deepEqual(await dispatch(removal), { status: 'skipped', code: 'ISSUE_PAUSED' });
  assert.equal(p.writes(), 1);
  const forged = { ...removal, sender: f.pr.merged_by, repository: f.repo };
  await assert.rejects(observeIssueEvent(f.reader, f.adoption, forged, f.invocation),
    /UNTRUSTED_PAUSE_ACTOR/);
});
