import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { completeLifecycleLocally } from '../src/installed-lifecycle.mjs';

// Process tests use project-PATH Python and suppress bytecode output explicitly.
test('bridge and legacy retirement is independent of publication', () => {
  const result = spawnSync('python3', ['-B', 'test/core-package-retirement-bridge.py'], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
      TMPDIR: process.cwd() + '/.deliver-test-tmp' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('cleanup also runs after paused or denied continuation', async () => {
  for (const status of ['paused', 'pending', 'dispatched']) {
    const events = [];
    const cleanup = [{ status: 'retained', code: 'PACKAGE_OBSERVATION_UNAVAILABLE' }];
    const result = await completeLifecycleLocally({
      retire: async () => { events.push('retire'); return cleanup; },
      continue: async () => { events.push('continue'); return { status, results: [] }; },
    });
    assert.deepEqual(events, ['continue', 'retire']);
    assert.equal(result.status, status);
    assert.deepEqual(result.cleanup, cleanup);
  }
  for (const code of ['MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE',
    'HOST_ADOPTION_CHANGED', 'POOL_ADMISSION_DENIED']) {
    let retired = false;
    const action = completeLifecycleLocally({
      retire: async () => { retired = true; return []; },
      continue: async () => { throw Object.assign(new Error(code), { code }); },
    });
    if (code === 'POOL_ADMISSION_DENIED') await assert.rejects(action, { code });
    else assert.equal((await action).status, 'pending');
    assert.equal(retired, true);
  }
});
