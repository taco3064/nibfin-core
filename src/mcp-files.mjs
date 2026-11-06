import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';

const aclScript = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($current,'S-1-5-18','S-1-5-32-544')
$writes=[Security.AccessControl.FileSystemRights]::Write -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach($item in $request.paths) {
  $acl=Get-Acl -LiteralPath $item.path
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -notin $trusted) {throw 'Untrusted owner'}
  foreach($entry in $acl.GetAccessRules($true,$true,
    [Security.Principal.SecurityIdentifier])) {
    if($entry.AccessControlType -ne 'Allow') {continue}
    if(-not $item.private -and ($entry.PropagationFlags -band
      [Security.AccessControl.PropagationFlags]::InheritOnly)) {continue}
    $sid=$entry.IdentityReference.Value
    if($sid -notin $trusted -and ($item.private -or
      ($entry.FileSystemRights -band $writes))) {throw 'Untrusted access'}
  }
}
[Console]::Out.Write('MCP_ACL_VERIFIED')
`;

export async function protectWindowsMcpDirectory(path, run = command) {
  const script = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$path=[Console]::In.ReadToEnd() | ConvertFrom-Json
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($current.Value,'S-1-5-18','S-1-5-32-544')) {
  $identity=[Security.Principal.SecurityIdentifier]::new($sid)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,
    'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
`;
  await run('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: JSON.stringify(path), env: { SystemRoot: 'C:/Windows' },
      timeout: 15000, limit: 1024 });
  await verifyMcpPath(path, { directory: true, run });
}

function normalized(path) {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

export async function verifyMcpPath(path, {
  directory = false, privateAccess = true, uid = process.getuid?.(),
  run = command,
} = {}) {
  requireThat(typeof path === 'string' && isAbsolute(path) &&
    normalized(await realpath(path)) === normalized(path),
  'UNTRUSTED_USER_MCP_SOURCE');
  const stat = await lstat(path);
  requireThat(directory ? stat.isDirectory() && !stat.isSymbolicLink() :
    stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink(),
  'UNTRUSTED_USER_MCP_SOURCE');
  if (process.platform === 'win32') {
    let result;
    try { result = await run(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', aclScript],
      { input: JSON.stringify({ paths: [
        { path, private: privateAccess }, { path: dirname(path), private: false },
      ] }),
        env: { SystemRoot: 'C:/Windows' }, timeout: 15000, limit: 1024 },
    ); } catch (error) {
      error.mcpPhase = 'WINDOWS_MCP_ACL_QUERY';
      throw error;
    }
    requireThat(result.stdout.toString() === 'MCP_ACL_VERIFIED',
      'UNTRUSTED_USER_MCP_SOURCE');
  } else {
    requireThat(stat.uid === uid &&
      (stat.mode & (privateAccess ? 0o077 : 0o022)) === 0,
    'UNTRUSTED_USER_MCP_SOURCE');
  }
}

export async function readPrivateMcpJson(path, options = {}) {
  await verifyMcpPath(dirname(path), { ...options, directory: true });
  await verifyMcpPath(path, options);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024,
      'UNTRUSTED_USER_MCP_SOURCE');
    if (process.platform !== 'win32')
      requireThat(stat.uid === (options.uid ?? process.getuid()) &&
        (stat.mode & 0o077) === 0, 'UNTRUSTED_USER_MCP_SOURCE');
    const bytes = await file.readFile();
    requireThat(bytes.length <= 1024 * 1024, 'USER_MCP_CREDENTIAL_STORE_TOO_LARGE');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file.close(); }
}
