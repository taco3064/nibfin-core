import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedGuidance } from '../src/blocked-guidance.mjs';

const repository = 'example/core';
const issue = { repository, number: 330 };
const upstream = { node_id: 'upstream', number: 338, state: 'open',
  url: 'https://api.github.com/repos/example/core/issues/338' };
const marker = 'missing-upstream example/core#338';
const merge = 'a'.repeat(40), base = 'b'.repeat(40);
const workspaceBase = async () => base;

test('suggests the exact native dependency only when it is missing', async () => {
  for (const edges of [[], [upstream]]) {
    const reader = {
      issue: async locator => {
        assert.deepEqual(locator, { repository, number: 338 });
        return upstream;
      },
      blockedBy: async target => {
        assert.equal(target, issue);
        return edges;
      },
    };
    const hint = await blockedGuidance(reader, issue, [marker], workspaceBase);
    assert.equal(hint.includes('set example/core#330 to Blocked by example/core#338'),
      edges.length === 0);
    if (edges.length) assert.match(hint, /already has example\/core#338 as Blocked by/);
  }
});

test('distinguishes a stale workspace from a verified merge already in its base',
  async () => {
    for (const status of ['behind', 'ahead']) {
      const reader = {
        issue: async () => ({ ...upstream, state: 'closed' }),
        get: async path => {
          switch (path) {
            case '/repos/example/core/pulls/358':
              return { number: 358, merged: true, merge_commit_sha: merge,
                body: 'Implements #338.\n', base: { ref: 'main',
                  repo: { full_name: repository } } };
            case `/repos/example/core/compare/${merge}...main`:
              return { status: 'ahead' };
            case `/repos/example/core/compare/${merge}...${base}`: return { status };
            default: assert.fail(path);
          }
        },
      };
      const hint = await blockedGuidance(reader, issue, [`${marker} via #358`],
        workspaceBase);
      assert.match(hint, /example\/core#338 was merged into main via example\/core#358/);
      assert.equal(hint.includes('Refresh the workspace from current main'),
        status === 'behind');
      assert.doesNotMatch(hint, /Blocked by/);
    }
  });

test('omits advice on ordinary blockers and handles unverified upstream reports',
  async () => {
    const reader = {};
    assert.equal(await blockedGuidance(reader, issue, ['src/example.mjs']), undefined);
    for (const references of [
      ['missing-upstream unknown'], [`${marker}\n`], [marker, marker],
      ['missing-upstream example/core#330'],
    ]) {
      assert.match(await blockedGuidance(reader, issue, references),
        /Identify the Issue that owns the missing upstream change/);
    }
    assert.match(await blockedGuidance({
      issue: async () => { throw new Error('GitHub unavailable'); },
    }, issue, [marker]), /Could not verify/);
    assert.match(await blockedGuidance({
      issue: async () => ({ ...upstream, state: 'closed' }),
    }, issue, [marker]), /closed and its merge into main is unverified/);
  });
