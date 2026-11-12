import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observeIssueEvent,
  fanoutOutcome,
  resolveIssueWake,
  dispatchIssueWake,
} from '../src/issue-wake.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { resolveWakeDispatch } from '../src/wake-entry.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    path: '.github/workflows/nibfin.yml',
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

function pauseRouteFixture(restore = true) {
  const f = fixture('issue');
  f.adoption.eventWorkflow = f.adoption.issues[0].workflow;
  f.invocation.eventName = 'issues';
  f.run.event = 'issues';
  f.run.referenced_workflows[0].path =
    'taco3064/nibfin-core/.github/workflows/issue.yml@' + f.adoption.coreCommit;
  const actor = { id: 8, login: 'labeler', type: 'User' };
  f.run.actor = actor;
  f.run.triggering_actor = actor;
  f.data['/collaborators/labeler/permission'] = { user: actor, permission: 'triage' };
  const events = f.data['/issues/2/events'];
  const change = (user, present) => {
    const id = events.length + 1;
    events.push({ id, event: present ? 'labeled' : 'unlabeled',
      label: { name: 'pause' }, actor: user, created_at: '2026-11-03T00:00:00Z',
      url: `https://api.github.com/repos/example/core/issues/events/${id}` });
    f.issue.labels = f.issue.labels.filter(label => label.name !== 'pause');
    if (present) f.issue.labels.push({ name: 'pause' });
    f.issue.updated_at = events.at(-1).created_at;
  };
  if (restore) {
    change({ id: 1, login: 'writer', type: 'User' }, true);
    change(actor, false);
  } else {
    change(actor, true);
    f.issue.labels = f.issue.labels.filter(label => label.name !== 'scope');
  }
  const event = { repository: f.repo, issue: structuredClone(f.issue),
    action: restore ? 'unlabeled' : 'labeled', label: { name: 'pause' },
    sender: actor };
  return { ...f, event, change };
}

test('read-only pause resolver routes repair despite paused or unknown eligibility',
  async t => {
    t.mock.method(Date, 'now', () => now);
    const f = pauseRouteFixture();
    f.data['/issues/2/events'] = null;
    f.issue.assignees = [];
    const result = await resolveIssueWake(f.reader, f.adoption, f.event, f.invocation);
    assert.equal(result.member_id, '3');
    assert.equal(result.stageAdmitted, false);
    f.event.sender = { ...f.event.sender, id: 99 };
    await assert.rejects(
      resolveIssueWake(f.reader, f.adoption, f.event, f.invocation),
      /PAUSE_EVENT_ACTOR_CHANGED/,
    );
  });

test('ordinary wake refuses transient absence and resumes only coherent native removal',
  async () => {
    const f = fixture();
    const events = f.data['/issues/2/events'];
    const change = (actor, present) => {
      const id = events.length + 1;
      events.push({ id, actor, event: present ? 'labeled' : 'unlabeled',
        label: { name: 'pause' }, created_at: '2026-11-03T00:00:00Z',
        url: `https://api.github.com/repos/example/core/issues/events/${id}` });
      f.issue.labels = f.issue.labels.filter(label => label.name !== 'pause');
      if (present) f.issue.labels.push({ name: 'pause' });
    };
    const writer = { id: 1, login: 'writer', type: 'User' };
    change(writer, true);
    change({ id: 8, login: 'other', type: 'User' }, false);
    await assert.rejects(f.resolve(), /PAUSE_NOT_PROVEN_CLEAR/);
    // Later assignment or permission loss must not erase the effective actor.
    f.issue.assignees = [];
    await assert.rejects(f.resolve(), /PAUSE_NOT_PROVEN_CLEAR/);
    f.issue.assignees = [writer];
    f.data['/collaborators/writer/permission'].permission = 'read';
    await assert.rejects(f.resolve(), /PAUSE_NOT_PROVEN_CLEAR/);
    f.data['/collaborators/writer/permission'].permission = 'write';
    change(writer, true);
    change(f.pr.merged_by, false);
    assert.equal((await f.resolve()).stage, 'shape');
    f.data['/issues/2/events'] = null;
    await assert.rejects(f.resolve(), /PAUSE_NOT_PROVEN_CLEAR/);
  });

test('existing trusted event entry repairs only pause before ordinary wake eligibility',
  async t => {
    t.mock.method(Date, 'now', () => now);
    for (const restore of [true, false]) {
      const f = pauseRouteFixture(restore);
      const root = await mkdtemp(join(tmpdir(), 'nibfin-pause-route-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      let writes = 0, inspections = 0;
      const options = { reader: f.reader, adoption: f.adoption, event: f.event,
        invocation: f.invocation, token: 'fixture-only', stateRoot: root,
        inspect: async () => { inspections++; },
        fetcher: async (url, request) => {
          if (url === 'https://api.github.com/user')
            return { ok: true, json: async () => structuredClone(f.pr.merged_by) };
          writes++;
          assert.ok(url.endsWith(restore ? '/labels' : '/labels/pause'));
          assert.equal(request.method, restore ? 'POST' : 'DELETE');
          f.change(f.pr.merged_by, restore);
          return { ok: true, json: async () => f.issue.labels };
        } };
      const result = await dispatchIssueWake(options);
      assert.equal(result.status, 'skipped');
      assert.equal(writes, 1);
      assert.ok(inspections >= 3);
      assert.equal(f.issue.labels.some(label => label.name === 'pause'), restore);
      assert.equal((await dispatchIssueWake(options)).status, 'skipped');
      assert.equal(writes, 1);
    }
  });

test('repository admission routes pause repair even with no scope or assignment',
  async t => {
    t.mock.method(Date, 'now', () => now);
    const f = pauseRouteFixture(false);
    const old = f.adoption.issues[0];
    f.adoption.issues = [];
    f.adoption.repository = { ...old, approvalPin: {
      kind: 'repository-admission-v1', repository: 'example/core',
      repositoryId: 10, memberId: 3, source: old.approvalPin.source,
    } };
    f.issue.assignees = [];
    const result = await resolveIssueWake(f.reader, f.adoption, f.event, f.invocation);
    assert.equal(result.member_id, '3');
    assert.equal(result.stageAdmitted, false);
  });

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
  'fixed workflow rejects a substituted Core revision ' +
    'before checkout or token-bearing execution',
  async () => {
    const workflow = (
      await readFile(new URL('../.github/workflows/wake.yml', import.meta.url), 'utf8')
    ).replaceAll('\r\n', '\n');
    const match = /node --input-type=module <<'NODE'\n([\s\S]+?)\n\s+NODE/.exec(workflow);
    assert.ok(match);
    assert.ok(match.index < workflow.indexOf('- uses: actions/checkout@'));
    assert.ok(
      workflow.indexOf('NIBFIN_READ_TOKEN: ${{ secrets.NIBFIN_READ_TOKEN }}') >
        match.index,
    );
    const commit = 'a'.repeat(40);
    for (const [value, success] of [
      [commit, true],
      ['b'.repeat(40), false],
      ['main', false],
    ]) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', match[1]], {
        env: {
          CORE_COMMIT: value,
          WAKE_ADOPTION: JSON.stringify({ coreCommit: commit }),
        },
      });
      assert.equal(child.status === 0, success);
      assert.equal(child.stdout.length, 0);
    }
  },
);

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
