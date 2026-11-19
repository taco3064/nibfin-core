import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { installEngineFile, exactFile } from './engine-files.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { command } from './process.mjs';
import { engine } from './engine-contract.mjs';
import { reclamationProgram, reclamationEnvironment as env }
  from './storage-reclamation.mjs';

export const reclamationPolicy = `${engine.controller} ALL=(root) NOPASSWD: ` +
  `${reclamationProgram} ""\n`;
const directory = '/etc/sudoers.d';
const target = join(directory, 'nibfin-storage-reclamation');
const native = {
  rootOwnedPath, installEngineFile, exactFile, unlink, syncRecoveryDirectory,
  run: (path, args) => command(path, args, { env }),
};

// Reconcile an identical owned policy, including publication response loss.
// Conflicting files are never replaced. No Runner or Agent receives a grant.
export async function installStorageReclamation(io = native) {
  await io.rootOwnedPath(directory);
  for (const path of [reclamationProgram, '/usr/sbin/visudo', '/usr/bin/sudo',
    '/usr/sbin/runuser']) await io.rootOwnedPath(path);
  const temp = join(directory, `.nibfin-reclamation-${randomUUID()}`);
  try {
    await io.installEngineFile(temp, reclamationPolicy, 0o440);
    await io.run('/usr/sbin/visudo', ['-cf', temp]);
    await io.installEngineFile(target, reclamationPolicy, 0o440);
  } finally {
    await io.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await io.syncRecoveryDirectory(directory);
  }
  await io.exactFile(target, reclamationPolicy, 0o440);
  await io.run('/usr/sbin/visudo', ['-cf', target]);
  await io.run('/usr/sbin/runuser', ['-u', engine.controller, '--',
    '/usr/bin/sudo', '-n', '-l', '-u', 'root', '--', reclamationProgram]);
}
