import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { requireThat } from '../src/identity.mjs';
import { rootOwnedPath } from '../src/host-paths.mjs';

const boundary = resolve('.deliver-test-tmp');

// Exercise the real filesystem with the test user's ownership. The controlled
// boundary replaces only the privileged ancestor policy, never package checks.
export async function fixtureOwnedPath(path) {
  const child = relative(boundary, path);
  requireThat(isAbsolute(path) && resolve(path) === path &&
    !child.startsWith('..') && !isAbsolute(child) &&
    await realpath(path) === path, 'UNTRUSTED_ADOPTION_PATH');
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    requireThat(!stat.isSymbolicLink() && stat.uid === process.getuid() &&
      (stat.mode & 0o022) === 0, 'UNTRUSTED_ADOPTION_PATH');
    if (current === boundary) break;
  }
}

// Keep the production verifier available for separate public-policy assertions.
export async function requireProductionRefusal(path) {
  await assert.rejects(rootOwnedPath(path), { code: 'UNTRUSTED_ADOPTION_PATH' });
}

mock.module('../src/host-paths.mjs', {
  namedExports: { rootOwnedPath: fixtureOwnedPath },
});
