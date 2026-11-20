import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observePackageUse } from '../src/package-use.mjs';

test('native proc observes an open package descriptor and then its closure', async t => {
  const scratch = resolve('.nibfin-cache/tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const candidate = await mkdtemp(join(scratch, 'package-proc-'));
  t.after(() => rm(candidate, { recursive: true, force: true }));
  // Restrict only process enumeration. All proc reads, mount parsing and
  // descriptor observations are native; this is not host-wide non-use proof.
  const visiblePid = (await readlink('/proc/self')).split('/').at(-1);
  assert.match(visiblePid, /^\d+$/);
  const ports = { list: path => path === '/proc' ?
    [visiblePid] : readdir(path) };
  const handle = await open(join(candidate, 'held'), 'wx');
  try {
    const used = await observePackageUse(candidate, ports);
    assert.equal(used.reason, 'PACKAGE_PROCESS_OR_MOUNT_REFERENCE');
  } finally { await handle.close(); }
  assert.deepEqual(await observePackageUse(candidate, ports), { used: false });
});
