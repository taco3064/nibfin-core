import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireThat, digest } from './identity.mjs';
import { validMcpEgress, validProjectEgress, projectDomains } from './egress-proxy.mjs';

export const mcpPolicyEnvironment = 'NIBFIN_MCP_POLICY_DIRECTORY';
export const mcpPolicyMount = '/mcp-policy';
const projectPolicyName = 'project.json';
const policyReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

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
  return acquirePolicy(directory, executionId, hosts, 'current.json', validMcpEgress);
}

export async function acquireProjectEgress(directory, executionId, hosts) {
  // The caller has verified its adopted gateway has no role container.
  // Publish this invocation's policy rather than treating old metadata as a lock.
  return acquirePolicy(directory, executionId, projectDomains(hosts),
    projectPolicyName, validProjectEgress, true);
}

async function acquirePolicy(directory, executionId, hosts, name, validate,
  replaceCurrent = false) {
  await verifyMcpPolicyDirectory(directory);
  const policy = { schemaVersion: 1, executionId, hosts,
    expiresAt: Date.now() + 31 * 60 * 1000 };
  requireThat(validate(policy), 'INVALID_MCP_EGRESS_POLICY');
  const path = join(directory, name), text = JSON.stringify(policy);
  requireThat(Buffer.byteLength(text) <= 65536, 'EGRESS_POLICY_TOO_LARGE');
  if (replaceCurrent) await publishProjectPolicy(path, text);
  else await writePolicyFile(path, text);
  const sync = async () => {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  await sync();
  return {
    hash: digest(policy),
    async release() {
      await verifyMcpPolicyDirectory(directory);
      const handle = await open(path, policyReadFlags);
      try {
        await validatePolicyFile(handle);
        requireThat(await handle.readFile('utf8') === text,
          'MCP_EGRESS_POLICY_CHANGED');
      } finally { await handle.close(); }
      await unlink(path);
      await sync();
    },
  };
}

async function writePolicyFile(path, text) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
}

async function validatePolicyFile(handle) {
  const stat = await handle.stat();
  requireThat(stat.isFile() && stat.uid === process.getuid() &&
    stat.nlink === 1 && (stat.mode & 0o777) === 0o444,
  'MCP_EGRESS_POLICY_CHANGED');
}

async function existingPolicyFile(path) {
  let handle;
  try { handle = await open(path, policyReadFlags); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try { await validatePolicyFile(handle); }
  finally { await handle.close(); }
  return true;
}

async function removeStagingPolicy(path) {
  if (await existingPolicyFile(path)) await unlink(path);
}

async function publishProjectPolicy(path, text) {
  // Core alone owns these names. A previous attempt may have stopped during
  // publication, so old contents and expiration do not determine eligibility.
  await existingPolicyFile(path);
  const next = join(dirname(path), `.${projectPolicyName}.next`);
  await removeStagingPolicy(next);
  try {
    await writePolicyFile(next, text);
    await rename(next, path);
  } finally { await removeStagingPolicy(next); }
}
