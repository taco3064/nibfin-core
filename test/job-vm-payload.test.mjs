import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildJobVmPayload } from '../src/job-vm-tools.mjs';

// The production builder uses the installed Python contract. Development uses
// project PATH Python; no test assumes a particular host interpreter location.
function python(args) {
  const result = spawnSync('python3', ['-B', ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('authoritative runtime payload and project link confinement', () => {
  python(['test/job-vm-payload.test.py']);
});

test('the shared producer always sends private fixed executor bytes', async () => {
  const parent = join(process.cwd(), '.deliver-test-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'payload-builder-'));
  try {
    let calls = 0;
    const archive = await buildJobVmPayload(directory, Buffer.from('job-bound'),
      undefined, {
        archiveTools: () => assert.fail('No image needed for runtime-only payload'),
        run: async (_executable, args) => {
          calls++;
          python(args);
          return { exitCode: 0 };
        },
      });
    assert.equal(calls, 1);
    const bytes = await readFile(archive);
    assert.equal(bytes.length % 512, 0);
    assert.equal(bytes.subarray(0, 18).toString(), 'job-vm-executor.py');
    assert.equal(bytes.subarray(512, 521).toString(), 'job-bound');
    assert.deepEqual(await readdir(directory), ['runtime.tar']);
    await assert.rejects(buildJobVmPayload(directory, Buffer.from('snapshot'),
      undefined, { run: async () => ({ exitCode: 1,
        stdout: Buffer.from(JSON.stringify({ code: 'JOB_VM_PAYLOAD_UNSAFE' })),
      }) }), { code: 'JOB_VM_PAYLOAD_UNSAFE' });
    assert.deepEqual(await readdir(directory), ['runtime.tar']);
    await assert.rejects(buildJobVmPayload(directory, undefined),
      { code: 'JOB_VM_EXECUTOR_SNAPSHOT_REQUIRED' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
