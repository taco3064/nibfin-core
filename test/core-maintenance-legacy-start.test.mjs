import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyStartFixture } from './core-maintenance-legacy-start-fixture.mjs';

test('historical guard refuses new dispatcher before external source promotion',
  async () => {
    const f = legacyStartFixture();
    const original = structuredClone({ registration: f.state.registration,
      runtime: f.state.target });
    await f.ready();
    f.bootstrap();
    await assert.rejects(f.ready(),
      { code: 'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED' });
    const result = await f.promote();
    assert.equal(result.status, 'installed');
    assert.equal(f.state.saved.apply.completed, true);
    await f.ready();
    assert.deepEqual({ registration: f.state.registration,
      runtime: f.state.target }, original);
    assert.deepEqual(f.state.moves, [['live', 'backup'], ['staged', 'live']]);
    assert.deepEqual(f.state.writes, ['host']);
  });

test('interrupted stopped-pool apply resumes without replaying a completed move',
  async () => {
    const f = legacyStartFixture();
    f.bootstrap();
    await assert.rejects(f.promote(true), /interrupted after move/);
    assert.equal(f.state.packages.live, 'absent');
    await f.promote();
    await f.ready();
    assert.deepEqual(f.state.moves, [['live', 'backup'], ['staged', 'live']]);
    assert.deepEqual(f.state.writes, ['host']);
    assert.equal(f.state.saved.apply.completed, true);
  });

test('new guard retains credential, root trust and official program refusals',
  async () => {
    for (const [key, value, code] of [
      ['credentialMode', 0o666, 'SHARED_RUNNER_CREDENTIAL_PERMISSIONS'],
      ['untrusted', true, 'UNTRUSTED_HOST_PATH'],
      ['programChanged', true, 'SHARED_ARTIFACT_DIGEST_MISMATCH'],
    ]) {
      const f = legacyStartFixture();
      f.bootstrap();
      await f.promote();
      f.state[key] = value;
      await assert.rejects(f.ready(), { code });
    }
    const f = legacyStartFixture();
    f.bootstrap();
    f.state.packages.staged = 'unknown';
    await assert.rejects(f.promote(), { code: 'ROLLOUT_PACKAGE_STATE_UNKNOWN' });
    assert.deepEqual(f.state.moves, []);
    assert.deepEqual(f.state.writes, []);
  });
