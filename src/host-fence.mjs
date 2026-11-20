import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isId, requireThat } from './identity.mjs';

export function issueStatePath(stateRoot, issue) {
  requireThat(isId(issue?.repositoryId) && isId(issue.number), 'INVALID_HOST_ISSUE');
  return join(stateRoot, `issue-${issue.repositoryId}-${issue.number}`);
}

export async function privateHostDirectory(path) {
  const stat = await lstat(path);
  requireThat(stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0 &&
    await realpath(path) === resolve(path), 'UNTRUSTED_HOST_STATE');
}
