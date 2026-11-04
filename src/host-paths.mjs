import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { requireThat } from './identity.mjs';

export async function rootOwnedPath(path) {
  requireThat(
    isAbsolute(path) && resolve(path) === path && (await realpath(path)) === path,
    'UNTRUSTED_ADOPTION_PATH',
  );
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    requireThat(
      !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0,
      'UNTRUSTED_ADOPTION_PATH',
    );
    if (current === '/') break;
  }
}
