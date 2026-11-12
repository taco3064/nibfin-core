import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubWriter, MergeBeforeWrite } from '../src/github-write.mjs';

test('native merge lets GitHub decide and recognizes a rejected merge', async () => {
  const repository = 'example/core';
  const head = '1'.repeat(40), base = '2'.repeat(40);
  const repo = { id: 10, full_name: repository, private: false, default_branch: 'main',
    allow_merge_commit: true };
  const pr = {
    node_id: 'PR_1', number: 7, state: 'open', draft: false, merged: false,
    head: { sha: head, repo }, base: { sha: base, ref: 'main', repo },
    mergeable: true, mergeable_state: 'blocked',
  };
  const responses = {
    '/repos/example/core/pulls/7': pr,
    '/repos/example/core/branches/main': { protected: false, commit: { sha: base } },
  };
  let calls = 0;
  const writer = new GitHubWriter({
    reader: { get: async path => responses[path], repository: async () => repo },
    token: 'fixture-token',
    guard: async ({ targetHash }) => ({ targetHash, bindingHash: 'a'.repeat(64) }),
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.github.com/repos/example/core/pulls/7/merge');
      assert.equal(options.method, 'PUT');
      assert.equal(JSON.parse(options.body).sha, head);
      return { ok: false, status: 405 };
    },
  });
  await assert.rejects(writer.merge({
    repository, repositoryId: 10, number: 7, id: 'PR_1',
    head, base, baseBranch: 'main', nativePolicy: true,
  }), error => error instanceof MergeBeforeWrite &&
    error.code === 'GITHUB_MERGE_BLOCKED');
  assert.equal(calls, 1);
});
