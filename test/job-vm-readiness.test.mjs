import test from 'node:test';
import assert from 'node:assert/strict';
import { requireJobVmToolOutput } from '../src/job-vm-workspace.mjs';

const root = '.nibfin-cache/6c603253-dca6-0a82-5df0-f70727526963';
const directories = [root + '/home', root + '/tmp'];
const ready = { ready: true, toolOutput: {
  root, directories, collection: 'preserve-source-omit-owned-output',
} };

test('the #277/#564 old guest ready response cannot start a Writer', () => {
  for (const reply of [{ ready: true }, { ...ready, toolOutput: {
    ...ready.toolOutput, directories: [root + '/home'],
  } }, { ...ready, toolOutput: { ...ready.toolOutput, root: 'different-output' } }]) {
    assert.throws(() => requireJobVmToolOutput(reply, root, directories),
      { code: 'JOB_VM_TOOL_OUTPUT_UNAVAILABLE' });
  }
});

test('runtime maintenance can satisfy the same request without a version gate', () => {
  requireJobVmToolOutput(ready, root, directories);
  requireJobVmToolOutput({ ...ready, toolOutput: {
    ...ready.toolOutput, directories: [...directories].reverse(),
  } }, root, directories);
});
