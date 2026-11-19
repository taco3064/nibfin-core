import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalStat } from './retirement-files.mjs';
import { requireThat } from './identity.mjs';

// Transaction readback, not a fixed work-version gate. This identifies whether
// an interrupted rename already installed the selected package's actual bytes.
export async function runnerEntryIdentity(path) {
  if (!await optionalStat(path)) return null;
  const hash = createHash('sha256');
  const walk = async (entry, relative) => {
    const stat = await lstat(entry);
    requireThat(stat.uid === 0 && (stat.isSymbolicLink() ||
      (stat.mode & 0o022) === 0), 'RUNNER_REFRESH_PACKAGE_PATH_UNTRUSTED');
    hash.update(JSON.stringify([relative, stat.mode & 0o777, stat.isDirectory()]));
    if (stat.isSymbolicLink()) hash.update(await readlink(entry));
    else if (stat.isDirectory()) {
      for (const name of (await readdir(entry)).sort())
        await walk(join(entry, name), relative + '/' + name);
    } else {
      requireThat(stat.isFile() && stat.nlink === 1,
        'RUNNER_REFRESH_PACKAGE_PATH_UNTRUSTED');
      const file = await open(entry, 'r');
      try {
        for await (const bytes of file.createReadStream({ autoClose: false }))
          hash.update(bytes);
      } finally { await file.close(); }
    }
  };
  await walk(path, '');
  return hash.digest('hex');
}
