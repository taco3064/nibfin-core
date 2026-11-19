import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat } from './identity.mjs';

// Each role has its own disposable mount. It belongs to the role UID rather
// than unmapped container root, so ordinary private fixtures retain meaningful
// ownership checks inside the nested command sandbox.
export const agentScratchOptions =
  'rw,exec,nosuid,nodev,size=2g,mode=0700,uid=1000,gid=1000';
export const agentScratchMount = '/tmp:' + agentScratchOptions;

export const writerTemporaryDirectory = '.nibfin-cache/tmp';

// Prepare the assigned repository before either host mounting or VM transfer.
// The current guest protocol transfers files, so .keep carries the empty path.
export async function prepareWriterTemporaryDirectory(work) {
  requireThat(await realpath(work) === work, 'UNTRUSTED_WRITER_TEMPORARY_PATH');
  let directory = work;
  for (const component of writerTemporaryDirectory.split('/')) {
    directory = join(directory, component);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    requireThat((await lstat(directory)).isDirectory() &&
      await realpath(directory) === directory, 'UNTRUSTED_WRITER_TEMPORARY_PATH');
  }
  const marker = join(directory, '.keep');
  try {
    const file = await open(marker, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(marker);
    requireThat(stat.isFile() && stat.nlink === 1, 'UNTRUSTED_WRITER_TEMPORARY_PATH');
  }
}
