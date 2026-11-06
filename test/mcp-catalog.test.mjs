import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverReadOnlyMcpTools } from '../src/mcp-catalog.mjs';

const server = { url: 'https://mcp.example.com/mcp',
  http_headers: { Authorization: 'Bearer test-only-token' } };
function transport({ sse = false, failure, duplicate = false } = {}) {
  const calls = [];
  return { calls, async fetch(url, options) {
    assert.equal(url, server.url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, server.http_headers.Authorization);
    if (options.method === 'DELETE') {
      calls.push('DELETE');
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(options.body);
    calls.push(request.method);
    if (request.method === 'notifications/initialized')
      return new Response(null, { status: 202 });
    if (failure) return new Response(null, { status: failure });
    let result;
    if (request.method === 'initialize')
      result = { protocolVersion: '2025-06-18' };
    else if (!request.params.cursor) result = {
      tools: [{ name: 'fetch', annotations: { readOnlyHint: true } },
        { name: 'delete', annotations: { destructiveHint: true } },
        { name: 'contradictory',
          annotations: { readOnlyHint: true, destructiveHint: true } },
        { name: 'unknown' }], nextCursor: 'next',
    };
    else result = { tools: [{ name: duplicate ? 'fetch' : 'search',
      annotations: { readOnlyHint: true } }] };
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    return new Response(sse ? `event: message\ndata: ${body}\n\n` : body,
      { headers: { 'mcp-session-id': 'test-session' } });
  } };
}

for (const sse of [false, true]) {
  test(`catalog pagination and read-only hints, SSE=${sse}`, async () => {
    const mock = transport({ sse });
    assert.deepEqual(await discoverReadOnlyMcpTools(server, mock.fetch),
      ['fetch', 'search']);
    assert.deepEqual(mock.calls, ['initialize', 'notifications/initialized',
      'tools/list', 'tools/list', 'DELETE']);
    assert.ok(!mock.calls.includes('tools/call'));
  });
}

test('authentication errors have distinct codes and never call tools', async () => {
  for (const [status, code] of [[401, 'USER_MCP_EXISTING_LOGIN_UNAVAILABLE'],
    [403, 'USER_MCP_ACCESS_DENIED']]) {
    const mock = transport({ failure: status });
    await assert.rejects(discoverReadOnlyMcpTools(server, mock.fetch), { code });
    assert.deepEqual(mock.calls, ['initialize']);
  }
});

test('duplicate catalog entries reject and discovery session still retires', async () => {
  const mock = transport({ duplicate: true });
  await assert.rejects(discoverReadOnlyMcpTools(server, mock.fetch),
    { code: 'INVALID_USER_MCP_CATALOG' });
  assert.equal(mock.calls.at(-1), 'DELETE');
});
