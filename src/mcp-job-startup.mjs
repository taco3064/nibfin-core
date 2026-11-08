import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readMcpOwnerAdoption } from './mcp-job-owner.mjs';
import { requireThat } from './identity.mjs';

// Separately adopted startup entry. This credential-blind parent never reads
// bridge output. The native supervisor owns relay streams and completion proof.
export async function startMcpJobPeer() {
  const c = await readMcpOwnerAdoption();
  const child = spawn(c.supervisor.path, ['--bridge', c.node.path,
    fileURLToPath(new URL('./mcp-job-bridge.mjs', import.meta.url)), c.home,
    c.wsl.path, c.distribution], {
    env: { SystemRoot: 'C:/Windows' }, shell: false, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const code = await new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', yes);
  });
  requireThat(code === 0, 'MCP_JOB_STARTUP_UNRESOLVED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpJobPeer().catch(() => {
    process.stderr.write('MCP_JOB_STARTUP_UNRESOLVED\n');
    process.exitCode = 1;
  });
}
