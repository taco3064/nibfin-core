import assert from 'node:assert/strict';
import test from 'node:test';
import { runNpm } from '../website/scripts/process.mjs';

test('website command runner retains success and failure diagnostics', () => {
  const version = runNpm(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^11\.9\.0\s*$/);
  const missing = runNpm(['run', 'doc01-script-that-does-not-exist']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr,
    /Missing script: "doc01-script-that-does-not-exist"/);
});
