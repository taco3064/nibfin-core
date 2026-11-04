import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, gitBlob } from '../src/identity.mjs';
import { readProtectedApproval, readMemberPermission } from '../src/github-approval.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';

import { approvalProviderFixture as fixture } from './github-approval-fixture.mjs';
import { rulesetFixture } from './ruleset-fixture.mjs';

test('adopted rulesets retain approval provenance', async () => {
  const f = fixture(),
    adopted = rulesetFixture(f.policy);
  f.pin.ruleset = adopted.pin;
  f.pin.protectionHash = adopted.hash;
  f.data[`/rulesets/${adopted.value.id}`] = adopted.value;
  f.data['/rules/branches/main'] = adopted.rules;
  const suite = f.data['/rulesets/rule-suites/60'];
  delete suite.evaluation_result;
  suite.rule_evaluations = ['protected_branch', 'ruleset'].flatMap((type) =>
    adopted.value.rules.map((rule) => ({
      rule_type: rule.type,
      enforcement: 'active',
      result: 'pass',
      rule_source: type === 'ruleset' ? { type, id: adopted.value.id } : { type },
    })),
  );
  assert.deepEqual((await readProtectedApproval(f.reader, f.pin, now)).record, f.record);
  suite.rule_evaluations.at(-1).result = 'fail';
  await assert.rejects(
    readProtectedApproval(f.reader, f.pin, now),
    /MISSING_OR_BYPASSED_MERGE_ENFORCEMENT/,
  );
  suite.rule_evaluations.at(-1).result = 'pass';
  adopted.value.name += ' changed';
  await assert.rejects(
    readProtectedApproval(f.reader, f.pin, now),
    /RULESET_NOT_ADOPTED/,
  );
});

test(
  'single-commit protected rewrites retain exact approved ' +
    'tree, base and enforcement',
  async () => {
    for (const fault of [undefined, 'tree', 'base', 'head', 'history', 'enforcement']) {
      const f = fixture(),
        tree = 'a'.repeat(40);
      f.data[`/git/commits/${f.pin.head}`] = {
        sha: f.pin.head,
        tree: { sha: tree },
        parents: [{ sha: f.pin.base }],
      };
      f.data[`/git/commits/${f.pin.merge}`] = {
        sha: f.pin.merge,
        tree: { sha: tree },
        parents: [{ sha: f.pin.base }],
      };
      if (fault === 'tree')
        f.data[`/git/commits/${f.pin.merge}`].tree.sha = 'b'.repeat(40);
      if (fault === 'base')
        f.data[`/git/commits/${f.pin.merge}`].parents[0].sha = 'b'.repeat(40);
      if (fault === 'head') f.data[`/git/commits/${f.pin.head}`].sha = 'b'.repeat(40);
      if (fault === 'history')
        f.data[`/git/commits/${f.pin.head}`].parents[0].sha = 'b'.repeat(40);
      if (fault === 'enforcement') f.data['/rulesets/rule-suites/60'].result = 'bypass';
      const result = readProtectedApproval(
        f.reader,
        f.pin,
        Date.parse('2026-11-03T03:00:00Z'),
      );
      if (fault)
        await assert.rejects(
          result,
          /UNSUPPORTED_APPROVAL_MERGE|MISSING_OR_BYPASSED_MERGE_ENFORCEMENT/,
        );
      else assert.deepEqual((await result).record, f.record);
    }
  },
);

test(
  'fresh native approval binds exact file bytes, ' +
    'independent permitted reviewer and live classic ' +
    'protections',
  async () => {
    const f = fixture();
    const result = await readProtectedApproval(f.reader, f.pin, now);
    assert.deepEqual(result.record, f.record);
    assert.equal(result.reviewers[0].id, 2);
    assert.equal(Object.hasOwn(result, 'authorized'), false);
    f.repo.owner.type = 'Organization';
    assert.deepEqual(
      (await readProtectedApproval(f.reader, f.pin, now)).record,
      f.record,
    );
  },
);

