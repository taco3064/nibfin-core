import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('owned entry publication cleans every failed stage and preserves original error',
  () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
      'test/core-maintenance-cleanup-fixture.mjs'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

test('recovery cleanup retains a renamed package after interrupted sync', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    'test/core-manager-recovery-cleanup-fixture.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
