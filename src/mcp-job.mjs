import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, isId, requireThat } from './identity.mjs';
import { privateHostDirectory } from './host-fence.mjs';

const fields = ['repositoryId', 'memberId', 'runnerId', 'runId', 'attempt', 'jobId'];

export function mcpJobBinding(runner) {
  const binding = Object.fromEntries(fields.map(key => [key, runner[key]]));
  requireThat(fields.every(key => isId(binding[key])), 'INVALID_MCP_JOB');
  return binding;
}

export function validateMcpJob(binding) {
  requireThat(binding && Object.keys(binding).sort().join(',') ===
    [...fields].sort().join(','), 'INVALID_MCP_JOB');
  return mcpJobBinding(binding);
}

async function syncDirectory(root) {
  const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

// This tombstone is an acquisition guard, not a delivery journal. Claim before
// any native request; retain even if preparation fails or copies are retired.
export async function claimMcpJob(root, runner) {
  await privateHostDirectory(root);
  const binding = mcpJobBinding(runner);
  const directory = join(root, 'mcp-jobs');
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await privateHostDirectory(directory);
  // Never evict a replay guard automatically. A full ledger requires trusted
  // reconciliation against terminal Jobs before any additional acquisition.
  requireThat((await readdir(directory)).length < 8192, 'MCP_JOB_GUARD_CAPACITY');
  const path = join(directory, digest(binding) + '.json');
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') requireThat(false, 'MCP_JOB_ALREADY_CLAIMED');
    throw error;
  }
  const bytes = JSON.stringify({ schemaVersion: 1, binding });
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(directory);
  await syncDirectory(root);
  const inspect = async () => {
    await privateHostDirectory(directory);
    const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await current.stat();
      requireThat(stat.isFile() && stat.nlink === 1 &&
        stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
        stat.size === Buffer.byteLength(bytes) &&
        await current.readFile('utf8') === bytes, 'MCP_JOB_GUARD_CHANGED');
    } finally { await current.close(); }
  };
  await inspect();
  return { binding, directory, inspect };
}

// The host owns this capability. Every role wrapper shares the same promise.
// A rejected promise remains rejected; cancellation never clears the claim.
export function jobMcpProfile(prepare) {
  let promise;
  let active = 0, uncertain = false, retired = false;
  return {
    read() {
      requireThat(!retired, 'MCP_JOB_RETIRED');
      return promise ??= Promise.resolve().then(prepare).then(profile => {
        const freeze = value => {
          if (value && typeof value === 'object') {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
          }
          return value;
        };
        return freeze(profile);
      });
    },
    enter() {
      requireThat(!retired, 'MCP_JOB_RETIRED');
      active++;
      let finished = false;
      return proved => {
        requireThat(!finished, 'MCP_CONSUMER_ALREADY_FINISHED');
        finished = true;
        active--;
        if (!proved) uncertain = true;
      };
    },
    async retire(copies, stopped) {
      requireThat(!retired && active === 0 && !uncertain && stopped === true,
        'MCP_JOB_TERMINATION_UNPROVEN');
      // Failed/unknown preparation cannot acquire a cleanup privilege.
      if (promise) await promise;
      for (const path of copies) {
        await privateHostDirectory(path);
        const stat = await lstat(path);
        requireThat(stat.isDirectory(), 'UNTRUSTED_MCP_JOB_COPY');
        await rm(path, { recursive: true });
      }
      promise = undefined;
      retired = true;
    },
  };
}
