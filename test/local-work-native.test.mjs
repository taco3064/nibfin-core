import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { observationReader, boundedList } from '../src/local-work-native.mjs';
import { limits } from '../src/local-work-values.mjs';

test('native transport uses bounded authenticated GET', async () => {
  let requests = 0;
  const reader = observationReader('private-fixture', async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-fixture');
    return Response.json({ id: 5 });
  });
  assert.deepEqual(await reader.get('/user'), { id: 5 });
  assert.equal(requests, 1);
  const oversized = observationReader('private-fixture', async () =>
    new Response('x'.repeat(limits.responseBytes + 1)));
  await assert.rejects(oversized.get('/user'), { code: 'OBSERVATION_LIMIT' });
});
test('native rate limits are surfaced without unbounded retry waits or provider text',
  async () => {
    let requests = 0;
    const reader = observationReader('private-fixture', async () => {
      requests++;
      return new Response('private-provider-body', { status: 429,
        headers: { 'retry-after': '999999' } });
    });
    await assert.rejects(reader.get('/user'), error =>
      error.status === 429 && !error.message.includes('private-provider-body'));
    assert.equal(requests, 1);
  });
test('native observation bounds request count including confirmation reads', async () => {
  const reader = observationReader('private-fixture',
    async () => Response.json({ id: 5 }));
  for (let index = 0; index < limits.requests; index++) await reader.get('/user');
  await assert.rejects(reader.get('/user'), { code: 'OBSERVATION_LIMIT' });
});
test('pagination rejects inconsistent totals', async () => {
  await assert.rejects(boundedList({ get: async () => ({ jobs: [], total_count: 1 }) },
    '/repos/example/pool/actions/runs/1/jobs', 'jobs'), { code: 'OBSERVATION_LIMIT' });
});
test('CLI rejects argument credentials and extra fields without exposing them',
  () => {
    const argument = spawnSync(process.execPath,
      ['bin/nibfin-core.mjs', 'observe-local-work', 'private-fixture-token'],
      { encoding: 'utf8' });
    assert.equal(argument.status, 1);
    assert.ok(!argument.stderr.includes('private-fixture-token'));
    assert.equal(JSON.parse(argument.stderr).code, 'INVALID_COMMAND');
    const input = spawnSync(process.execPath,
      ['bin/nibfin-core.mjs', 'observe-local-work'],
      { input: '{"token":"private-fixture-token","memberId":5}', encoding: 'utf8' });
    assert.equal(input.status, 1);
    assert.ok(!input.stderr.includes('private-fixture-token'));
    assert.equal(JSON.parse(input.stderr).code, 'INVALID_OBSERVATION_INPUT');
  });
