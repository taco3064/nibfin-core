import assert from 'node:assert/strict';
import test from 'node:test';
import { readlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('real admission failures survive transport; production Python preserves package', {
  skip: process.platform !== 'linux' || process.getuid() !== 0 ?
    'Requires the existing root Linux private mount fixture' : false,
}, async () => {
  const parent = await readlink('/proc/self/ns/mnt');
  const child = spawnSync('/usr/bin/unshare', ['--mount', '--fork', process.execPath,
    'test/rollout-manager-native-fixture.mjs', parent, 'admission-only'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
});
