import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotJobVmWorkspace, validateJobVmWorkspace }
  from '../src/job-vm-workspace.mjs';

test('legacy guest file restore receives a marker for the configured tool scratch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'vm-workspace-'));
    try {
      await writeFile(join(root, 'source.mjs'), 'export const value = 1;\n');
      const temporaryDirectory = '.nibfin-cache/tmp';
      const marker = temporaryDirectory + '/.nibfin-directory';
      const files = await snapshotJobVmWorkspace(root, { temporaryDirectory });
      assert.deepEqual(files.find(file => file.path === marker), {
        path: marker, executable: false, content: '',
      });
      assert.equal(validateJobVmWorkspace(files).length, 2);
      assert.equal((await snapshotJobVmWorkspace(root)).length, 1);
      await mkdir(join(root, temporaryDirectory), { recursive: true });
      await writeFile(join(root, marker), 'retained');
      const repeated = await snapshotJobVmWorkspace(root, { temporaryDirectory });
      assert.equal(repeated.filter(file => file.path === marker).length, 1);
      assert.equal(repeated.find(file => file.path === marker).content,
        Buffer.from('retained').toString('base64'));
      await assert.rejects(snapshotJobVmWorkspace(root, {
        temporaryDirectory: '../outside',
      }), { code: 'UNSAFE_JOB_VM_WORKSPACE' });
    } finally { await rm(root, { recursive: true }); }
  });

test('scratch preparation cannot conceal a conflicting Candidate file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vm-workspace-'));
  try {
    await writeFile(join(root, '.nibfin-cache'), 'maintained file');
    await assert.rejects(snapshotJobVmWorkspace(root, {
      temporaryDirectory: '.nibfin-cache/tmp',
    }), { code: 'INVALID_JOB_VM_WORKSPACE_PATHS' });
  } finally { await rm(root, { recursive: true }); }
});
