import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';

// Integrity and privilege checks are one policy shared by normal installation
// and the independently installed management entry. This grants no admission.
export async function verifyOwnedSourcePackage(path, pin) {
  await rootOwnedPath(path);
  const source = await verifyInstalledSource(path, pin);
  const manifest = JSON.parse(await readFile(join(path,
    'nibfin-manifest.json'), 'utf8'));
  await rootOwnedPath(join(path, 'nibfin-manifest.json'));
  for (const file of manifest.files) await rootOwnedPath(join(path, file.path));
  return source;
}
