import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('retirement filesystem regressions use controlled fixture ownership', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    '--import', './test/core-package-retirement-ownership.mjs',
    '--test', '--test-reporter=tap', '--test-concurrency=1',
    'test/core-package-retirement-cases.mjs',
  ], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# tests [1-9][0-9]*\n/);
  assert.match(child.stdout, /# fail 0\n/);
  assert.match(child.stdout, /# skipped 0\n/);
  assert.match(child.stdout, /interrupted deletion resumes only attributed remainder/);
  assert.match(child.stdout, /unexpected replacement after response loss/);
});
