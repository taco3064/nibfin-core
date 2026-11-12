import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('stage and wake inspect the adopted host before protected operations', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', 'test/host-admission-fixture.mjs',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
