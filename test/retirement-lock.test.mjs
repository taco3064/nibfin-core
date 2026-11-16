import { installLockedSharedTemplate } from '../src/shared-service-install.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverRetirementGuard } from '../src/retirement-lock.mjs';
import { retirementLockMarker } from '../src/shared-peer-adoption.mjs';
import { withRelayGate } from '../src/relay-state.mjs';
import { retireSharedHost } from '../src/retirement-host.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'retirement-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, 'rollout.lock');
  const inspect = async path => {
    assert.equal(path, lock);
    assert(!(await lstat(path)).isSymbolicLink());
  };
  return { directory, lock, inspect };
}

test('tagged retirement guards recover under the acquired kernel gate', async t => {
  const f = await fixture(t);
  await writeFile(f.lock, retirementLockMarker, { mode: 0o600 });
  await withRelayGate(f.directory, async () => {
    const competing = await withRelayGate(f.directory, () => assert.fail());
    assert.equal(competing.status, 'pending');
    await recoverRetirementGuard(f.directory, f.inspect);
    await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  });
});

test('ordinary, malformed and permissive retained guards are preserved', async t => {
  const f = await fixture(t);
  for (const bytes of ['', 'rollout', retirementLockMarker.slice(0, -2)]) {
    await writeFile(f.lock, bytes, { mode: 0o600 });
    await assert.rejects(recoverRetirementGuard(f.directory, f.inspect),
      { code: 'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED' });
    assert.equal(await readFile(f.lock, 'utf8'), bytes);
  }
  await writeFile(f.lock, retirementLockMarker);
  await chmod(f.lock, 0o644);
  await assert.rejects(recoverRetirementGuard(f.directory, f.inspect),
    { code: 'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED' });
});

test('administrator entry refuses non-installed source before host access', async () => {
  await assert.rejects(retireSharedHost(), { code: 'RETIREMENT_REQUIRES_LOCAL_ADMIN' });
  await assert.rejects(installLockedSharedTemplate(),
    { code: 'SHARED_SERVICE_REQUIRES_INSTALLED_CORE' });
});
