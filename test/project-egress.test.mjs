import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, chmod, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProxy, policyPermits, projectDomains, toolDownloadHosts, validProjectEgress,
} from '../src/egress-proxy.mjs';
import { acquireProjectEgress, acquireMcpEgress } from '../src/mcp-egress.mjs';
import { parseProjectConfig } from '../src/project-config.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { digest } from '../src/identity.mjs';

const execution = '00000000-0000-4000-8000-000000000001';
async function slot(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-project-egress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'policy');
  await mkdir(directory, { mode: 0o755 });
  return directory;
}
function plan(hosts) {
  const content = 'trusted';
  return codexPlan('deliver', { model: 'model', context: {}, additionalDomains: hosts,
    skill: { identity: 'deliver', content, hash: digest(content) } });
}

test('one normalized selection drives general requirements and exact policy', async t => {
  const directory = await slot(t);
  const requested = ['API.Example.com', 'api.example.com'];
  const selected = plan(parseProjectConfig({ allowedDomains: requested }).allowedDomains);
  assert.deepEqual(selected.additionalDomains, ['api.example.com']);
  assert.ok(selected.requirements.includes('"api.example.com"'));
  assert.ok(!selected.requirements.includes('"other.example.com"'));
  assert.ok(!selected.requirements.includes('"mcp.notion.com"'));
  for (const hosts of [undefined, []]) {
    const defaults = plan(hosts);
    assert.ok(defaults.requirements.includes(JSON.stringify(toolDownloadHosts)));
    assert.deepEqual(defaults.additionalDomains, []);
  }
  const lease = await acquireProjectEgress(directory, execution,
    selected.additionalDomains);
  assert.equal(await policyPermits(directory, 'api.example.com', true), true);
  for (const host of ['other.example.com', 'sub.api.example.com',
    'api.example.com.evil.com', 'example.com'])
    assert.equal(await policyPermits(directory, host, true), false);
  await lease.release();
  assert.equal(await policyPermits(directory, 'api.example.com', true), false);
});

test('declarations reject unsafe names before either enforcement layer', () => {
  for (const host of ['*.example.com', 'https://example.com', 'example.com:443',
    '1.1.1.1', '::1', '[::1]', 'localhost', 'a.local', 'a.internal', 'a.lan',
    'a.home', 'a.arpa', 'a.localdomain', 'a..com', '-a.com', 'a-.com',
    'example.com.', ' example.com', 'example.com\n', 'a.123', 'a\n.com']) {
    assert.throws(() => parseProjectConfig({ allowedDomains: [host] }),
      { code: 'PROJECT_CONFIG_INVALID' }, host);
    assert.throws(() => projectDomains([host]), /INVALID_PROJECT_DOMAINS/, host);
  }
});

test('slots and reuse keep project and MCP leases independent', async t => {
  const a = await slot(t), b = await slot(t);
  const first = await acquireProjectEgress(a, execution, ['a.example.com']);
  const second = await acquireProjectEgress(b, execution, ['b.example.com']);
  const mcp = await acquireMcpEgress(a, execution, ['mcp.notion.com']);
  assert.equal(await policyPermits(a, 'b.example.com', true), false);
  assert.equal(await policyPermits(b, 'a.example.com', true), false);
  assert.equal(await policyPermits(a, 'mcp.notion.com', true), false);
  await assert.rejects(acquireProjectEgress(a, execution, []), { code: 'EEXIST' });
  await first.release();
  assert.equal(await policyPermits(a, 'mcp.notion.com'), true);
  const next = await acquireProjectEgress(a, execution, ['b.example.com']);
  assert.equal(await policyPermits(a, 'a.example.com', true), false);
  assert.equal(await policyPermits(a, 'b.example.com', true), true);
  await next.release(); await second.release(); await mcp.release();
});

test('missing, unsafe, tampered and expired project policies fail closed', async t => {
  const directory = await slot(t), path = join(directory, 'project.json');
  assert.equal(await policyPermits(directory, 'a.example.com', true), false);
  const lease = await acquireProjectEgress(directory, execution, ['a.example.com']);
  await chmod(path, 0o644);
  assert.equal(await policyPermits(directory, 'a.example.com', true), false);
  await writeFile(path, '{}'); await chmod(path, 0o444);
  assert.equal(await policyPermits(directory, 'a.example.com', true), false);
  await assert.rejects(lease.release(), { code: 'MCP_EGRESS_POLICY_CHANGED' });
  await rm(path);
  await symlink(join(directory, 'absent'), path);
  assert.equal(await policyPermits(directory, 'a.example.com', true), false);
  await rm(path);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, executionId: execution,
    hosts: ['a.example.com'], expiresAt: 0 }), { mode: 0o444 });
  assert.equal(await policyPermits(directory, 'a.example.com', true), false);
  await rm(path);
  await chmod(directory, 0o777);
  await assert.rejects(acquireProjectEgress(directory, execution, ['a.example.com']),
    { code: 'UNTRUSTED_MCP_EGRESS_DIRECTORY' });
});

