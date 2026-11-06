import test from 'node:test';
import assert from 'node:assert/strict';
import { readPullRequestCI, checkoutIdentity } from '../src/github-ci.mjs';
import { gitBlob } from '../src/identity.mjs';
import { now } from './approval-fixture.mjs';
import mergedRunObservation from './merged-run-observation.json' with { type: 'json' };
import { rulesetFixture } from './ruleset-fixture.mjs';

function checkoutLog(sha, marker = '[command]/usr/bin/git log -1 --format=%H') {
  return `2026-11-03T02:00:01.000Z ${marker}\n` + `2026-11-03T02:00:01.100Z ${sha}\n`;
}

test('CI uses the same adopted protection and refuses ruleset drift', async () => {
  const f = fixture(),
    adopted = rulesetFixture(f.policy);
  f.expected.ruleset = adopted.pin;
  f.data[`/rulesets/${adopted.value.id}`] = adopted.value;
  f.data['/rules/branches/main'] = adopted.rules;
  const result = await readPullRequestCI(f.reader, f.expected, now);
  assert.equal(result.protectionHash, adopted.hash);
  adopted.value.bypass_actors.push({ actor_type: 'RepositoryRole', actor_id: 5 });
  await assert.rejects(
    readPullRequestCI(f.reader, f.expected, now),
    /RULESET_NOT_ADOPTED/,
  );
});

function fixture() {
  const head = '1'.repeat(40),
    base = '2'.repeat(40),
    preview = '3'.repeat(40),
    body = '# trusted checkout recipe\n';
  const workflow = {
    context: 'verify',
    appId: 15368,
    workflowId: 50,
    path: '.github/workflows/ci.yml',
    blob: gitBlob(body),
    checkoutStep: 2,
    checkoutName: `Run actions/checkout@${'4'.repeat(40)}`,
  };
  const expected = {
    repository: 'example/core',
    repositoryId: 10,
    id: 'PR_1',
    number: 7,
    head,
    base,
    workflows: [workflow],
    reviewers: [2],
  };
  const repository = {
    id: 10,
    full_name: 'example/core',
    private: false,
    default_branch: 'main',
  };
  const pr = {
    node_id: 'PR_1',
    number: 7,
    state: 'open',
    draft: false,
    merged: false,
    user: { id: 1 },
    head: { sha: head, repo: repository },
    base: { sha: base, ref: 'main', repo: repository },
    mergeable: true,
    mergeable_state: 'clean',
    merge_commit_sha: preview,
  };
  const reviewer = { id: 2, login: 'reviewer', type: 'User' };
  const reviews = [
    {
      id: 11,
      user: reviewer,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-11-03T01:00:00Z',
    },
  ];
  const policy = {
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      require_code_owner_reviews: false,
    },
    required_status_checks: {
      strict: true,
      checks: [{ context: 'verify', app_id: 15368 }],
      contexts: ['verify'],
    },
  };
  const check = {
    id: 60,
    name: 'verify',
    app: { id: 15368 },
    check_suite: { id: 70 },
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
  };
  const run = {
    id: 80,
    run_attempt: 1,
    repository,
    head_repository: repository,
    head_sha: head,
    workflow_id: 50,
    path: workflow.path,
    check_suite_id: 70,
    status: 'completed',
    conclusion: 'success',
    event: 'pull_request',
    pull_requests: [pr],
  };
  const job = {
    id: 90,
    run_id: 80,
    run_attempt: 1,
    head_sha: head,
    name: 'verify',
    status: 'completed',
    conclusion: 'success',
    runner_group_name: 'GitHub Actions',
    labels: ['ubuntu-latest'],
    check_run_url: 'https://api.github.com/repos/example/core/check-runs/60',
    steps: [
      { number: 1, name: 'Set up job' },
      {
        number: 2,
        name: workflow.checkoutName,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-03T02:00:00Z',
        completed_at: '2026-11-03T02:00:02Z',
      },
    ],
  };
  const data = {
    '/pulls/7': pr,
    '/pulls/7/reviews': reviews,
    '/branches/main': { protected: true, commit: { sha: base } },
    '/branches/main/protection': policy,
    '/rules/branches/main': [],
    '/collaborators/reviewer/permission': { user: reviewer, permission: 'write' },
    [`/git/commits/${preview}`]: {
      sha: preview,
      parents: [{ sha: base }, { sha: head }],
    },
    [`/commits/${head}/check-runs?filter=latest`]: [check],
    [`/commits/${preview}/check-runs?filter=latest`]: [],
    '/actions/runs?check_suite_id=70': [run],
    '/actions/runs/80': run,
    '/actions/runs/80/attempts/1/jobs': [job],
  };
  for (const ref of [head, preview])
    data[`/contents/${workflow.path}?ref=${ref}`] = {
      type: 'file',
      path: workflow.path,
      sha: workflow.blob,
      encoding: 'base64',
      content: Buffer.from(body).toString('base64'),
      size: Buffer.byteLength(body),
    };
  let logs = checkoutLog(preview);
  const reader = {
    repository: async () => structuredClone(repository),
    get: async (path) => {
      const key = path.slice('/repos/example/core'.length);
      assert.ok(Object.hasOwn(data, key), key);
      return structuredClone(data[key]);
    },
    jobLogs: async () => logs,
  };
  reader.list = (path) => reader.get(path);
  return {
    expected,
    pr,
    policy,
    check,
    run,
    job,
    data,
    reader,
    preview,
    logs: (value) => {
      logs = value;
    },
  };
}

