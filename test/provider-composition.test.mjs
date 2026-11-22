import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const [name, fixture] of [
  ['dispatch passes Codex options unchanged and Claude options with its binding',
    'test/provider-dispatch-fixture.mjs'],
  ['composition keeps Codex arguments and selects the Claude docker and VM routes',
    'test/provider-compose-fixture.mjs'],
]) {
  test(name, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', fixture,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
