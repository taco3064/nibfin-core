import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserMcp } from '../src/mcp-resolve.mjs';
import { resolve, join } from 'node:path';

const source = { codex: process.execPath, home: resolve('test') };
const url = 'https://mcp.example.com/mcp';
function options(status, credentials = {}) {
  return { credentials,
    nativeRead: async () => ({
      config: { mcp_servers: { notion: { url, enabled_tools: ['fetch'] } } },
      layers: [{ name: { type: 'user', file: join(source.home, 'config.toml') },
        version: 'sha256:test', config: {} }],
    }),
    run: async (_exe, args) => ({ stdout: Buffer.from(args[0] === '--version' ?
      'codex-cli 0.166.0' : JSON.stringify([
        { name: 'notion', enabled: true, auth_status: status },
      ])) }),
  };
}
test('native o_auth and oauth spellings preserve keyring diagnostics', async () => {
  for (const spelling of ['o_auth', 'oauth']) {
    const profile = await resolveUserMcp(source, options(spelling));
    assert.equal(profile.configuration.mcp_servers.notion.enabled, false);
    assert.equal(profile.metadata.diagnostics[0].code,
      'USER_MCP_NATIVE_KEYRING_UNAVAILABLE');
  }
});

test('actual native status accepts matching file-cache access delegation', async () => {
  const credentials = { key: { server_name: 'notion', server_url: url,
    access_token: 'test-only-current-access', refresh_token: 'never-forward-refresh',
    expires_at: Date.now() + 3600000 } };
  const profile = await resolveUserMcp(source, options('o_auth', credentials));
  assert.equal(profile.metadata.diagnostics.length, 0);
  assert.ok(!JSON.stringify(profile.configuration).includes('never-forward-refresh'));
  assert.equal(profile.configuration.mcp_servers.notion.http_headers.Authorization,
    'Bearer test-only-current-access');
});

test('unknown native authentication status never becomes an authenticated source',
  async () => {
    await assert.rejects(resolveUserMcp(source, options('future_auth')),
      { code: 'USER_MCP_AUTH_STATUS_UNSUPPORTED' });
  });
