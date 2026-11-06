import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

// Temporary CI diagnosis: no credentials, configuration changes or MCP calls.
const script = `
[Console]::Error.WriteLine('MARK_START')
$data=[Console]::In.ReadToEnd() | ConvertFrom-Json
[Console]::Error.WriteLine('MARK_READ')
$acl=Get-Acl -LiteralPath $data.path
[Console]::Error.WriteLine('MARK_ACL')
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
[Console]::Error.WriteLine('MARK_RULES')
[Console]::Write('OK')
`;
const base = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
  USERPROFILE: homedir(), TEMP: process.env.TEMP, TMP: process.env.TMP,
  PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0' };
for (const [name, env, windowsHide] of [
  ['minimal-visible', { SystemRoot: 'C:/Windows' }, false],
  ['minimal-hidden', { SystemRoot: 'C:/Windows' }, true],
  ['os-base-hidden', base, true],
  ['inherited-hidden', process.env, true],
]) {
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(JSON.stringify({ path: homedir() }));
  });
  console.log(JSON.stringify({ name, ...result }));
}
