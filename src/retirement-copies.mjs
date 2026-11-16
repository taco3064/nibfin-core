import { readdir, realpath, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateResource } from './managed-credential-files.mjs';
import { optionalStat, resourceIdentity } from './retirement-files.mjs';
import { assertNoSlotMounts } from './retirement-observe.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const execution = /^execution-[a-f0-9-]{36}$/;
const session = /^session-[a-f0-9]{64}$/;
const issue = /^issue-[1-9][0-9]*-[1-9][0-9]*$/;

async function agentRoots(host) {
  await privateResource(host.stateRoot, host.uid, true);
  const result = [];
  for (const name of await readdir(host.stateRoot)) {
    if (!issue.test(name)) continue;
    const root = join(host.stateRoot, name);
    await privateResource(root, host.uid, true);
    const agent = join(root, 'agent');
    if (await optionalStat(agent)) {
      await privateResource(agent, host.uid, true);
      result.push(agent);
    }
  }
  return result;
}

export async function inspectRetirementSessions(host) {
  for (const root of await agentRoots(host)) {
    for (const name of await readdir(root)) {
      if (!session.test(name)) continue;
      const path = join(root, name);
      await privateResource(path, host.uid, true);
      requireThat(!await optionalStat(join(path, 'active.lock')),
        'RETIREMENT_WRITER_PENDING');
    }
  }
}

// Inventory only Core-created provider credential/home copies. Candidate output,
// main/work trees, receipts, original conversations and login stores are excluded.
export async function retirementCopies(host) {
  await inspectRetirementSessions(host);
  const copies = [];
  const record = async path => {
    const stat = await lstat(path);
    requireThat(await realpath(path) === path && stat.isDirectory() &&
      stat.uid === host.uid, 'RETIREMENT_COPY_IDENTITY_CHANGED');
    copies.push({ path, identity: resourceIdentity(stat) });
  };
  for (const root of await agentRoots(host)) {
    for (const name of await readdir(root)) {
      const directory = join(root, name);
      if (session.test(name)) {
        const home = join(directory, 'home');
        if (await optionalStat(home)) await record(home);
      }
      if (!execution.test(name)) continue;
      await privateResource(directory, host.uid, true);
      for (const child of await readdir(directory)) {
        if (/^agent-auth-[A-Za-z0-9]{6}$/.test(child))
          await record(join(directory, child));
      }
    }
  }
  return copies;
}

export async function observeRetirementCopies(copies) {
  let remaining = false;
  for (const copy of copies) {
    const stat = await optionalStat(copy.path);
    if (!stat) continue;
    requireThat(await realpath(copy.path) === copy.path && stat.isDirectory() &&
      stat.dev === copy.identity.dev && stat.ino === copy.identity.ino,
    'RETIREMENT_COPY_IDENTITY_CHANGED');
    remaining = true;
  }
  return remaining ? 'absent' : 'done';
}

export async function removeRetirementCopies(copies) {
  await observeRetirementCopies(copies);
  for (const copy of copies) {
    if (!await optionalStat(copy.path)) continue;
    await assertNoSlotMounts(copy.path);
    await rm(copy.path, { recursive: true });
    await syncRecoveryDirectory(join(copy.path, '..'));
  }
}
