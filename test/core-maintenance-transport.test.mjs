import assert from 'node:assert/strict';
import test from 'node:test';
import { readlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('preWorker subprocess layers retain safe failure and preserve the official frame', {
  skip: process.platform !== 'linux' || process.getuid() !== 0 ?
    'Requires root Linux private mount namespace' : false,
}, async () => {
  const parent = await readlink('/proc/self/ns/mnt');
  const result = spawnSync('/usr/bin/unshare', ['--mount', '--fork', process.execPath,
    'test/rollout-manager-native-fixture.mjs', parent, 'maintenance-transport'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
