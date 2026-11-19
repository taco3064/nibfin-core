import { requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';

export function sharedArchiveMember(listing, member) {
  const matches = listing.split('\n').filter(name =>
    name.replace(/^\.\//, '') === member);
  requireThat(matches.length === 1, 'INVALID_SHARED_ARCHIVE_MEMBERS');
  return matches[0];
}

// Consumers verify archive provenance before entering this transport. Yield one
// member at a time so callers can verify it without retaining the whole package.
export async function* sharedArchiveMembers(path, members, {
  inspect = rootOwnedPath, run = command,
} = {}) {
  await inspect('/usr/bin/tar');
  const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    limit: 256 * 1024 * 1024 };
  const { stdout: listing } = await run('/usr/bin/tar',
    ['--list', '--file', path], options);
  for (const member of members) {
    const name = sharedArchiveMember(listing.toString(), member);
    const { stdout: bytes } = await run('/usr/bin/tar', [
      '--extract', '--to-stdout', '--file', path, '--', name,
    ], options);
    yield { member, bytes };
  }
}
