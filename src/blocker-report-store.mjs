import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, requireThat } from './identity.mjs';
import { readObservationFile } from './local-work-files.mjs';

export const blockerReportsName = 'reports';

// Immutable, independently named reports survive replacement of stage pointers.
export async function saveBlockerReport(receiptsRoot, report) {
  await privateHostDirectory(receiptsRoot);
  const root = join(receiptsRoot, blockerReportsName);
  await mkdir(root, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await privateHostDirectory(root);
  requireThat(Buffer.byteLength(JSON.stringify(report)) <= 2 * 1024 * 1024,
    'REPORT_SIZE_LIMIT');
  const { id, ...body } = report;
  requireThat(digest(body) === id, 'INVALID_REPORT');
  let file;
  try {
    file = await open(join(root, `${id}.json`), constants.O_WRONLY |
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readObservationFile(join(root, `${id}.json`),
      process.getuid(), 2 * 1024 * 1024);
    requireThat(digest(JSON.parse(existing.bytes)) === digest(report),
      'REPORT_PERSISTENCE_FAILED');
    return id;
  }
  try { await file.writeFile(JSON.stringify(report)); await file.sync(); }
  finally { await file.close(); }
  for (const path of [root, receiptsRoot]) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return id;
}
