import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mcpHttpRequest } from '../src/mcp-http.mjs';

test('discovery rejects private DNS answers before contacting the host', async () => {
  let contacted = false;
  for (const addresses of [[{ address: '127.0.0.1' }],
    [{ address: '1.1.1.1' }, { address: '169.254.169.254' }]]) {
    await assert.rejects(mcpHttpRequest('https://mcp.example.com/mcp', {}, {
      resolve: async () => addresses,
      request: () => { contacted = true; },
    }), { code: 'USER_MCP_NONPUBLIC_ENDPOINT' });
  }
  assert.equal(contacted, false);
});

test('discovery pins the public address while retaining original TLS identity',
  async () => {
    let observed, lookups = 0;
    const response = await mcpHttpRequest('https://mcp.example.com/mcp?a=1', {
      method: 'POST', headers: { Authorization: 'Bearer private-test-token' },
      body: '{}', signal: AbortSignal.timeout(1000),
    }, {
      resolve: async () => { lookups++; return [{ address: '1.1.1.1' }]; },
      request: (options, callback) => {
        observed = options;
        const request = new EventEmitter();
        request.end = () => {
          const stream = Readable.from([Buffer.from('{}')]);
          stream.statusCode = 200;
          stream.headers = { 'mcp-session-id': 'private-session' };
          callback(stream);
        };
        return request;
      },
    });
    assert.equal(lookups, 1);
    assert.equal(observed.hostname, '1.1.1.1');
    assert.equal(observed.servername, 'mcp.example.com');
    assert.equal(observed.headers.Host, 'mcp.example.com');
    assert.equal(observed.path, '/mcp?a=1');
    assert.equal(observed.agent, false);
    assert.equal(response.headers.get('mcp-session-id'), 'private-session');
    assert.equal(await response.text(), '{}');
  });
