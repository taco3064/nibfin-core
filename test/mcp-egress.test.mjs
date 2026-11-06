import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMcpEgress } from '../src/mcp-egress.mjs';
import { validMcpEgress, allowedHosts } from '../src/egress-proxy.mjs';

const execution = '00000000-0000-4000-8000-000000000001';
test('egress rejects expiry, commands, invalid names and wildcard routes', () => {
  const policy = { schemaVersion: 1, executionId: execution,
    hosts: ['mcp.notion.com'], expiresAt: Date.now() + 10000 };
  assert.equal(validMcpEgress(policy), true);
  for (const patch of [{ expiresAt: 0 }, { expiresAt: Date.now() + 3600000 },
    { hosts: ['*.notion.com'] }, { hosts: ['mcp.notion.com:443'] },
    { hosts: ['mcp.notion.com', 'mcp.notion.com'] }, { command: 'anything' }])
    assert.equal(validMcpEgress({ ...policy, ...patch }), false);
  assert.equal(allowedHosts.includes('mcp.notion.com'), false);
});

test('egress lease is exclusive, tamper-evident and explicitly retired', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-egress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'policy');
  await mkdir(directory, { mode: 0o755 });
  const lease = await acquireMcpEgress(directory, execution, ['mcp.notion.com']);
  const path = join(directory, 'current.json');
  assert.equal(validMcpEgress(JSON.parse(await readFile(path, 'utf8'))), true);
  await assert.rejects(acquireMcpEgress(directory, execution, ['example.com']),
    { code: 'EEXIST' });
  await lease.release();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const changed = await acquireMcpEgress(directory, execution, ['example.com']);
  await chmod(path, 0o644);
  await writeFile(path, '{}');
  await chmod(path, 0o444);
  await assert.rejects(changed.release(), { code: 'MCP_EGRESS_POLICY_CHANGED' });
});
