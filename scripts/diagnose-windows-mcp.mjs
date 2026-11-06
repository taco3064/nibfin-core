import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

// Temporary credential-free CI diagnosis; retire after the failure is understood.
const jsonScript = `
[Console]::Error.WriteLine('MARK_START')
$raw=[Console]::In.ReadToEnd()
[Console]::Error.WriteLine('MARK_RAW')
$data=$raw | ConvertFrom-Json
[Console]::Error.WriteLine('MARK_JSON')
$acl=Get-Acl -LiteralPath $data.path
[Console]::Error.WriteLine('MARK_ACL')
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
[Console]::Error.WriteLine('MARK_RULES')
[Console]::Write('OK')
`;
const nativeScript = `
[Console]::Error.WriteLine('MARK_START')
$raw=[Console]::In.ReadToEnd()
[Console]::Error.WriteLine('MARK_RAW')
$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))
$acl=[IO.Directory]::GetAccessControl($path)
[Console]::Error.WriteLine('MARK_ACL')
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
[Console]::Error.WriteLine('MARK_RULES')
[Console]::Write('OK')
`;
const minimal = { SystemRoot: 'C:/Windows' };
const systemModules = { ...minimal,
  PSModulePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules' };
for (const [name, env, script, input] of [
  ['minimal-json', minimal, jsonScript, JSON.stringify({ path: homedir() })],
  ['minimal-native', minimal, nativeScript, Buffer.from(homedir()).toString('base64')],
  ['system-modules-json', systemModules, jsonScript,
    JSON.stringify({ path: homedir() })],
  ['inherited-json', process.env, jsonScript, JSON.stringify({ path: homedir() })],
]) {
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', output = '', finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      child.unref();
      resolve({ code, markers: text.match(/MARK_[A-Z]+/g) ?? [],
        ok: output === 'OK', elapsedMs: Date.now() - started });
    };
    const timer = setTimeout(() => { child.kill(); finish('timeout'); }, 8000);
    child.stderr.on('data', bytes => { text = (text + bytes).slice(-4096); });
    child.stdout.on('data', bytes => { output = (output + bytes).slice(-64); });
    child.stdin.on('error', () => {});
    child.on('close', finish);
    child.on('error', () => finish('unavailable'));
    child.stdin.end(input);
  });
  console.log(JSON.stringify({ name, ...result }));
}
