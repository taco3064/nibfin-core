import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './process.mjs';
import { requireThat, sha256 } from './identity.mjs';
import { verifyMcpPath, protectWindowsMcpDirectory } from './mcp-files.mjs';

// Build the shipped configuration-reader source using the existing Microsoft
// compiler. No execution-policy changes, scripts bypass, service or SDK install.
export async function prepareWindowsMcpReader({ build = command } = {}) {
  const parent = await realpath(homedir());
  await verifyMcpPath(parent, { directory: true, privateAccess: false });
  const root = await mkdtemp(join(parent, '.nibfin-mcp-reader-'));
  const executable = join(root, 'reader.exe');
  const release = async () => {
      requireThat(await realpath(root) === resolve(root) && dirname(root) === parent &&
        basename(root).startsWith('.nibfin-mcp-reader-'),
      'WINDOWS_MCP_READER_CLEANUP_REQUIRED');
      await verifyMcpPath(root, { directory: true });
      requireThat((await readdir(root)).every(name => name === 'reader.exe'),
        'WINDOWS_MCP_READER_CLEANUP_REQUIRED');
      await rm(root, { recursive: true });
  };
  try {
    await protectWindowsMcpDirectory(root);
    const source = fileURLToPath(new URL('./mcp-windows-job.cs', import.meta.url));
    await build('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ['/nologo', '/target:exe', '/platform:anycpu', `/out:${executable}`, source],
      { env: { SystemRoot: 'C:/Windows', TEMP: root, TMP: root },
        timeout: 15000, limit: 16384 });
    await verifyMcpPath(executable);
    return { executable, hash: sha256(await readFile(executable)), root, release };
  } catch (error) {
    // Known failed compiler exit has never launched the MCP reader. Unknown
    // compiler termination or unverified private state must remain inspectable.
    if (['PROCESS_FAILED', 'PROCESS_UNAVAILABLE'].includes(error.code)) {
      try { await release(); }
      catch { error.recoveryDirectory = root; }
    } else error.recoveryDirectory = root;
    throw error;
  }
}
