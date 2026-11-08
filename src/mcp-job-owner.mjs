import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './process.mjs';
import { verifyMcpPath, readPrivateMcpJson } from './mcp-files.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { requireThat, sha256, isDigest, isId } from './identity.mjs';
import { resolveUserMcp } from './mcp-resolve.mjs';
import { readNativeMcpConfiguration } from './mcp-native.mjs';
import { createMcpDelegation } from './mcp-delegation.mjs';
import { validateMcpRequest, encodeMcpFrame } from './mcp-job-codec.mjs';
import { mcpJobChannel } from './mcp-job-channel.mjs';

export const ownerAdoptionFile = 'C:/ProgramData/Nibfin/mcp-job.json';

// Adoption is read only from a fixed private Windows-owner location. The
// startup caller has no command line or environment configuration interface.
export async function readMcpOwnerAdoption() {
  requireThat(process.platform === 'win32', 'UNSUPPORTED_MCP_JOB_OWNER');
  const c = await readPrivateMcpJson(ownerAdoptionFile);
  requireThat(c.schemaVersion === 1 && typeof c.sid === 'string' &&
    /^S-1-5-[0-9-]+$/.test(c.sid) &&
    ['repositoryId', 'memberId', 'runnerId'].every(key => isId(c[key])),
  'INVALID_MCP_JOB_ADOPTION');
  const result = await command(
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.Write(' +
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)'],
    { env: { SystemRoot: 'C:/Windows' }, limit: 1024 },
  );
  requireThat(result.stdout.toString() === c.sid, 'MCP_JOB_OWNER_MISMATCH');
  const root = fileURLToPath(new URL('..', import.meta.url));
  await verifyMcpPath(resolve(root), { directory: true, privateAccess: false });
  await verifyInstalledSource(root, c.pin);
  requireThat(isDigest(c.supervisor?.sourceHash) &&
    sha256(await readFile(join(root, 'src/mcp-windows-job.cs'))) ===
      c.supervisor.sourceHash, 'MCP_JOB_SUPERVISOR_SOURCE_CHANGED');
  for (const key of ['node', 'supervisor', 'codex', 'wsl']) {
    requireThat(c[key] && isDigest(c[key].sha256), 'INVALID_MCP_JOB_ADOPTION');
    await verifyMcpPath(c[key].path, { privateAccess: false });
    requireThat(sha256(await readFile(c[key].path)) === c[key].sha256,
      'MCP_JOB_EXECUTABLE_CHANGED');
  }
  requireThat(resolve(c.node.path).toLowerCase() ===
    resolve(process.execPath).toLowerCase() &&
    c.wsl.path === 'C:/Windows/System32/wsl.exe' &&
    typeof c.distribution === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.distribution),
  'INVALID_MCP_JOB_ADOPTION');
  await verifyMcpPath(c.home, { directory: true, privateAccess: false });
  await verifyMcpPath(join(c.home, 'config.toml'), { privateAccess: false });
  await verifyMcpPath(c.authenticationHome, { directory: true });
  return c;
}

export async function produceJobMcp(request, c) {
  validateMcpRequest(request);
  requireThat(['repositoryId', 'memberId', 'runnerId'].every(key =>
    request.binding[key] === c[key]), 'MCP_JOB_OWNER_BINDING_MISMATCH');
  const credentials = await readPrivateMcpJson(
    join(c.authenticationHome, '.credentials.json'));
  // The installed supervisor is already verified. Do not compile a helper in
  // the Job preparation path or impose a guessed compilation deadline.
  const profile = await resolveUserMcp({ codex: c.codex.path, home: c.home }, {
    credentials,
    environment: { SystemRoot: 'C:/Windows' },
    nativeRead: (executable, options) => readNativeMcpConfiguration(executable, {
      ...options, installedReader: {
        executable: c.supervisor.path, hash: c.supervisor.sha256,
      },
    }),
    validateSystemFile: path => verifyMcpPath(path, { privateAccess: false }),
  });
  requireThat(Object.values(profile.configuration.mcp_servers)
    .some(server => server.enabled !== false), 'USER_MCP_NO_USABLE_SERVERS');
  return createMcpDelegation(profile, request.binding.memberId);
}

// Internal installed producer endpoint, started only inside the Windows Job
// Object supervisor. This is not a public Core CLI command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const channel = mcpJobChannel(process.stdin, () => { process.exitCode = 1; });
    const request = validateMcpRequest(await channel.request);
    const c = await readMcpOwnerAdoption();
    const delegation = await produceJobMcp(request, c);
    requireThat(!channel.cancelled, 'MCP_JOB_CANCELLED');
    process.stdout.write(encodeMcpFrame({ ...request, delegation }));
    process.stdin.destroy();
  } catch {
    process.stderr.write('MCP_JOB_PRODUCER_UNRESOLVED\n');
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