test(
  'zero human approvals still requires exact native CI and ' +
    'retains configured team gates',
  async () => {
    const f = fixture();
    Object.assign(f.policy.required_pull_request_reviews, {
      required_approving_review_count: 0,
      require_last_push_approval: false,
      dismiss_stale_reviews: false,
    });
    f.expected.reviewers = [];
    f.data['/pulls/7/reviews'].length = 0;
    assert.equal(
      (await readPullRequestCI(f.reader, f.expected, now)).head,
      f.expected.head,
    );
    f.check.conclusion = 'failure';
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /CI_SOURCE_OR_RESULT_MISMATCH/,
    );
    f.check.conclusion = 'success';
    Object.assign(f.policy.required_pull_request_reviews, {
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismiss_stale_reviews: true,
    });
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /INDEPENDENT_APPROVAL_REQUIRED/,
    );
  },
);

test(
  'CI ties native check app, workflow blob, run attempt, ' +
    'job, checkout and independent review to current PR',
  async () => {
    const f = fixture();
    const result = await readPullRequestCI(f.reader, f.expected, now);
    assert.equal(result.testedSha, f.preview);
    assert.deepEqual(result.parents, [f.expected.base, f.expected.head]);
    assert.equal(result.checks[0].appId, 15368);
    f.logs(checkoutLog(f.expected.head));
    assert.equal(
      (await readPullRequestCI(f.reader, f.expected, now)).testedSha,
      f.expected.head,
    );
  },
);

