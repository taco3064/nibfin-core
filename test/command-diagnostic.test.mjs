import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDiagnostic } from '../src/command-diagnostic.mjs';

test('command failures preserve source locations without credential text', () => {
  const root = new URL('file:///installed/core/');
  const error = new TypeError('private-token in command argument');
  error.stack = [
    'TypeError: private-token in command argument',
    '    at promote (file:///installed/core/src/host-rollout.mjs:83:11)',
    '    at private-token (file:///installed/core/bin/nibfin-core.mjs:31:7)',
    '    at private-token (file:///private-token/other.mjs:1:2)',
    '    at unsafe (file:///installed/core/src/../private-token.mjs:1:2)',
    '    at native (node:internal/process/task_queues:1:2)',
  ].join('\n');
  assert.deepEqual(commandDiagnostic(error, root), { kind: 'TypeError', frames: [
    { file: 'src/host-rollout.mjs', line: 83, column: 11 },
    { file: 'bin/nibfin-core.mjs', line: 31, column: 7 },
  ] });
  assert.ok(!JSON.stringify(commandDiagnostic(error, root)).includes('private-token'));
});

test('unknown exception names and missing stacks do not expose arbitrary text', () => {
  assert.deepEqual(commandDiagnostic({ name: 'private-token' }), {
    kind: 'Error', frames: [],
  });
});
