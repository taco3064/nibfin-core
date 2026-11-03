import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateContract, safeCandidatePath } from '../src/candidate-contract.mjs';

const body = value => `# Delivery\n\n\`\`\`kairo-candidate\n${JSON.stringify(value)}\n\`\`\`\n`;
const contract = () => ({ artifacts: [{ path: 'report/result.json', purpose: 'Required validation evidence' }],
  hooks: [{ path: '.husky/pre-commit', event: 'pre-commit' }, { path: '.husky/commit-msg', event: 'commit-msg' }] });

test('preserves the existing machine-readable contract and hook order', () => {
  assert.deepEqual(candidateContract(body(contract())), contract());
  assert.deepEqual(candidateContract(body(contract()).replaceAll('\n', '\r\n')), contract());
  assert.deepEqual(candidateContract(body({ artifacts: [], hooks: [] })), { artifacts: [], hooks: [] });
});

test('refuses absent, ambiguous and invalid JSON inventories', () => {
  for (const text of ['', '# Nothing', body(contract()) + body(contract()), '```kairo-candidate\n{broken\n```']) {
    assert.throws(() => candidateContract(text));
  }
});

test('refuses malformed obligations rather than silently dropping constraints', () => {
  const mutations = [
    c => { delete c.hooks; }, c => { c.authorized = true; },
    c => { c.artifacts[0].extra = true; }, c => { c.artifacts[0].purpose = ' '; },
    c => { c.hooks[0].event = 'post-merge'; }, c => { c.hooks.push(c.hooks[0]); },
    c => { c.artifacts.push(c.artifacts[0]); }, c => { c.artifacts = 'report'; },
  ];
  for (const mutate of mutations) { const value = contract(); mutate(value); assert.throws(() => candidateContract(body(value))); }
});

test('rejects paths that escape the Candidate or name Git metadata', () => {
  for (const path of ['../x', '/tmp/x', 'C:/x', 'a\\b', './x', 'a//x', '.git/config', 'a/.GIT/config', 'x;echo', 'x\ny']) {
    assert.equal(safeCandidatePath(path), false, path);
    const value = contract(); value.artifacts[0].path = path;
    assert.throws(() => candidateContract(body(value)));
  }
});
