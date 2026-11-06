import test from 'node:test';
import assert from 'node:assert/strict';
import { inheritUserMcp, privateMcpToml } from '../src/mcp-profile.mjs';
import { restrictMcpToReadOnly } from '../src/mcp-catalog.mjs';
import { withUserMcp } from '../src/mcp-agent.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = 'https://mcp.example.com/mcp';
const make = server => inheritUserMcp({ notion: { url, ...server } });

test('inheritance preserves filters and stricter prompts, without user hooks', () => {
  const original = { url, enabled_tools: ['fetch'], disabled_tools: ['delete'],
    default_tools_approval_mode: 'prompt',
    tools: { fetch: { approval_mode: 'auto' }, edit: { approval_mode: 'prompt' } } };
  const profile = inheritUserMcp({ notion: original });
  const server = profile.configuration.mcp_servers.notion;
  assert.deepEqual(server.enabled_tools, ['fetch']);
  assert.deepEqual(server.disabled_tools, ['delete']);
  assert.equal(server.default_tools_approval_mode, 'prompt');
  assert.equal(server.tools.fetch.approval_mode, 'writes');
  assert.equal(server.tools.edit.approval_mode, 'prompt');
  assert.equal(original.tools.fetch.approval_mode, 'auto');
  assert.deepEqual(Object.keys(profile.configuration).sort(),
    ['mcp_oauth_credentials_store', 'mcp_servers']);
  assert.match(privateMcpToml(profile), /mcp_servers/);
});

test('only matching unexpired native access tokens are delegated', () => {
  const now = 1000000;
  const entry = { server_name: 'notion', server_url: url,
    access_token: 'private-access-token', refresh_token: 'never-delegate-refresh',
    expires_at: now + 3600000 };
  const credentials = { nativeKey: entry };
  const profile = inheritUserMcp({ notion: { url } }, { credentials, now });
  const toml = privateMcpToml(profile);
  assert.match(toml, /Bearer private-access-token/);
  assert.ok(!toml.includes(entry.refresh_token));
  assert.deepEqual(credentials, { nativeKey: entry });
  assert.ok(!JSON.stringify(profile.metadata).includes(entry.access_token));
  const expired = inheritUserMcp({ notion: { url } }, {
    now, credentials: { key: { ...entry, expires_at: now } },
  });
  assert.equal(expired.configuration.mcp_servers.notion.enabled, false);
  assert.equal(expired.metadata.diagnostics[0].code,
    'USER_MCP_AUTHENTICATION_REFRESH_REQUIRED');
  const foreign = inheritUserMcp({ notion: { url } }, {
    now, credentials: { key: { ...entry, server_name: 'another-server' } },
  });
  assert.deepEqual(foreign.configuration.mcp_servers.notion.http_headers, {});
});

test('STDIO and unknown settings fail explicitly rather than escape isolation', () => {
  for (const original of [{ command: 'node', args: ['untrusted.js'] },
    { url, unknown_setting: true }]) {
    const profile = inheritUserMcp({ local: original });
    assert.equal(profile.configuration.mcp_servers.local.enabled, false);
    assert.equal(profile.metadata.diagnostics.length, 1);
    assert.throws(() => inheritUserMcp({ local: { ...original, required: true } }),
      { code: 'REQUIRED_USER_MCP_UNAVAILABLE' });
  }
});

test('header injection, ambiguous credentials and non-HTTPS endpoints deny', () => {
  for (const server of [
    { http_headers: { Authorization: 'bad\r\ninjected: value' } },
    { http_headers: { Authorization: 'one', authorization: 'two' } },
    { url: 'http://mcp.example.com/mcp' },
    { url: 'https://user:secret@mcp.example.com/mcp' },
  ]) assert.equal(make(server).configuration.mcp_servers.notion.enabled, false);
});

test('read-only catalog tools intersect original user filters', async () => {
  const profile = make({ enabled_tools: ['fetch', 'delete', 'search'],
    disabled_tools: ['search'] });
  await restrictMcpToReadOnly(profile, async () => ['fetch', 'search', 'other']);
  assert.deepEqual(profile.configuration.mcp_servers.notion.enabled_tools, ['fetch']);
  const denied = make({ required: true });
  await assert.rejects(restrictMcpToReadOnly(denied, async () => []),
    { code: 'REQUIRED_USER_MCP_UNAVAILABLE' });
});

test('MCP credentials stay out of the plan and leaked output rejects', async t => {
  const output = await mkdtemp(join(tmpdir(), 'nibfin-mcp-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(join(output, 'result.json'), '{}');
  const profile = make({ http_headers: { Authorization: 'Bearer private-token' } });
  let observed;
  const adapter = withUserMcp({ async execute(input) {
    observed = input;
    return { status: 'completed', stdout: '', stderr: '' };
  } }, { trusted: true }, async () => profile);
  const input = { output, plan: { args: ['exec', '--ignore-user-config'],
    prompt: 'Role', policyHash: 'a'.repeat(64) } };
  await adapter.execute(input);
  assert.ok(!observed.plan.args.includes('--ignore-user-config'));
  assert.ok(!JSON.stringify(observed.plan).includes('private-token'));
  assert.equal(observed.mcp, profile);
  await writeFile(join(output, 'result.json'), 'private-token');
  await assert.rejects(adapter.execute(input), {
    code: 'MCP_CREDENTIAL_OUTPUT_REJECTED',
  });
  assert.equal(withUserMcp(observed, undefined), observed);
});
