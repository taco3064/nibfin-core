import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const [name, scenario] of [
  ['a Claude pool refuses target MCP visibly before preparing it', 'claude-mcp'],
  ['a Claude proposal run prepares no MCP and is not refused', 'claude-proposal'],
]) {
  test(name, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', 'test/project-launcher-fixture.mjs',
      scenario,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

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

for (const scenario of ['initial', 'success', 'journal', 'containers',
  'unobserved', 'mcp', 'mcp-read', 'compose', 'compose-read',
  'incomplete', 'active', 'inspection']) {
  test(`preparation settlement: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', 'test/project-launcher-fixture.mjs',
      `prep-${scenario}`,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
