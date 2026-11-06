import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireThat, digest } from './identity.mjs';
import { validMcpEgress } from './egress-proxy.mjs';

export const mcpPolicyEnvironment = 'NIBFIN_MCP_POLICY_DIRECTORY';
export const mcpPolicyMount = '/mcp-policy';

export async function verifyMcpPolicyDirectory(path) {
  requireThat(typeof path === 'string' && resolve(path) === path &&
    await realpath(path) === path, 'UNTRUSTED_MCP_EGRESS_DIRECTORY');
  const stat = await lstat(path), parent = await lstat(dirname(path));
  requireThat(stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o755 && parent.isDirectory() &&
    parent.uid === process.getuid() && (parent.mode & 0o077) === 0 &&
    await realpath(dirname(path)) === dirname(path),
  'UNTRUSTED_MCP_EGRESS_DIRECTORY');
}

export async function acquireMcpEgress(directory, executionId, hosts) {
  await verifyMcpPolicyDirectory(directory);
  const policy = { schemaVersion: 1, executionId, hosts,
    expiresAt: Date.now() + 31 * 60 * 1000 };
  requireThat(validMcpEgress(policy), 'INVALID_MCP_EGRESS_POLICY');
  const path = join(directory, 'current.json'), text = JSON.stringify(policy);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
  const sync = async () => {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  await sync();
  return {
    hash: digest(policy),
    async release() {
      await verifyMcpPolicyDirectory(directory);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        requireThat(stat.isFile() && stat.uid === process.getuid() &&
          stat.nlink === 1 && (stat.mode & 0o777) === 0o444 &&
          await handle.readFile('utf8') === text, 'MCP_EGRESS_POLICY_CHANGED');
      } finally { await handle.close(); }
      await unlink(path);
      await sync();
    },
  };
}
