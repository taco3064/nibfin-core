import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubReader, repoPath, issuePath } from '../src/github-read.mjs';

test('check listing collects the response request ID without changing the rows', async () => {
  const rows = [{ id: 17 }];
  const requestIds = [];
  const reader = new GitHubReader('fixture', async () => ({
    ok: true,
    headers: new Headers({ 'x-github-request-id': 'ABCD:123:456:789' }),
    json: async () => ({ total_count: rows.length, check_runs: rows }),
  }));
  const path = '/repos/example/core/commits/main/check-runs?filter=latest';
  assert.deepEqual(await reader.list(path, 'check_runs', { requestIds }), rows);
  assert.deepEqual(requestIds, ['ABCD:123:456:789']);
});

test('uses authenticated GET-only native dependency endpoints and paginates', async () => {
  const calls = [];
  const reader = new GitHubReader('fixture-token', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }] };
  });
  assert.equal((await reader.blockedBy({ repository: 'example/core', number: 2 })).length, 101);
  assert.match(calls[0].url, /\/dependencies\/blocked_by\?per_page=100&page=1$/);
  assert.match(calls[1].url, /page=2$/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(JSON.stringify(reader).includes('fixture-token'), false);
});

test('does not turn failed or malformed responses into empty dependencies', async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: false, status: 404 }, { ok: true, json: async () => ({}) }]) {
    const reader = new GitHubReader('fixture', async () => response);
    await assert.rejects(reader.blockedBy({ repository: 'example/core', number: 2 }));
  }
});

test('each observation reaches the provider; no stale cache fallback', async () => {
  let calls = 0;
  const reader = new GitHubReader('fixture', async () => {
    if (++calls === 2) throw new Error('offline');
    return { ok: true, json: async () => [] };
  });
  await reader.blocking({ repository: 'example/core', number: 2 });
  await assert.rejects(reader.blocking({ repository: 'example/core', number: 2 }));
  assert.equal(calls, 2);
});

test('rejects unsafe identities before network access', async () => {
  const reader = new GitHubReader('fixture', async () => { assert.fail('must not call network'); });
  for (const name of ['../core', 'example/..', 'example/core/other', 'https://evil.test', 'example/core?token=x']) assert.throws(() => repoPath(name));
  assert.throws(() => issuePath({ repository: 'example/core', number: 0 }));
  await assert.rejects(reader.get('//evil.test'));
  await assert.rejects(reader.get('/repos/example/core/../secrets'));
  assert.throws(() => new GitHubReader(''));
});

test('object collections refuse truncation instead of silently accepting the first page', async () => {
  const reader = new GitHubReader('fixture', async () => ({ ok: true, json: async () => ({ total_count: 2, jobs: [{ id: 1 }] }) }));
  await assert.rejects(reader.list('/repos/example/core/actions/runs/1/jobs', 'jobs'), /truncated/);
});

test('job log redirect strips credentials and refuses unexpected origins', async () => {
  const calls = [];
  const reader = new GitHubReader('fixture-secret', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { status: 302, headers: { get: () => 'https://example.blob.core.windows.net/logs?temporary=fixture' } };
    return { ok: true, body: (async function* () { yield Buffer.from('job output'); })() };
  });
  assert.equal(await reader.jobLogs('example/core', 1), 'job output');
  assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.redirect, 'error');
  const unsafe = new GitHubReader('fixture-secret', async () => ({ status: 302, headers: { get: () => 'https://attacker.invalid/log' } }));
  await assert.rejects(unsafe.jobLogs('example/core', 1), /Untrusted job log origin/);
});
