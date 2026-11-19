import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRunnerRuntime, continueRunnerRefresh } from '../src/runner-refresh.mjs';
import { requireExternalRunnerRefresh } from '../src/runner-refresh-host.mjs';
import { discoverRunnerRefresh } from '../src/runner-refresh-discovery.mjs';
import { observeRetirementRegistrations } from '../src/retirement-observe.mjs';
import { spawnSync } from 'node:child_process';
import { artifact, selected, failure, fixture } from './runner-refresh-fixture.mjs';

test('preview and self invocation refuse mutation', async () => {
  const f = fixture();
  assert.equal((await refreshRunnerRuntime('preview', f.ports)).status, 'preview');
  assert.deepEqual(f.calls, []);
  f.ports.external = async () => {
    throw failure('RUNNER_REFRESH_EXTERNAL_ADMIN_REQUIRED');
  };
  await assert.rejects(refreshRunnerRuntime('apply', f.ports),
    { code: 'RUNNER_REFRESH_EXTERNAL_ADMIN_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('actual cgroup membership rejects a Job, child hook and forged environment', () => {
  const units = [1, 2].map(slot => ({ Id: `nibfin-shared-runner@${slot}.service`,
    ControlGroup: `/system.slice/nibfin-shared-runner@${slot}.service` }));
  for (const suffix of ['', '/child']) assert.throws(() => requireExternalRunnerRefresh(
    '0::/system.slice/nibfin-shared-runner@1.service' + suffix, units),
  { code: 'RUNNER_REFRESH_EXTERNAL_ADMIN_REQUIRED' });
  assert.throws(() => requireExternalRunnerRefresh('0::/user.slice/admin', units, true));
  assert.throws(() => requireExternalRunnerRefresh('unreadable', units));
  requireExternalRunnerRefresh('0::/user.slice/admin', units);
});

test('refresh restores only the originally running service and separates continuation',
  async () => {
    const f = fixture();
    const result = await continueRunnerRefresh(
      () => refreshRunnerRuntime('apply', f.ports),
      async () => ({ status: 'paused', results: [] }));
    assert.equal(result.status, 'refreshed');
    assert.equal(result.continuation.status, 'paused');
    assert.deepEqual(f.running, [true, false]);
    assert(!f.calls.includes('start2'));
    assert(f.calls.indexOf('close') < f.calls.indexOf('stop1'));
    assert(f.calls.indexOf('release') > f.calls.indexOf('install2'));
    assert(f.calls.indexOf('start1') > f.calls.indexOf('release'));
  });

test('lost stop/start responses reuse native readback', async () => {
  const f = fixture();
  const stop = f.ports.stop, start = f.ports.start;
  f.ports.stop = async slot => { await stop(slot); throw failure('RESPONSE_LOST'); };
  f.ports.start = async slot => { await start(slot); throw failure('RESPONSE_LOST'); };
  assert.equal((await refreshRunnerRuntime('apply', f.ports)).status, 'refreshed');
  assert.equal(f.calls.filter(call => call === 'stop1').length, 1);
  assert.equal(f.calls.filter(call => call === 'start1').length, 1);
});

test('partial apply resumes and reuses confirmed installation', async () => {
  const f = fixture(), install = f.ports.install;
  let lose = true;
  f.ports.install = async slot => {
    if (!f.installed.has(slot)) await install(slot);
    if (slot === 1 && lose) { lose = false; throw failure('RESPONSE_LOST'); }
  };
  const interrupted = await refreshRunnerRuntime('apply', f.ports);
  assert.equal(interrupted.status, 'pending');
  assert.equal(interrupted.phase, 'applying');
  assert.equal((await refreshRunnerRuntime('resume', f.ports)).status, 'refreshed');
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  assert.equal(f.calls.filter(call => call === 'install1').length, 1);
  assert.equal(f.calls.filter(call => call === 'install2').length, 1);
});

test('continuation loss and absent local receipt reuse confirmed bytes', async () => {
  const f = fixture();
  const run = () => continueRunnerRefresh(() => refreshRunnerRuntime('resume', f.ports),
    async () => { throw failure('OBSERVATION_UNAVAILABLE'); });
  assert.equal((await run()).continuation.status, 'pending');
  assert.equal((await run()).continuation.status, 'pending');
  f.forget();
  const current = await run();
  assert.equal(current.status, 'current');
  assert.equal(current.continuation.status, 'pending');
  for (const effect of ['prepare', 'install1', 'install2'])
    assert.equal(f.calls.filter(call => call === effect).length, 1);
});

test('failed observation and admitted work block before closure', async () => {
  const f = fixture();
  f.ports.current = async () => { throw failure('PROVIDER_READ_FAILED'); };
  await assert.rejects(refreshRunnerRuntime('apply', f.ports),
    { code: 'PROVIDER_READ_FAILED' });
  assert.deepEqual(f.calls, []);
  f.ports.current = async () => false;
  f.ports.settle = async () => { throw failure('RETIREMENT_JOB_PENDING'); };
  await assert.rejects(refreshRunnerRuntime('apply', f.ports),
    { code: 'RETIREMENT_JOB_PENDING' });
  assert.deepEqual(f.calls, []);
});

test('cleanup uncertainty retains evidence without repeating completed software work',
  async () => {
    const f = fixture();
    f.ports.cleanup = async () => { throw failure('RUNNER_REFRESH_PREVIOUS_IN_USE'); };
    const result = await continueRunnerRefresh(
      () => refreshRunnerRuntime('apply', f.ports),
      async () => ({ status: 'dispatched', results: [] }));
    assert.equal(result.status, 'refreshed');
    assert.equal(result.cleanup.status, 'pending');
    assert.equal(result.continuation.status, 'dispatched');
    f.ports.cleanup = async () => { f.calls.push('cleanup'); };
    assert.equal((await refreshRunnerRuntime('resume', f.ports)).cleanup.status,
      'removed');
    assert.equal(f.calls.filter(call => call === 'install1').length, 1);
  });

test('repository downloads must agree with authenticated official release metadata',
  async () => {
    const offered = { os: 'linux', architecture: 'x64', filename: artifact.name,
      download_url: artifact.url };
    const release = { tag_name: 'v9.99.0', draft: false, assets: [{
      name: artifact.name, browser_download_url: artifact.url,
      digest: `sha256:${artifact.sha256}` }] };
    const reader = {
      get: async path => path.endsWith('/downloads') ? [offered] : release,
    };
    assert.deepEqual((await discoverRunnerRefresh(reader, 'example/repository', 'amd64'))
      .artifact, artifact);
    offered.download_url = 'https://example.com/untrusted';
    await assert.rejects(discoverRunnerRefresh(reader, 'example/repository', 'amd64'),
      { code: 'RUNNER_REFRESH_OFFICIAL_PACKAGE_MISMATCH' });
    offered.download_url = artifact.url;
    release.assets[0].digest = null;
    await assert.rejects(discoverRunnerRefresh(reader, 'example/repository', 'amd64'));
  });

test('post-install registration checks allow new native work without weakening drain',
  async () => {
    const pool = { repository: 'example/repository', repositoryId: 1, memberId: 2,
      runners: [{ id: 3, name: 'slot-1' }, { id: 4, name: 'slot-2' }] };
    const native = pool.runners.map(runner => ({ ...runner, os: 'Linux', busy: true,
      status: 'online', labels: [{ name: 'nibfin-shared' },
        { name: 'nibfin-user-2' }] }));
    const reader = { get: async () => ({ id: 1, full_name: pool.repository }),
      list: async () => native };
    await assert.rejects(observeRetirementRegistrations(reader, pool,
      { allowOnline: true }), { code: 'RETIREMENT_NATIVE_BUSY' });
    assert.deepEqual(await observeRetirementRegistrations(reader, pool,
      { allowOnline: true, allowBusy: true }), ['present', 'present']);
    native[0].name = 'different';
    await assert.rejects(observeRetirementRegistrations(reader, pool,
      { allowOnline: true, allowBusy: true }),
    { code: 'RETIREMENT_NATIVE_IDENTITY_CHANGED' });
  });

test('public command refuses arbitrary paths, modes and uninstalled execution', () => {
  for (const [args, code] of [
    [['preview', '/arbitrary'], 'INVALID_COMMAND'],
    [['unsupported'], 'INVALID_RUNNER_REFRESH'],
    [['preview'], 'RUNNER_REFRESH_REQUIRES_INSTALLED_ADMIN'],
  ]) {
    const result = spawnSync(process.execPath, ['bin/nibfin-core.mjs',
      'refresh-runner-runtime', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, code);
  }
});

test('lost state with owned closure recovers original running state and releases it',
  async () => {
    const f = fixture(), install = f.ports.install;
    f.ports.install = async () => { throw failure('RESPONSE_LOST'); };
    assert.equal((await refreshRunnerRuntime('apply', f.ports)).phase, 'applying');
    f.forget();
    f.ports.install = install;
    assert.equal((await refreshRunnerRuntime('resume', f.ports)).status, 'refreshed');
    assert.deepEqual(f.running, [true, false]);
    assert.equal(f.calls.filter(call => call === 'start1').length, 1);
  });

test('without state or closure current service state is preserved for a fresh update',
  async () => {
    const f = fixture();
    f.running[0] = false;
    f.installed.add(1);
    const install = f.ports.install;
    f.ports.install = async slot => {
      if (!f.installed.has(slot)) await install(slot);
    };
    assert.equal((await refreshRunnerRuntime('resume', f.ports)).status, 'refreshed');
    assert.deepEqual(f.running, [false, false]);
    assert(!f.calls.includes('install1'));
    assert(!f.calls.includes('start1'));
  });

test('retained old prior does not gate the next same or different selected asset',
  async () => {
    for (const changedAsset of [false, true]) {
      const f = fixture();
      f.ports.cleanup = async () => { throw failure('RUNNER_REFRESH_RESOURCE_CHANGED'); };
      assert.equal((await refreshRunnerRuntime('apply', f.ports)).status, 'refreshed');
      const first = f.state().workspace.path;
      f.ports.current = async () => false;
      if (changedAsset) f.ports.discover = async () => ({ ...selected,
        artifact: { ...artifact, sha256: 'b'.repeat(64) } });
      assert.equal((await refreshRunnerRuntime('apply', f.ports)).status, 'refreshed');
      assert.notEqual(f.state().workspace.path, first);
      assert.equal(f.calls.filter(call => call === 'install1').length, 2);
    }
  });
