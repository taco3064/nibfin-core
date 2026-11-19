import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('installed legacy recovery settles its own unstarted replacement and dispatches',
  () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
      'test/rollout-installed-resume-fixture.mjs'], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
