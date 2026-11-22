import { constants } from 'node:fs';
import { mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digest, isId, requireThat } from './identity.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { recoveryFile, syncRecoveryDirectory } from './recovery-lock.mjs';
import { observedProcessIdentity, processIdentity }
  from './host-memory-pressure.mjs';
import { removeMcpJobCopy } from './mcp-job.mjs';

// Job MCP copies live under the Issue state root, so an entry can attribute a
// leftover copy to its Issue. The host-wide replay claims stay in mcp-jobs.
export const mcpCopyOwnerFile = 'owner.json';
const ownerLimit = 1024;
const startTicks = /^[1-9][0-9]*$/;
const copiesRoot = issueRoot => join(issueRoot, 'mcp-copies');

export function mcpJobCopyPath(issueRoot, binding) {
  requireThat(typeof issueRoot === 'string', 'INVALID_MCP_JOB_COPY_ROOT');
  return join(copiesRoot(issueRoot), digest(binding));
}

function validOwner(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'pid,schemaVersion,startTicks' &&
    value.schemaVersion === 1 && isId(value.pid) &&
    typeof value.startTicks === 'string' && startTicks.test(value.startTicks);
}

// The launcher that prepares the copy owns it. Read before any acquisition.
export async function mcpCopyOwner(identity = processIdentity) {
  const own = await identity(process.pid);
  const owner = { schemaVersion: 1, pid: own?.pid, startTicks: own?.startTicks };
  requireThat(own?.pid === process.pid && validOwner(owner),
    'MCP_JOB_OWNER_UNAVAILABLE');
  return owner;
}

// Order: private parent, copy directory, owner record. source.json follows.
export async function createMcpJobCopy(directory, owner) {
  requireThat(validOwner(owner), 'MCP_JOB_OWNER_UNAVAILABLE');
  const parent = dirname(directory);
  await mkdir(parent, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await privateHostDirectory(parent);
  await mkdir(directory, { mode: 0o700 });
  await privateHostDirectory(directory);
  const file = await open(join(directory, mcpCopyOwnerFile), constants.O_WRONLY |
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
  finally { await file.close(); }
  await syncRecoveryDirectory(directory);
  await syncRecoveryDirectory(parent);
}

// Any unexpected state keeps the copy: only positive evidence clears it.
async function provenUnconsumed(path, observe) {
  try {
    await privateHostDirectory(path);
    const entries = await readdir(path);
    // Created before its owner record: no source and no consumer ever existed.
    if (entries.length === 0) return true;
    if (!entries.includes(mcpCopyOwnerFile) ||
      entries.some(name => name.startsWith('mcp-discovery.json'))) return false;
    const { bytes } = await recoveryFile(join(path, mcpCopyOwnerFile), ownerLimit);
    const owner = JSON.parse(bytes);
    if (!validOwner(owner)) return false;
    const live = await observe(owner.pid);
    return live === null || live.startTicks !== owner.startTicks;
  } catch { return false; }
}

// Run only after this Issue's containers/Job VMs and previous launcher lease
// are proven stopped. Returns false while any copy's termination is unproven.
export async function settleMcpJobCopies(issueRoot,
  observe = observedProcessIdentity) {
  const parent = copiesRoot(issueRoot);
  let names;
  try {
    await privateHostDirectory(parent);
    names = await readdir(parent);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  let settled = true;
  for (const name of names.sort()) {
    const path = join(parent, name);
    if (await provenUnconsumed(path, observe)) await removeMcpJobCopy(path);
    else settled = false;
  }
  return settled;
}
