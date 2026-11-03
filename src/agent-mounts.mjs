import { lstat, realpath, readdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireThat } from './identity.mjs';

// Container UID 1000 maps to a subordinate host UID. Access is shared only
// below a controller-owned 0700 parent, never by changing the original auth.
export async function privateMountParent(path) {
  const parent = dirname(path), stat = await lstat(parent);
  requireThat(await realpath(parent) === resolve(parent) && stat.isDirectory() &&
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'AGENT_MOUNT_PARENT_NOT_PRIVATE');
}

export async function shareAgentMount(path, writable) {
  await privateMountParent(path);
  let count = 0, size = 0;
  const entries = [];
  async function inspect(target) {
    const stat = await lstat(target);
    requireThat(++count <= 20000 && !stat.isSymbolicLink() &&
      (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'UNSAFE_AGENT_MOUNT_ENTRY');
    size += stat.isFile() ? stat.size : 0;
    requireThat(size <= 64 * 1024 * 1024, 'AGENT_MOUNT_SIZE_LIMIT');
    const executable = stat.isDirectory() || (stat.mode & 0o111) !== 0;
    requireThat(stat.uid === process.getuid() || (stat.mode & 0o777) === (executable ? 0o777 : 0o666), 'UNRECLAIMED_AGENT_MOUNT');
    if (stat.uid === process.getuid()) entries.push([target, executable]);
    if (stat.isDirectory()) for (const name of await readdir(target)) await inspect(join(target, name));
  }
  await inspect(path);
  // Validate the entire tree before changing permissions; preserve executable
  // status so access preparation cannot create a candidate Git mode change.
  for (const [target, executable] of entries) await chmod(target, (writable ? 0o666 : 0o644) | (executable ? 0o111 : 0));
}

// Run only after the Agent container is proven absent, with network disabled,
// no credentials, no capabilities and only the writable private mounts.
// Ignore symlinks (including Codex executable aliases); never chmod their target.
export const cleanupAgentMounts = `
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
function visit(target) {
  const stat = fs.lstatSync(target);
  if (++count > 30000) throw new Error('CLEANUP_LIMIT');
  if (stat.isSymbolicLink()) return;
  if (!(stat.isDirectory() || stat.isFile() && stat.nlink === 1)) throw new Error('UNSAFE_CLEANUP_ENTRY');
  if (stat.uid === process.getuid()) fs.chmodSync(target, (stat.isDirectory() || stat.mode & 0o111) ? 0o777 : 0o666);
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) visit(path.join(target, name));
}
for (const root of process.argv.slice(1)) visit(root);
`;