test(
  'wrong app/source, unapproved run, stale ' +
    'attempt/head/base, missing review and untrusted runner ' +
    'deny',
  async () => {
    const mutations = [
      (f) => {
        f.run.pull_requests = [];
      },
      (f) => {
        f.check.app.id = 99;
      },
      (f) => {
        f.run.path = '.github/workflows/forged.yml';
      },
      (f) => {
        f.run.workflow_id = 99;
      },
      (f) => {
        f.run.status = 'waiting';
      },
      (f) => {
        f.check.conclusion = 'neutral';
      },
      (f) => {
        f.job.run_attempt = 2;
      },
      (f) => {
        f.run.head_sha = '9'.repeat(40);
      },
      (f) => {
        f.pr.base.sha = '9'.repeat(40);
      },
      (f) => {
        f.data['/pulls/7/reviews'] = [];
      },
      (f) => {
        f.job.runner_group_name = 'Custom';
      },
      (f) => {
        f.job.labels.push('self-hosted');
      },
      (f) => {
        f.job.steps[1].number = 4;
      },
      (f) => {
        f.data[`/git/commits/${f.preview}`].parents.reverse();
      },
      (f) => {
        f.data[`/contents/${f.expected.workflows[0].path}?ref=${f.preview}`].sha =
          '9'.repeat(40);
      },
      (f) => {
        f.policy.required_status_checks.checks[0].app_id = -1;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await assert.rejects(readPullRequestCI(f.reader, f.expected, now));
    }
  },
);

test(
  'a pending required check on the merge preview cannot ' +
    'use the successful head check instead',
  async () => {
    const f = fixture();
    f.data[`/commits/${f.preview}/check-runs?filter=latest`] = [
      { ...f.check, head_sha: f.preview, status: 'in_progress', conclusion: null },
    ];
    await assert.rejects(readPullRequestCI(f.reader, f.expected, now));
  },
);

test(
  'checkout identity excludes later untrusted output and ' +
    'refuses ambiguous or missing trusted-step markers',
  () => {
    const f = fixture(),
      step = f.job.steps[1],
      marker = '[command]/usr/bin/git log -1 --format=%H';
    const valid = checkoutLog(f.preview, marker);
    assert.equal(
      checkoutIdentity(
        valid +
          `2026-11-03T02:01:01.000Z ${marker}\n` +
          `2026-11-03T02:01:01.100Z ${'9'.repeat(40)}\n`,
        step,
      ),
      f.preview,
    );
    assert.throws(() => checkoutIdentity(valid + valid, step), /AMBIGUOUS_CHECKOUT_LOG/);
    assert.throws(() => checkoutIdentity('fake green result', step));
  },
);

test('native Windows checkout requires the exact command in the trusted step', () => {
  const f = fixture(), step = f.job.steps[1];
  const marker = String.raw`[command]"C:\Program Files\Git\bin\git.exe"` +
    ' log -1 --format=%H';
  const valid = checkoutLog(f.preview, marker);
  assert.equal(checkoutIdentity(valid, step), f.preview);
  for (const changed of [
    marker.replace('C:', 'D:'), marker.replace('Git\\bin', 'Other\\bin'),
    marker + ' && echo spoofed', marker.replace('--format=%H', '--format=%s'),
  ]) assert.throws(() => checkoutIdentity(checkoutLog(f.preview, changed), step),
    /AMBIGUOUS_CHECKOUT_LOG/);
  assert.throws(() => checkoutIdentity(valid + checkoutLog(f.preview), step),
    /AMBIGUOUS_CHECKOUT_LOG/);
  assert.throws(() => checkoutIdentity(valid.replaceAll(
    '2026-11-03T02:00:', '2026-11-03T02:02:'), step));
});

test(
  'closure revalidates the historical PR checks after ' +
    'merge and refuses a missing merge ancestor',
  async () => {
    const f = fixture(),
      before = await readPullRequestCI(f.reader, f.expected, now);
    const merge = '8'.repeat(40),
      current = '9'.repeat(40);
    Object.assign(f.pr, {
      state: 'closed',
      merged: true,
      merged_at: '2026-11-03T03:00:00Z',
      merge_commit_sha: merge,
    });
    f.data['/branches/main'].commit.sha = current;
    f.data[`/compare/${merge}...${current}`] = {
      status: 'ahead',
      merge_base_commit: { sha: merge },
    };
    f.data[`/git/commits/${merge}`] = {
      sha: merge,
      parents: [{ sha: f.expected.base }, { sha: f.expected.head }],
    };
    const expected = {
      ...f.expected,
      mergedCommit: merge,
      admittedCI: before,
      testMerge: f.preview,
      workflows: f.expected.workflows.map((pin) => ({
        ...pin,
        targetSha: f.expected.head,
      })),
    };
    // Later push checks on the historical preview cannot replace the admitted PR check.
    f.data[`/commits/${f.preview}/check-runs?filter=latest`] = [
      { ...f.check, head_sha: f.preview, status: 'queued' },
    ];
    assert.deepEqual(await readPullRequestCI(f.reader, expected, now), before);
    f.data[`/compare/${merge}...${current}`].merge_base_commit.sha = '0'.repeat(40);
    await assert.rejects(
      readPullRequestCI(f.reader, expected, now),
      /MERGED_COMMIT_NOT_CURRENT_ANCESTOR/,
    );
  },
);

test(
  'rebase closure retains both head and preview CI ' +
    'identities and rejects changed merged content',
  async () => {
    for (const target of ['head', 'preview']) {
      const f = fixture(),
        merge = '8'.repeat(40),
        tree = 'a'.repeat(40);
      const tested = target === 'head' ? f.expected.head : f.preview;
      f.logs(checkoutLog(tested));
      if (target === 'preview') {
        f.check.head_sha = f.preview;
        f.data[`/commits/${f.preview}/check-runs?filter=latest`] = [f.check];
        f.data[`/commits/${f.expected.head}/check-runs?filter=latest`] = [];
      }
      const before = await readPullRequestCI(f.reader, f.expected, now);
      assert.equal(before.testMerge, f.preview);
      Object.assign(f.pr, {
        state: 'closed',
        merged: true,
        merged_at: '2026-11-03T03:00:00Z',
        merge_commit_sha: merge,
      });
      f.data['/branches/main'].commit.sha = merge;
      f.data[`/compare/${merge}...${merge}`] = {
        status: 'identical',
        merge_base_commit: { sha: merge },
      };
      for (const sha of [merge, f.expected.head])
        f.data[`/git/commits/${sha}`] = {
          sha,
          tree: { sha: tree },
          parents: [{ sha: f.expected.base }],
        };
      const expected = {
        ...f.expected,
        mergedCommit: merge,
        admittedCI: before,
        testMerge: before.testMerge,
        workflows: f.expected.workflows.map((pin) => ({
          ...pin,
          targetSha: before.checks.find((check) => check.name === pin.context).targetSha,
        })),
      };
      assert.equal(mergedRunObservation.event, f.run.event);
      f.run.pull_requests = structuredClone(mergedRunObservation.pull_requests);
      assert.deepEqual(await readPullRequestCI(f.reader, expected, now), before);
      await assert.rejects(
        readPullRequestCI(f.reader, { ...expected, admittedCI: undefined }, now),
        /INVALID_CLOSURE_CI_PIN/,
      );
      f.job.id = 91;
      await assert.rejects(
        readPullRequestCI(f.reader, expected, now),
        /CLOSURE_CI_CHANGED/,
      );
      f.job.id = 90;
      f.run.pull_requests = [{ number: 999 }];
      await assert.rejects(
        readPullRequestCI(f.reader, expected, now),
        /CI_SOURCE_OR_RESULT_MISMATCH/,
      );
      f.run.pull_requests = [];
      f.data[`/git/commits/${merge}`].tree.sha = 'b'.repeat(40);
      await assert.rejects(
        readPullRequestCI(f.reader, expected, now),
        /MERGED_CONTENT_CHANGED/,
      );
    }
  },
);

test(
  'only native nonterminal CI waits; failed or foreign ' + 'results remain denied',
  async () => {
    const f = fixture();
    Object.assign(f.run, { status: 'in_progress', conclusion: null });
    Object.assign(f.check, { status: 'in_progress', conclusion: null });
    f.pr.mergeable_state = 'blocked';
    await assert.rejects(readPullRequestCI(f.reader, f.expected, now), /CI_WAITING/);
    f.run.head_sha = '9'.repeat(40);
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /CI_SOURCE_OR_RESULT_MISMATCH/,
    );
    f.run.head_sha = f.expected.head;
    Object.assign(f.run, { status: 'completed', conclusion: 'failure' });
    Object.assign(f.check, { status: 'completed', conclusion: 'failure' });
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /CI_SOURCE_OR_RESULT_MISMATCH/,
    );
  },
);

test(
  'unregistered checks and unknown mergeability have ' + 'distinct pending causes',
  async () => {
    const f = fixture();
    f.pr.mergeable = null;
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /PR_MERGEABILITY_PENDING/,
    );
    f.pr.mergeable = true;
    f.data[`/commits/${f.expected.head}/check-runs?filter=latest`] = [];
    await assert.rejects(
      readPullRequestCI(f.reader, f.expected, now),
      /CI_REGISTRATION_PENDING/,
    );
  },
);