test(
  'missing, altered, bypassable, unbound or unsupported ' + 'branch protection denies',
  async () => {
    const mutations = [
      (f) => {
        f.policy.enforce_admins.enabled = false;
      },
      (f) => {
        f.policy.allow_force_pushes.enabled = true;
      },
      (f) => {
        f.policy.allow_deletions.enabled = true;
      },
      (f) => {
        delete f.policy.required_pull_request_reviews;
      },
      (f) => {
        f.policy.required_pull_request_reviews.dismiss_stale_reviews = false;
      },
      (f) => {
        f.policy.required_pull_request_reviews.require_last_push_approval = false;
      },
      (f) => {
        f.policy.required_pull_request_reviews.required_approving_review_count = 0;
      },
      (f) => {
        f.policy.required_pull_request_reviews.bypass_pull_request_allowances = {
          users: [{ id: 1 }],
          teams: [],
          apps: [],
        };
      },
      (f) => {
        f.policy.required_status_checks.checks[0].app_id = -1;
      },
      (f) => {
        f.policy.required_status_checks.contexts.push('other');
      },
      (f) => {
        f.policy.required_status_checks.strict = false;
      },
      (f) => {
        f.policy.required_pull_request_reviews.require_code_owner_reviews = true;
      },
      (f) => {
        f.data['/rules/branches/main'] = [{ type: 'pull_request' }];
      },
      (f) => {
        f.data['/branches/main'].protected = false;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await assert.rejects(readProtectedApproval(f.reader, f.pin, now));
    }
  },
);

test(
  'review dismissal, stale head, revoked permission, self ' +
    'approval and unknown identity deny',
  async () => {
    const mutations = [
      (f) => {
        f.reviews[0].state = 'DISMISSED';
      },
      (f) => {
        f.reviews[0].state = 'CHANGES_REQUESTED';
      },
      (f) => {
        f.reviews[0].commit_id = f.pin.base;
      },
      (f) => {
        f.reviews[0].user.type = 'Bot';
      },
      (f) => {
        f.pr.user.id = 2;
      },
      (f) => {
        f.pin.reviewers = [99];
      },
      (f) => {
        f.data['/collaborators/reviewer/permission'].permission = 'read';
      },
      (f) => {
        f.data['/collaborators/publisher/permission'].permission = 'read';
      },
      (f) => {
        f.data['/collaborators/reviewer/permission'].user = {
          id: 99,
          login: 'reviewer',
          type: 'User',
        };
      },
      (f) => {
        f.reviews.push({
          ...f.reviews[0],
          id: 51,
          state: 'DISMISSED',
          submitted_at: '2026-11-03T02:00:00Z',
        });
      },
      (f) => {
        f.reviews.push({ ...f.reviews[0] });
      },
      (f) => {
        f.reviews[0].submitted_at = '2026-11-05T00:00:00Z';
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await assert.rejects(readProtectedApproval(f.reader, f.pin, now));
    }
  },
);

test(
  'fork, open, unmerged, changed base, draft, wrong record ' +
    'and foreign repository deny',
  async () => {
    const mutations = [
      (f) => {
        f.pr.head.repo = { ...f.repo, id: 11 };
      },
      (f) => {
        f.pr.state = 'open';
      },
      (f) => {
        f.pr.merged = false;
      },
      (f) => {
        f.pr.draft = true;
      },
      (f) => {
        f.pr.merge_commit_sha = f.pin.head;
      },
      (f) => {
        f.pr.head.sha = f.pin.base;
      },
      (f) => {
        f.pr.base.sha = f.pin.head;
      },
      (f) => {
        f.repo.id = 11;
      },
      (f) => {
        f.repo.private = true;
      },
      (f) => {
        f.repo.archived = true;
      },
      (f) => {
        f.data['/rulesets/rule-suites/60'].result = 'bypass';
      },
      (f) => {
        f.data['/rulesets/rule-suites/60'].rule_evaluations = [];
      },
      (f) => {
        f.data['/rulesets/rule-suites/60'].after_sha = f.pin.head;
      },
      (f) => {
        const path = encodeURIComponent(f.pin.path);
        f.data[`/commits?sha=${'9'.repeat(40)}&path=${path}&per_page=1`] = [
          { sha: '8'.repeat(40) },
        ];
      },
      (f) => {
        f.reviews[0].submitted_at = '2026-11-03T03:00:00Z';
      },
      (f) => {
        f.pin.recordHash = '0'.repeat(64);
      },
      (f) => {
        f.pin.path = '../approval.json';
      },
      (f) => {
        f.pin.source = { ...f.record.source, commit: f.pin.head };
      },
      (f) => {
        f.data[`/contents/${f.pin.path}?ref=${f.pin.head}`].content =
          Buffer.from('{}').toString('base64');
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await assert.rejects(readProtectedApproval(f.reader, f.pin, now));
    }
  },
);

test('unavailable provider evidence never falls back to cached approval', async () => {
  const f = fixture();
  await readProtectedApproval(f.reader, f.pin, now);
  f.reader.get = async () => {
    throw new Error('HTTP 403');
  };
  await assert.rejects(readProtectedApproval(f.reader, f.pin, now), /403/);
});

test('PR, policy, branch and reviews changing during observation deny', async () => {
  for (const resource of [
    '/pulls/7',
    '/branches/main/protection',
    '/branches/main',
    '/pulls/7/reviews',
  ]) {
    const f = fixture(),
      get = f.reader.get;
    let reads = 0;
    f.reader.get = async (path) => {
      const value = await get(path);
      if (path === `/repos/example/core${resource}` && ++reads === 2) {
        if (Array.isArray(value)) return [];
        return { ...value, changed: true };
      }
      return value;
    };
    await assert.rejects(
      readProtectedApproval(f.reader, f.pin, now),
      /CHANGED_DURING_READ/,
    );
  }
});

test(
  'member permission requires stable User ID, not a ' + 'reusable login or routing label',
  async () => {
    const f = fixture();
    assert.equal(
      (await readMemberPermission(f.reader, 'example/core', f.reviews[0].user))
        .permission,
      'write',
    );
    await assert.rejects(
      readMemberPermission(f.reader, 'example/core', { ...f.reviews[0].user, id: 99 }),
    );
    await assert.rejects(
      readMemberPermission(f.reader, 'example/core', {
        id: 2,
        login: '../admin',
        type: 'User',
      }),
    );
  },
);

test(
  'solo Owner protected merge needs no human Approve but ' +
    'still binds current authority',
  async () => {
    const f = fixture();
    Object.assign(f.policy.required_pull_request_reviews, {
      required_approving_review_count: 0,
      require_last_push_approval: false,
      dismiss_stale_reviews: false,
    });
    f.repo.owner.id = f.pr.merged_by.id;
    f.pin.reviewers = [];
    f.reviews.length = 0;
    f.pin.protectionHash = digest(f.policy);
    const result = await readProtectedApproval(f.reader, f.pin, now);
    assert.deepEqual(result.reviewers, []);
    assert.deepEqual(result.record, f.record);
    f.repo.owner.id = 99;
    await assert.rejects(
      readProtectedApproval(f.reader, f.pin, now),
      /SOLO_OWNER_MERGE_REQUIRED/,
    );
    f.repo.owner.id = f.pr.merged_by.id;
    f.data['/collaborators/publisher/permission'].permission = 'write';
    await assert.rejects(
      readProtectedApproval(f.reader, f.pin, now),
      /SOLO_OWNER_MERGE_REQUIRED/,
    );
    f.data['/collaborators/publisher/permission'].permission = 'admin';
    f.reviews.push({
      id: 50,
      user: { id: 2 },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-11-03T01:00:00Z',
    });
    await assert.rejects(
      readProtectedApproval(f.reader, f.pin, now),
      /CHANGES_REQUESTED/,
    );
  },
);
