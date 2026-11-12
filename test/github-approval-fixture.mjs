import assert from 'node:assert/strict';
import { digest, gitBlob } from '../src/identity.mjs';
import { approvalRecord } from './approval-fixture.mjs';
export function approvalProviderFixture(record = approvalRecord()) {
  const body = JSON.stringify(record);
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
  const pin = {
    repository: 'example/core',
    repositoryId: 10,
    prNumber: 7,
    prId: 'PR_approval',
    issueId: 'I_target',
    head: 'd'.repeat(40),
    base: 'e'.repeat(40),
    merge: 'f'.repeat(40),
    ruleSuiteId: 60,
    blob: gitBlob(body),
    path: '.nibfin/approvals/I_target.json',
    recordHash: digest(record),
    protectionHash: digest(policy),
    reviewers: [2],
    source: record.source,
  };
  const repo = {
    id: 10,
    full_name: 'example/core',
    private: false,
    archived: false,
    disabled: false,
    owner: { type: 'User', id: 3 },
    default_branch: 'main',
  };
  const pr = {
    node_id: 'PR_approval',
    number: 7,
    state: 'closed',
    draft: false,
    merged: true,
    merge_commit_sha: pin.merge,
    merged_by: { id: 3, login: 'publisher', type: 'User' },
    merged_at: '2026-11-03T02:00:00Z',
    mergeable: true,
    mergeable_state: 'clean',
    user: { id: 1, type: 'User', login: 'author' },
    head: { sha: pin.head, repo },
    base: { sha: pin.base, ref: 'main', repo },
  };
  const reviews = [
    {
      id: 50,
      user: { id: 2, login: 'reviewer', type: 'User' },
      commit_id: pin.head,
      state: 'APPROVED',
      submitted_at: '2026-11-03T01:00:00Z',
    },
  ];
  const data = {
    '/issues/2/events': [],
    '/branches/main/protection': policy,
    '/branches/main': { protected: true, commit: { sha: '9'.repeat(40) } },
    '/pulls/7': pr,
    '/rules/branches/main': [],
    '/pulls/7/reviews': reviews,
    [`/contents/${pin.path}?ref=${pin.head}`]: {
      type: 'file',
      path: pin.path,
      sha: pin.blob,
      encoding: 'base64',
      content: Buffer.from(body).toString('base64'),
      size: Buffer.byteLength(body),
    },
    [`/git/commits/${pin.merge}`]: {
      sha: pin.merge,
      parents: [{ sha: pin.base }, { sha: pin.head }],
    },
    '/rulesets/rule-suites/60': {
      id: 60,
      repository_id: 10,
      before_sha: pin.base,
      after_sha: pin.merge,
      ref: 'refs/heads/main',
      actor_id: 3,
      result: 'pass',
      evaluation_result: 'pass',
      rule_evaluations: ['pull_request', 'required_status_checks'].map((rule_type) => ({
        rule_type,
        enforcement: 'active',
        result: 'pass',
        rule_source: { type: 'protected_branch' },
      })),
    },
    [`/compare/${pin.merge}...${'9'.repeat(40)}`]: {
      status: 'ahead',
      merge_base_commit: { sha: pin.merge },
    },
    '/collaborators/publisher/permission': { permission: 'admin', user: pr.merged_by },
    '/collaborators/reviewer/permission': {
      permission: 'write',
      user: reviews[0].user,
    },
  };
  for (const ref of [pin.merge, '9'.repeat(40)]) {
    data[`/contents/${pin.path}?ref=${ref}`] = structuredClone(
      data[`/contents/${pin.path}?ref=${pin.head}`],
    );
    data[`/commits?sha=${ref}&path=${encodeURIComponent(pin.path)}&per_page=1`] = [
      { sha: pin.head },
    ];
  }
  const reader = {
    repository: async () => structuredClone(repo),
    get: async (path) => {
      assert.ok(path.startsWith('/repos/example/core/'));
      const key = path.slice('/repos/example/core'.length);
      assert.ok(Object.hasOwn(data, key), `Unexpected request ${key}`);
      return structuredClone(data[key]);
    },
  };
  reader.list = (path) => reader.get(path);
  return { record, pin, repo, pr, reviews, policy, data, reader };
}
