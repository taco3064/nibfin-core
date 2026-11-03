import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubWriter } from '../src/github-write.mjs';
import { digest } from '../src/identity.mjs';

function fixture() {
  const issue = { repository: 'example/core', repositoryId: 10, id: 'I_target', number: 2 };
  let current = { node_id: 'I_target', number: 2, url: 'https://api.github.com/repos/example/core/issues/2', state: 'open',
    body: 'Raw Scope', labels: [{ name: 'scope' }, { name: 'bug' }] };
  const calls = [], admission = [];
  const config = { token: 'fixture-token', reader: { get: async () => { throw new Error('Unexpected GET'); },
    repository: async () => ({ id: 10, full_name: 'example/core', private: false }), issue: async () => structuredClone(current) },
  guard: async target => { admission.push(target); return { ...target, bindingHash: 'a'.repeat(64) }; },
  fetcher: async (url, options) => {
    calls.push({ url, options }); const body = JSON.parse(options.body);
    current = { ...current, ...body, labels: body.labels.map(name => ({ name })) };
    return { ok: true, json: async () => structuredClone(current) };
  } };
  return { issue, config, calls, admission, current: () => current, replace: value => { current = value; } };
}

test('Shape publication is a single guarded update followed by exact native read-back', async () => {
  const f = fixture(), writer = new GitHubWriter(f.config);
  const result = await writer.publishShape({ issue: f.issue, expectedBodyHash: digest('Raw Scope'), expectedLabels: ['scope', 'bug'], body: 'Validated Shape' });
  assert.equal(result.bodyHash, digest('Validated Shape')); assert.equal(f.calls.length, 1); assert.equal(f.admission.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { body: 'Validated Shape', labels: ['bug', 'scope', 'shaped'] });
  assert.equal(f.calls[0].options.redirect, 'error');
});

test('stale body/labels and revoked permission prevent any HTTP mutation', async () => {
  for (const change of [f => { f.replace({ ...f.current(), body: 'Edited' }); },
    f => { f.replace({ ...f.current(), labels: [] }); }, f => { f.config.guard = async () => ({ targetHash: 'wrong' }); }]) {
    const f = fixture(); change(f);
    await assert.rejects(new GitHubWriter(f.config).publishShape({ issue: f.issue, expectedBodyHash: digest('Raw Scope'), expectedLabels: ['scope', 'bug'], body: 'Shape' }));
    assert.equal(f.calls.length, 0);
  }
});

test('ambiguous write or silently dropped labels cannot be reported applied and are never retried', async () => {
  for (const failure of ['disconnect', 'forbidden', 'labels']) {
    const f = fixture(); let attempts = 0;
    f.config.fetcher = async () => {
      attempts++;
      if (failure === 'disconnect') throw new Error('Network disconnected after request');
      if (failure === 'forbidden') return { ok: false, status: 403 };
      f.replace({ ...f.current(), body: 'Shape' }); return { ok: true, json: async () => ({}) };
    };
    await assert.rejects(new GitHubWriter(f.config).publishShape({ issue: f.issue, expectedBodyHash: digest('Raw Scope'), expectedLabels: ['scope', 'bug'], body: 'Shape' }));
    assert.equal(attempts, 1);
  }
});

test('closure preserves Shape and unrelated labels and confirms closed + delivered together', async () => {
  const f = fixture(); f.replace({ ...f.current(), body: 'Shape', labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'bug' }] });
  await new GitHubWriter(f.config).closeDelivered({ issue: f.issue, expectedBodyHash: digest('Shape'), expectedLabels: ['scope', 'shaped', 'bug'] });
  assert.equal(f.current().state, 'closed'); assert.equal(f.current().state_reason, 'completed');
  assert.deepEqual(f.current().labels.map(x => x.name), ['bug', 'delivered', 'scope', 'shaped']);
});

test('merge sends expected head and verifies exact merge parents; base races remain unknown', async () => {
  for (const race of [false, true]) {
    const f = fixture(), head = '1'.repeat(40), base = '2'.repeat(40), merged = '3'.repeat(40);
    let applied = false;
    f.config.reader.get = async path => {
      if (path.endsWith('/branches/main')) return { protected: true, commit: { sha: base } };
      if (path.includes('/git/commits/')) return { sha: merged, parents: [{ sha: race ? '4'.repeat(40) : base }, { sha: head }] };
      return { node_id: 'PR_1', number: 7, state: applied ? 'closed' : 'open', draft: false, merged: applied,
        mergeable: true, mergeable_state: 'clean', head: { sha: head, repo: { id: 10 } },
        base: { sha: base, ref: 'main', repo: { id: 10 } }, merge_commit_sha: applied ? merged : null };
    };
    f.config.fetcher = async (url, options) => { f.calls.push({ url, options }); applied = true;
      return { ok: true, json: async () => ({ merged: true, sha: merged }) }; };
    const promise = new GitHubWriter(f.config).merge({ repository: 'example/core', repositoryId: 10, number: 7, id: 'PR_1', head, base, baseBranch: 'main' });
    if (race) await assert.rejects(promise, /MERGE_ANCESTRY_UNKNOWN/);
    else assert.equal((await promise).mergeCommit, merged);
    assert.deepEqual(JSON.parse(f.calls[0].options.body), { sha: head, merge_method: 'merge' });
    assert.equal(f.calls.length, 1);
  }
});


test('fresh independent Shape revalidation confirms exact current publication without inventing history or rewriting it', async () => {
  const f = fixture();
  f.replace({ ...f.current(), body: 'Current Shape', labels: [{ name: 'scope' }, { name: 'shaped' }] });
  const writer = new GitHubWriter(f.config), request = { issue: f.issue, expectedBodyHash: digest('Current Shape'),
    expectedLabels: ['scope', 'shaped'], body: 'Current Shape' };
  assert.equal((await writer.confirmShape(request)).bodyHash, request.expectedBodyHash);
  assert.equal(f.calls.length, 0); assert.equal(f.admission.length, 1);
  f.replace({ ...f.current(), body: 'Changed during revalidation' });
  await assert.rejects(writer.confirmShape(request), /STALE_ISSUE_WRITE/);
});
