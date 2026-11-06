import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, link, mkdir, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../src/process.mjs';
import { readNativeMcpConfiguration } from '../src/mcp-native.mjs';
import { protectWindowsMcpDirectory, readPrivateMcpJson } from '../src/mcp-files.mjs';
import { storePrivateMcpDelegation } from '../src/mcp-transfer.mjs';
import { createMcpDelegation } from '../src/mcp-delegation.mjs';
import { inheritUserMcp } from '../src/mcp-profile.mjs';
import { prepareWindowsMcpReader } from '../src/mcp-windows.mjs';

const windows = { skip: process.platform !== 'win32' };
for (const response of ['success', 'error', 'malformed']) {
  test(`Windows job retires helpers after ${response}`, windows, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-mcp-job-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'helper.cjs'), `
require('node:fs').writeFileSync('helper.pid', String(process.pid));
setInterval(()=>{},1000);
`);
    const reply = response === 'malformed' ? '{\n' : JSON.stringify(
      response === 'error' ? { id: 2, error: { code: 1 } } :
        { id: 2, result: { config: { inherited: true } } }) + '\n';
    await writeFile(join(root, 'app-server'), `
require('node:child_process').spawn(process.execPath,['helper.cjs'],{
  windowsHide:true,stdio:'ignore'
}).unref();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);
  if(message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
  if(message.id===2) setTimeout(()=>process.stdout.write(${JSON.stringify(reply)}),200);
});
`);
    const pending = readNativeMcpConfiguration(process.execPath, {
      cwd: root, env: {}, timeout: 10000,
    });
    if (response === 'success') assert.equal((await pending).config.inherited, true);
    else await assert.rejects(pending, { code: response === 'error' ?
      'USER_MCP_CONFIG_READ_FAILED' : 'INVALID_NATIVE_MCP_CONFIG_RESPONSE' });
    const pid = Number(await readFile(join(root, 'helper.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('Windows private file rejects broad access, hard links and directory junctions',
  windows, async t => {
    const root = await mkdtemp(join(homedir(), '.nibfin-mcp-acl-test-'));
    await protectWindowsMcpDirectory(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'credential.json');
    await writeFile(file, '{"testOnly":true}');
    assert.deepEqual(await readPrivateMcpJson(file), { testOnly: true });
    const unicode = join(root, '權限.json');
    await writeFile(unicode, '{"unicodePath":true}');
    assert.deepEqual(await readPrivateMcpJson(unicode), { unicodePath: true });
    await link(file, join(root, 'linked.json'));
    await assert.rejects(readPrivateMcpJson(file),
      { code: 'UNTRUSTED_USER_MCP_SOURCE' });
    await rm(join(root, 'linked.json'));
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'value.json'), '{}');
    await symlink(join(root, 'real'), join(root, 'junction'), 'junction');
    await assert.rejects(readPrivateMcpJson(join(root, 'junction', 'value.json')),
      { code: 'UNTRUSTED_USER_MCP_SOURCE' });
    const script = `
$ErrorActionPreference='Stop'
$path=[Console]::In.ReadToEnd() | ConvertFrom-Json
$acl=Get-Acl -LiteralPath $path
$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  $users,'Read','Allow'))
Set-Acl -LiteralPath $path -AclObject $acl
`;
    await command('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { input: JSON.stringify(file), env: { SystemRoot: 'C:/Windows' } });
    await assert.rejects(readPrivateMcpJson(file), { code: 'PROCESS_FAILED' });
  });

test('inheritable child read denies export before any credential bytes are written',
  windows, async t => {
    const root = await mkdtemp(join(homedir(), '.nibfin-mcp-inherit-test-'));
    await protectWindowsMcpDirectory(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const profile = inheritUserMcp({ notion: {
      url: 'https://mcp.example.com/mcp',
      http_headers: { Authorization: 'Bearer test-only-no-write' },
    } });
    Object.assign(profile.metadata, { nativeVersion: 'codex-cli 0.166.0',
      sourceHash: 'a'.repeat(64) });
    const value = createMcpDelegation(profile, 1);
    // icacls updates only this disposable directory's DACL. PowerShell Set-Acl
    // required SeSecurityPrivilege for this fixture; no policy change is needed.
    await command('C:/Windows/System32/icacls.exe',
      [root, '/grant', '*S-1-5-32-545:(OI)(IO)(R)'],
      { env: { SystemRoot: 'C:/Windows' } });
    const output = join(root, 'capsule.json');
    await assert.rejects(storePrivateMcpDelegation(output, value),
      { code: 'PROCESS_FAILED' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  });

test('known compiler failures retire their private preparation directory',
  windows, async () => {
    let root;
    await assert.rejects(prepareWindowsMcpReader({ build: async (_exe, args) => {
      const { dirname } = await import('node:path');
      root = dirname(args.find(arg => arg.startsWith('/out:')).slice(5));
      throw Object.assign(Error('Known compiler exit'), { code: 'PROCESS_FAILED' });
    } }), { code: 'PROCESS_FAILED' });
    await assert.rejects(readFile(join(root, 'reader.exe')), { code: 'ENOENT' });
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(root), { code: 'ENOENT' });
  });
