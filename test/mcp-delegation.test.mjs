import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inheritUserMcp } from '../src/mcp-profile.mjs';
import { createMcpDelegation, validateMcpDelegation } from '../src/mcp-delegation.mjs';
import { importUserMcp } from '../src/mcp-transfer.mjs';
import { loadUserMcp } from '../src/mcp-source.mjs';
import { Readable } from 'node:stream';

const memberId = 127829492;
function capsule(now = Date.now()) {
  const profile = inheritUserMcp({ notion: {
    url: 'https://mcp.example.com/mcp', enabled_tools: ['fetch'],
    http_headers: { Authorization: 'Bearer test-only-access-token' },
    oauth: { client_secret: 'never-export-client-secret' },
  } });
  Object.assign(profile.metadata, {
    nativeVersion: 'codex-cli 0.166.0-alpha.6', sourceHash: 'a'.repeat(64),
  });
  profile.expiresAt = now + 2 * 3600000;
  return createMcpDelegation(profile, memberId, { now, platform: 'win32' });
}

test('delegation binds actual expiry and strips OAuth registration credentials', () => {
  const now = Date.now(), value = capsule(now);
  assert.equal(value.expiresAt, now + 2 * 3600000);
  assert.ok(!JSON.stringify(value).includes('never-export-client-secret'));
  const profile = validateMcpDelegation(value, memberId, now);
  assert.equal(profile.expiresAt, value.expiresAt);
  assert.equal(profile.configuration.mcp_servers.notion.http_headers.Authorization,
    'Bearer test-only-access-token');
  assert.deepEqual(profile.configuration.mcp_servers.notion.enabled_tools, ['fetch']);
});

test('wrong member, invalid time, commands and unsafe diagnostics deny', () => {
  const now = Date.now(), original = capsule(now);
  const changes = [
    { memberId: memberId + 1 }, { issuedAt: now + 60000 },
    { expiresAt: now + 1000 }, { expiresAt: now + 9 * 3600000 },
    { nativeVersion: 'codex-cli 0.138.0' }, { refresh_token: 'not-permitted' },
    { nativeVersion: ['codex-cli 0.166.0'] },
    { diagnostics: [{ name: 'notion', code: 'https://secret.example/' }] },
    { diagnostics: [{ name: ['notion'], code: ['USER_MCP_UNAVAILABLE'] }] },
    { servers: { notion: { command: 'node', args: ['escape.js'] } } },
  ];
  for (const change of changes)
    assert.throws(() => validateMcpDelegation({ ...original, ...change }, memberId, now),
      { code: 'INVALID_MCP_DELEGATION' });
});

test('private import and runtime apply native member and discovery restrictions', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'delegation.json'), value = capsule();
  const result = await importUserMcp(Readable.from([JSON.stringify(value)]),
    memberId, path);
  assert.equal(result.memberId, memberId);
  assert.ok(!JSON.stringify(result).includes('test-only-access-token'));
  let restricted = false;
  const source = { kind: 'delegated-http-v1', file: path };
  const profile = await loadUserMcp(source, { memberId,
    restrict: async incoming => {
      restricted = true;
      incoming.configuration.mcp_servers.notion.enabled_tools = [];
    } });
  assert.equal(restricted, true);
  assert.equal(profile.expiresAt, value.expiresAt);
  assert.deepEqual(profile.configuration.mcp_servers.notion.enabled_tools, []);
  await assert.rejects(loadUserMcp(source, { memberId: memberId + 1 }),
    { code: 'INVALID_MCP_DELEGATION' });
  await assert.rejects(importUserMcp(Readable.from([JSON.stringify(value)]),
    memberId, path), { code: 'EEXIST' });
  await chmod(path, 0o644);
  await assert.rejects(loadUserMcp(source, { memberId }),
    { code: 'UNTRUSTED_USER_MCP_SOURCE' });
});

test('private source rejects hard links before reading delegated credentials', {
  skip: process.platform !== 'linux',
}, async t => {
  const { link } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-hardlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'delegation.json');
  await writeFile(path, JSON.stringify(capsule()), { mode: 0o600 });
  await mkdir(join(root, 'other'), { mode: 0o700 });
  await link(path, join(root, 'other', 'linked.json'));
  await assert.rejects(loadUserMcp({ kind: 'delegated-http-v1', file: path },
    { memberId }), { code: 'UNTRUSTED_USER_MCP_SOURCE' });
});