// A real TLS client supplies ClientHello; only DNS and the upstream socket are
// synthetic. Every request goes through the production HTTP CONNECT handler.
async function protocol(t, { host = 'api.example.com', port = 443,
  sni = host, addresses = [{ address: '1.1.1.1', family: 4 }], malformed = false,
  ordinary = false } = {}) {
  const directory = await slot(t);
  const lease = await acquireProjectEgress(directory, execution, ['api.example.com']);
  let connections = 0;
  const server = createProxy({ mcpPolicyDirectory: directory,
    resolveHost: async (_host, options) => {
      assert.deepEqual(options, { family: 4, all: true });
      return addresses;
    },
    connect: options => {
      assert.deepEqual(options, { host: '1.1.1.1', port: 443 });
      connections++;
      const upstream = new Duplex({ read() {}, write(_chunk, _encoding, done) {
        done(); this.destroy();
      } });
      setImmediate(() => upstream.emit('connect'));
      return upstream;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  const closed = once(socket, 'close');
  let status;
  socket.once('data', chunk => {
    status = chunk.toString().split('\r\n')[0];
    if (!status.includes('200')) { socket.destroy(); return; }
    if (malformed) socket.write(Buffer.from([23, 3, 1, 0, 0]));
    else {
      const secure = tls.connect({ socket, servername: sni,
        rejectUnauthorized: false });
      secure.on('error', () => {});
    }
  });
  socket.setTimeout(2000, () => socket.destroy(Error('Protocol test timed out')));
  socket.write(ordinary ? 'GET http://api.example.com/ HTTP/1.1\r\n\r\n' :
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  await closed;
  await new Promise(resolve => server.close(resolve));
  await lease.release();
  return { status, connections };
}

test('actual proxy admits requested and default HTTPS hosts', async t => {
  for (const host of ['api.example.com', 'API.Example.com', ...toolDownloadHosts,
    'chatgpt.com', 'auth.openai.com']) {
    const result = await protocol(t, { host });
    assert.match(result.status, /200/);
    assert.equal(result.connections, 1, host);
  }
});

test('actual proxy denials never connect upstream', async t => {
  for (const options of [
    { host: 'other.example.com' }, { host: 'sub.api.example.com' },
    { host: 'api.example.com.evil.com' }, { port: 8443 }, { ordinary: true },
    { sni: 'other.example.com' }, { malformed: true },
    { addresses: [] }, { addresses: [{ address: '10.0.0.1', family: 4 }] },
    { addresses: [{ address: '::1', family: 6 }] },
    { addresses: [{ address: '203.0.113.1', family: 4 }] },
    { addresses: [{ address: '1.1.1.1', family: 4 },
      { address: '192.168.1.1', family: 4 }] },
  ]) {
    const result = await protocol(t, options);
    assert.equal(result.connections, 0, JSON.stringify(options));
  }
});


test('project policy has exact-host semantics independent of the MCP host limit',
  async t => {
    const hosts = Array.from({ length: 101 }, (_, i) => 'host' + i + '.example.com');
    const policy = { schemaVersion: 1, executionId: execution, hosts,
      expiresAt: Date.now() + 10000 };
    assert.equal(validProjectEgress(policy), true);
    for (const patch of [{ hosts: ['*.example.com'] }, { hosts: ['a.local'] },
      { hosts: ['1.1.1.1'] }, { hosts: ['A.example.com'] }, { expiresAt: 0 },
      { hosts: ['a.example.com', 'a.example.com'] }, { command: 'foreign' }])
      assert.equal(validProjectEgress({ ...policy, ...patch }), false);
    const directory = await slot(t);
    const lease = await acquireProjectEgress(directory, execution, hosts);
    assert.equal(await policyPermits(directory, hosts.at(-1), true), true);
    await lease.release();
    const longHosts = Array.from({ length: 400 }, (_, i) =>
      i + '.' + ('a'.repeat(60) + '.').repeat(3) + 'example.com');
    await assert.rejects(acquireProjectEgress(directory, execution, longHosts),
      { code: 'EGRESS_POLICY_TOO_LARGE' });
    const empty = await acquireProjectEgress(directory, execution, []);
    await empty.release();
  });
