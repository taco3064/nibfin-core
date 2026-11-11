import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitHubRead } from '../src/github-read-retry.mjs';

async function read(...responses) {
  const delays = [];
  let attempts = 0;
  const result = await fetchGitHubRead(async () => {
    const response = responses[attempts++];
    if (response instanceof Error) throw response;
    return response;
  }, 'https://api.github.com/repos/example/core', { method: 'GET' }, {
    wait: async delay => delays.push(delay),
  });
  return { status: result.status, attempts, delays };
}

test('GitHub reads back off for transport errors and temporary HTTP errors', async () => {
  const error = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
  assert.deepEqual(await read(error, { status: 503 }, { status: 200 }), {
    status: 200, attempts: 3, delays: [500, 1000],
  });
});

test('GitHub reads respect rate limits, authentication failures and retry budget',
  async () => {
    const limited = retryAfter => ({
      status: 403, headers: new Headers({ 'retry-after': retryAfter }),
    });
    assert.deepEqual(await read(limited('2'), { status: 200 }), {
      status: 200, attempts: 2, delays: [2000],
    });
    assert.deepEqual(await read(limited('61')), {
      status: 403, attempts: 1, delays: [],
    });
    for (const status of [401, 403, 404])
      assert.deepEqual(await read({ status }), { status, attempts: 1, delays: [] });
  },
);
