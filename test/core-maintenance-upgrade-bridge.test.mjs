import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('fixed bridge waits on matching upgrade readiness before ordinary dispatch', () => {
  const result = spawnSync('python3', ['-B', 'test/core-maintenance-upgrade-bridge.py'], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
