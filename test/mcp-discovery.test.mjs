import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedMcpDiscovery } from '../src/mcp-discovery.mjs';
import { restrictMcpToReadOnly } from '../src/mcp-catalog.mjs';
import { inheritUserMcp } from '../src/mcp-profile.mjs';

const options = { skip: process.platform !== 'linux' };
const server = { url: 'https://mcp.example.com/mcp' };
test('known discovery retires its private intent', options, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const discover = guardedMcpDiscovery(root, async (_server, _fetch, lifecycle) => {
    await lifecycle.observed('private-session-id');
    const saved = JSON.parse(await readFile(join(root, 'mcp-discovery.json')));
    assert.equal(saved.session, 'private-session-id');
    assert.ok(!JSON.stringify(saved).includes(server.url));
    await lifecycle.retired();
    return ['fetch'];
  });
  assert.deepEqual(await discover(server), ['fetch']);
  await assert.rejects(readFile(join(root, 'mcp-discovery.json')), { code: 'ENOENT' });
});

test('unknown session survives and optional servers cannot swallow or retry it',
  options, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-unknown-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const discover = guardedMcpDiscovery(root, async (_server, _fetch, lifecycle) => {
      calls++;
      await lifecycle.observed('unresolved-session');
      throw Error('Lost cleanup response');
    });
    const profile = inheritUserMcp({ notion: server });
    await assert.rejects(restrictMcpToReadOnly(profile, discover), {
      code: 'USER_MCP_DISCOVERY_UNRESOLVED',
    });
    await assert.rejects(discover(server), { code: 'USER_MCP_DISCOVERY_UNRESOLVED' });
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(join(root, 'mcp-discovery.json')));
    assert.equal(saved.session, 'unresolved-session');
  });
