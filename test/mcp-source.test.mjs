import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeMcpConfiguration, loadUserMcp } from '../src/mcp-source.mjs';

test('native reader preserves full policies without a model turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-native-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'server.cjs');
  await writeFile(script, `
const readline = require('node:readline');
const lines = readline.createInterface({input: process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize')
    process.stdout.write(JSON.stringify({id: 1, result: {}}) + '\\n');
  if (request.method === 'config/read')
    process.stdout.write(JSON.stringify({id: 2, result: {config: {
      mcp_servers: {notion: {url: 'https://example.com/mcp',
        default_tools_approval_mode: 'prompt'}}
    }}}) + '\\n');
});
`);
  // Node interprets these positional app-server arguments as a script filename.
  await writeFile(join(root, 'app-server'), await readFile(script));
  const config = await readNativeMcpConfiguration(process.execPath, {
    cwd: root, env: {}, timeout: 3000,
  });
  assert.equal(config.config.mcp_servers.notion.default_tools_approval_mode, 'prompt');
});

test('native configuration reader has a bounded timeout and sanitized error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-native-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app-server'), 'setInterval(() => {}, 1000);');
  await assert.rejects(readNativeMcpConfiguration(process.execPath, {
    cwd: root, env: {}, timeout: 100,
  }), { code: 'USER_MCP_CONFIG_TIMEOUT' });
});

for (const response of ['success', 'error', 'malformed']) {
test(`a surviving native helper denies termination proof after ${response}`, {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-native-helper-'));
  t.after(async () => {
    // The fixture helper has a fixed lifetime; never kill a reused PID/group.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'app-server'), `
const {spawn} = require('node:child_process');
spawn(process.execPath, ['-e',
  "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1000)"],
  {stdio:'ignore'}).unref();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);
  if(message.method==='initialize')
    process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
  if(message.method==='config/read') setTimeout(()=>
    process.stdout.write(${JSON.stringify(response === 'malformed' ? '{\n' :
      JSON.stringify(response === 'error' ? { id: 2, error: { code: 1 } } :
        { id: 2, result: { config: {} } }) + '\n')}),200);
});
setInterval(()=>{},1000);
`);
  await assert.rejects(readNativeMcpConfiguration(process.execPath, {
    cwd: root, env: {}, timeout: 3000,
  }), { code: 'USER_MCP_CONFIG_TERMINATION_UNKNOWN' });
});
}

test('native source distinguishes missing login and unavailable plugin config', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), '', { mode: 0o600 });
  const config = { mcp_servers: { notion: { url: 'https://example.com/mcp' } } };
  const profile = await loadUserMcp({ home: root, codex: process.execPath,
    uid: process.getuid() }, {
    validateExecutable: async () => {}, nativeRead: async () => ({ config,
      layers: [{ name: { type: 'user', file: join(root, 'config.toml') },
        version: 'test-version', config }] }),
    run: async (_exe, args) => ({ stdout: Buffer.from(args[0] === '--version' ?
      'codex-cli 0.166.0' : JSON.stringify([
      { name: 'notion', enabled: true, auth_status: 'not_logged_in' },
      { name: 'plugin', enabled: true, auth_status: 'unsupported' },
    ])) }),
    restrict: async profile => {
      assert.equal(profile.configuration.mcp_servers.notion.enabled, false);
    },
  }).catch(error => {
    // The source must deny root-owned input before considering credentials.
    if (process.getuid() === 0) {
      assert.equal(error.code, 'INVALID_USER_MCP_SOURCE');
      return null;
    }
    throw error;
  });
  if (process.getuid() !== 0) {
    assert.deepEqual(profile.metadata.diagnostics.map(item => item.code), [
      'USER_MCP_EXISTING_LOGIN_UNAVAILABLE',
      'USER_MCP_PLUGIN_CONFIGURATION_UNAVAILABLE',
    ]);
    assert.deepEqual(profile.metadata.hosts, []);
  }
});
