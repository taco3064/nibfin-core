import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('relay replacement journals large observations and resumes interruptions', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    'test/rollout-relay-recovery-fixture.mjs'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
