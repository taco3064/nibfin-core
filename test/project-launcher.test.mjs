import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const unresolved of ['journal', 'containers', 'mcp']) {
  const name = `configuration settles resources; retains unresolved ${unresolved}`;
  test(name, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', 'test/project-launcher-fixture.mjs',
      unresolved,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('launcher retries setup reads and authenticates settled continuation retry', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', 'test/project-launcher-fixture.mjs',
    'retry',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
