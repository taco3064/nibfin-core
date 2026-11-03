import test from 'node:test';
import assert from 'node:assert/strict';
import { readDependencies } from '../src/dependencies.mjs';

const target = { id: 'I_target', repository: 'example/core', repositoryId: 10, number: 2 };
const upstream = { id: 'I_upstream', repository: 'example/action', repositoryId: 20, number: 7 };
const remote = (item, state) => ({ node_id: item.id, number: item.number, state, labels: ['scope', 'shaped', 'delivered'].map(name => ({ name })),
  url: `https://api.github.com/repos/${item.repository}/issues/${item.number}` });
function fixture() {
  return {
    repository: async name => ({ id: name === target.repository ? 10 : 20, full_name: name, private: false }),
    issue: async item => remote(item, item.id === target.id ? 'open' : 'closed'),
    blockedBy: async () => [remote(upstream, 'closed')],
  };
}

test('fresh native cross-repository closed prerequisites permit eligibility', async () => {
  const reader = fixture(); let reads = 0;
  reader.blockedBy = async () => { reads++; return [remote(upstream, 'closed')]; };
  const result = await readDependencies(reader, target, [upstream]);
  assert.equal(result.ready, true); assert.equal(reads, 2);
  assert.equal(result.prerequisites[0].id, upstream.id);
});

test('open upstream blocks even when the dependency-list payload said closed', async () => {
  const reader = fixture(); reader.issue = async item => remote(item, 'open');
  assert.equal((await readDependencies(reader, target, [upstream])).ready, false);
});

test('no dependencies is eligible only after actual empty native reads', async () => {
  const reader = fixture(); reader.blockedBy = async () => [];
  assert.equal((await readDependencies(reader, target, [])).ready, true);
  await assert.rejects(readDependencies(fixture(), target, []));
});

test('changed graph, foreign issue, duplicate edges and inaccessible reads deny', async () => {
  const variants = [
    r => { let n = 0; r.blockedBy = async () => ++n === 1 ? [remote(upstream, 'closed')] : []; },
    r => { r.blockedBy = async () => [remote(upstream, 'closed'), remote(upstream, 'closed')]; },
    r => { r.issue = async item => ({ ...remote(item, 'closed'), node_id: 'I_other' }); },
    r => { r.repository = async name => ({ id: 99, full_name: name, private: false }); },
    r => { r.issue = async () => { throw new Error('403'); }; },
    r => { r.repository = async name => ({ id: name === target.repository ? 10 : 20, full_name: name, private: true }); },
  ];
  for (const mutate of variants) { const reader = fixture(); mutate(reader); await assert.rejects(readDependencies(reader, target, [upstream])); }
});

test('duplicate and self prerequisites are rejected', async () => {
  await assert.rejects(readDependencies(fixture(), target, [upstream, upstream]));
  await assert.rejects(readDependencies(fixture(), target, [target]));
});

test('closed, cancelled or manually tracked work without the full normal lifecycle stays blocked', async () => {
  for (const labels of [undefined, [], ['scope'], ['scope', 'shaped'], ['delivered'], ['shaped', 'delivered']]) {
    const reader = fixture();
    reader.issue = async item => ({ ...remote(item, item.id === target.id ? 'open' : 'closed'),
      labels: labels?.map(name => ({ name })) });
    const result = await readDependencies(reader, target, [upstream]);
    assert.equal(result.ready, false); assert.equal(result.prerequisites[0].completed, false);
  }
  // Issue number 1 and a Bootstrap title are not runtime bypass credentials.
  const bootstrap = { ...upstream, number: 1 };
  const reader = fixture(); reader.blockedBy = async () => [remote(bootstrap, 'closed')];
  reader.issue = async item => ({ ...remote(item, item.id === target.id ? 'open' : 'closed'),
    title: 'Manual Bootstrap', labels: [] });
  assert.equal((await readDependencies(reader, target, [bootstrap])).ready, false);
});
