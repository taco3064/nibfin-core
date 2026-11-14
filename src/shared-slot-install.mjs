import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm }
  from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { checkSharedRunnerSlot } from './security/shared-runner-start-check.mjs';

// The early admission dispatcher implements the tested 2.338.2 wire protocol.
const archiveHash = 'baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40';
const dispatcher = new URL('./security/shared-worker-dispatcher.sh', import.meta.url);
const registrationFiles = ['.runner', '.credentials', '.credentials_rsaparams'];

async function copyPrivateFile(path, destination, owner, limit, group, mode) {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    requireThat(stat.isFile() && stat.uid === owner && stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= limit,
    'UNTRUSTED_SHARED_SLOT_INPUT');
    const output = await open(destination, 'wx', 0o600);
    try {
      let size = 0;
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        requireThat(size <= limit, 'UNTRUSTED_SHARED_SLOT_INPUT');
        hash.update(buffer.subarray(0, bytesRead));
        for (let offset = 0; offset < bytesRead;) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
          requireThat(bytesWritten > 0, 'SHARED_SLOT_COPY_FAILED');
          offset += bytesWritten;
        }
      }
      requireThat(size === stat.size, 'UNTRUSTED_SHARED_SLOT_INPUT');
      await output.chown(0, group);
      await output.chmod(mode);
      await output.sync();
      return hash.digest('hex');
    } finally { await output.close(); }
  } finally { await input.close(); }
}

async function slotAccount(slot, uid) {
  await rootOwnedPath('/usr/bin/getent');
  const user = `nibfin-runner-${slot}`;
  const { stdout } = await command('/usr/bin/getent', ['passwd', user], { limit: 4096 });
  const [name, , observed, group] = stdout.toString().trim().split(':');
  const { stdout: groups } = await command('/usr/bin/getent', ['group', user],
    { limit: 4096 });
  const [groupName, , groupId, members] = groups.toString().trim().split(':');
  requireThat(name === user && Number(observed) === uid && /^[1-9]\d*$/.test(group) &&
    groupName === user && groupId === group && (!members || members === user),
  'SHARED_RUNNER_ACCOUNT_MISMATCH');
  return Number(group);
}

export async function installSharedSlot(source, slot, owner, runner, repository, uid,
  { parent = '/var/lib/nibfin/runners', lookupGroup = slotAccount } = {}) {
  requireThat((slot === 1 || slot === 2) && Number.isSafeInteger(owner) && owner > 0 &&
    isAbsolute(source) && resolve(source) === source, 'UNTRUSTED_SHARED_SLOT_INPUT');
  await rootOwnedPath(resolve(parent, '..'));
  await mkdir(parent, { mode: 0o755 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await rootOwnedPath(parent);
  const destination = join(parent, `slot-${slot}`);
  const group = await lookupGroup(slot, uid);
  const inspect = directory =>
    checkSharedRunnerSlot(directory, runner, repository, { group, uid, checkAccess: false });
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) {
    await inspect(destination);
    return;
  }
  const scratch = await mkdtemp(join(parent, '.nibfin-slot-'));
  try {
    const archive = join(scratch, 'runner.tar.gz');
    const digest = await copyPrivateFile(join(source, '.nibfin-runner-package'),
      archive, owner, 512 * 1024 * 1024, 0, 0o600);
    requireThat(digest === archiveHash, 'UNSUPPORTED_SHARED_RUNNER_PACKAGE');
    const staged = join(scratch, 'slot');
    await mkdir(staged, { mode: 0o755 });
    await chmod(staged, 0o755);
    await rootOwnedPath('/usr/bin/tar');
    await command('/usr/bin/tar', [
      '--extract', '--gzip', '--file', archive, '--directory', staged,
      '--no-same-owner', '--same-permissions',
    ], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    for (const name of registrationFiles) {
      await copyPrivateFile(join(source, name), join(staged, name), owner, 65536,
        group, 0o640);
    }
    const worker = join(staged, 'bin', 'Runner.Worker');
    await rename(worker, worker + '.official');
    const script = await open(worker, 'wx', 0o755);
    try {
      await script.writeFile(await readFile(dispatcher));
      await script.chmod(0o755);
      await script.sync();
    } finally { await script.close(); }
    for (const name of ['_work', '_diag']) {
      const path = join(staged, name);
      await mkdir(path, { mode: 0o700 });
      const file = await open(path, 'r');
      try { await file.chown(uid, group); }
      finally { await file.close(); }
    }
    const entry = join(staged, 'bin', 'runsvc.sh');
    await rootOwnedPath(entry);
    requireThat(((await lstat(entry)).mode & 0o111) !== 0,
      'SHARED_RUNNER_SERVICE_ENTRY_UNAVAILABLE');
    await inspect(staged);
    await rename(staged, destination);
    await syncRecoveryDirectory(parent);
    await inspect(destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
