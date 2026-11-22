import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  allowedHosts, createProxy, gatewayEnvironment, gatewayHosts, modelHosts,
  toolDownloadHosts,
} from '../src/egress-proxy.mjs';

const tools = ['registry.npmjs.org', 'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com'];
const proxyMain = fileURLToPath(new URL('../src/egress-proxy.mjs', import.meta.url));

// Captured from origin/main before the provider table was added.
test('Codex hosts, gateway environment and main default stay unchanged', () => {
  assert.deepEqual(allowedHosts, ['chatgpt.com', 'auth.openai.com', ...tools]);
  assert.deepEqual(toolDownloadHosts, tools);
  assert.deepEqual(modelHosts, { codex: ['chatgpt.com', 'auth.openai.com'],
    claude: ['api.anthropic.com'] });
  assert.equal(gatewayHosts(undefined), allowedHosts);
  assert.deepEqual(gatewayEnvironment(), []);
  assert.deepEqual(gatewayEnvironment('codex'), []);
});

test('Claude selection names only its model host and the tool hosts', () => {
  assert.deepEqual(gatewayHosts('claude'), ['api.anthropic.com', ...tools]);
  assert.deepEqual(gatewayEnvironment('claude'), ['NIBFIN_EGRESS_PROVIDER=claude']);
  for (const value of ['codex', 'other', '', 'Claude'])
    assert.throws(() => gatewayHosts(value), /INVALID_EGRESS_PROVIDER/);
  assert.throws(() => gatewayEnvironment('other'), /INVALID_EGRESS_PROVIDER/);
});

function connectStatus(port, host) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    socket.once('data', chunk => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1]));
    });
    socket.on('error', reject);
  });
}

test('Claude gateway permits its hosts and refuses the Codex model hosts',
  async t => {
    // No upstream is contacted: the test closes each tunnel before a ClientHello.
    const server = createProxy({ hosts: gatewayHosts('claude'),
      resolveHost: () => assert.fail('no upstream lookup'),
      connect: () => assert.fail('no upstream connect') });
    const sockets = new Set();
    server.on('connection', socket => sockets.add(socket));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      for (const socket of sockets) socket.destroy();
    }));
    const { port } = server.address();
    for (const host of ['api.anthropic.com', ...tools])
      assert.equal(await connectStatus(port, host), 200, host);
    for (const host of ['chatgpt.com', 'auth.openai.com', 'github.com'])
      assert.equal(await connectStatus(port, host), 403, host);
  });

function runMain(value) {
  const env = { PATH: process.env.PATH, NIBFIN_EGRESS_PROVIDER: value };
  return new Promise(resolve => execFile(process.execPath, [proxyMain],
    { env, timeout: 30000 }, error => resolve(error?.code)));
}

test('proxy main exits non-zero before listening on an invalid provider',
  async () => {
    for (const value of ['codex', 'other']) {
      const code = await runMain(value);
      assert.ok(Number.isInteger(code) && code !== 0, value);
    }
  });
