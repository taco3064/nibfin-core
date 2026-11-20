import assert from 'node:assert/strict';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';

export const name = 'example/peer';
export const root = '/repos/' + name;
export const head = 'a'.repeat(40);
export const source = { repository: 'taco3064/nibfin-core', commit: 'b'.repeat(40) };
export const actionCommit = 'c'.repeat(40);
export const memberId = 77;

export function fixture() {
  const branch = root + '/branches/main';
  const replies = new Map([
    [root, { id: 123, full_name: name, private: false, disabled: false,
      archived: false, default_branch: 'main' }],
    ['/user', { id: memberId, type: 'User', login: 'owner' }],
    [branch, { name: 'main', protected: false, commit: { sha: head } }],
    [root + '/collaborators/owner/permission', { permission: 'admin',
      user: { id: memberId } }],
  ]);
  for (const [file, kind, id] of [
    ['nibfin-issue.yml', 'issue', 11], ['nibfin-wake.yml', 'action-dispatch', 22],
  ]) {
    const path = '.github/workflows/' + file;
    const recipe = callerRecipe(kind, source.commit, { actionCommit, memberId });
    const bytes = Buffer.from(recipe);
    replies.set(root + '/actions/workflows/' + file, { id, path, state: 'active' });
    replies.set(root + '/contents/' + path + '?ref=' + head, {
      type: 'file', path, encoding: 'base64', sha: gitBlob(bytes),
      content: bytes.toString('base64'),
    });
  }
  return { replies, get: async path => {
    assert.ok(replies.has(path), path);
    return replies.get(path);
  } };
}

