import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GitHubReader } from '../src/github-read.mjs';
import { githubApiWaiting, safeGitHubReadCause } from '../src/github-read-cause.mjs';
import { verifyManagedAuthority } from '../src/managed-credential-authority.mjs';
import { refreshRunnerRuntime, continueRunnerRefresh, runnerRefreshObservation }
  from '../src/runner-refresh.mjs';
import { discoverRunnerRefresh } from '../src/runner-refresh-discovery.mjs';
import { resumeRolloutWork, pendingInstalledContinuation }
  from '../src/rollout-resume.mjs';
import { resumeLifecycle } from '../src/continuation-state.mjs';
import { fixture, selected, artifact, failure } from './runner-refresh-fixture.mjs';
import { providerHost } from './provider-fixture.mjs';

const privateText = 'private-fixture-token-and-url';
const host = { memberId: 7, credentialRepositories: [
  { repository: 'example/repository', repositoryId: 1 }] };
const actor = { id: 7, login: 'owner', type: 'User' };

function observer(kind, failPath = '/user') {
  let fail = true;
  return new GitHubReader(privateText, async url => {
    const path = new URL(url).pathname;
    if (fail && path === failPath) {
      fail = false;
      if (kind === 'network') throw new TypeError(privateText);
      if (kind === 'invalid-response') return new Response(privateText, { status: 200 });
      return new Response(JSON.stringify({ message: privateText }), { status: kind });
    }
    let value = actor;
    if (path.endsWith('/actions/runners/downloads')) value = [{ os: 'linux',
      architecture: 'x64', filename: artifact.name, download_url: artifact.url }];
    else if (path.includes('/releases/tags/')) value = { ...selected.release,
      draft: false, assets: [{ name: artifact.name, browser_download_url: artifact.url,
        digest: `sha256:${artifact.sha256}` }] };
    else if (path.endsWith('/permission')) value = { user: actor, permission: 'admin' };
    else if (path.endsWith('/issues')) value = [];
    else if (path !== '/user') value = { id: 1, full_name: 'example/repository',
      archived: false, disabled: false };
    return Response.json(value);
  });
}

function assertApi(result, kind) {
  assert.equal(result.status, 'pending');
  assert.equal(result.code, githubApiWaiting);
  assert.deepEqual(result.githubApi, typeof kind === 'number'
    ? { kind: 'http', httpStatus: kind } : { kind });
  assert(!JSON.stringify(result).includes(privateText));
  assert.equal(result.retryAfterMs, undefined, 'no new delay policy is introduced');
}

for (const kind of [422, 'network', 'invalid-response']) {
  test(`initial native discovery keeps safe API cause: ${kind}`, async () => {
    const f = fixture(), reader = observer(kind,
      '/repos/example/repository/actions/runners/downloads');
    f.ports.discover = () => discoverRunnerRefresh(reader, 'example/repository', 'amd64');
    const run = () => runnerRefreshObservation(() =>
      refreshRunnerRuntime('apply', f.ports));
    const pending = await run();
    assertApi(pending, kind);
    assert.equal(pending.phase, undefined,
      'no nonexistent operation state is fabricated');
    assert.deepEqual(f.calls, []);
    assert.equal((await run()).status, 'refreshed');
  });

  test(`credential admission sanitizer preserves safe API cause: ${kind}`, async () => {
    const f = fixture(), reader = observer(kind);
    const run = () => runnerRefreshObservation(async () => {
      await verifyManagedAuthority(host, privateText, reader);
      return refreshRunnerRuntime('apply', f.ports);
    });
    assertApi(await run(), kind);
    assert.deepEqual(f.calls, []);
    assert.equal((await run()).status, 'refreshed');
  });

  test(`stateful verification resumes without repeating installed effects: ${kind}`,
    async () => {
      const f = fixture(), reader = observer(kind), install = f.ports.install;
      f.ports.install = async slot => {
        if (!f.installed.has(slot)) await install(slot);
      };
      f.ports.verify = () => reader.get('/user');
      const run = () => runnerRefreshObservation(() =>
        refreshRunnerRuntime('resume', f.ports));
      const pending = await run();
      assertApi(pending, kind);
      assert.equal(pending.phase, 'applying');
      assert.equal(f.state().pending, githubApiWaiting);
      assert.equal((await run()).status, 'refreshed');
      for (const effect of ['install1', 'install2'])
        assert.equal(f.calls.filter(call => call === effect).length, 1);
    });

  test(`continuation preserves API cause and does not reinstall: ${kind}`, async () => {
    const f = fixture(), reader = observer(kind);
    const lifecycleHost = providerHost();
    lifecycleHost.memberId = 7;
    const complete = () => pendingInstalledContinuation({
      load: async () => {
        await reader.get('/user');
        return { host: lifecycleHost, reader, inspect: async () => {},
          configuration: { memberId: 7, origins: [] } };
      },
      requireAdmission: async () => {}, read: async () => null,
      createState: () => ({ use: async action => action(), read: async () => null,
        write: async () => {} }),
      fetcher: async () => assert.fail('empty discovery cannot dispatch'),
    });
    const run = () => continueRunnerRefresh(() => refreshRunnerRuntime('resume', f.ports),
      complete);
    const result = await run();
    assert.equal(result.status, 'refreshed');
    assertApi(result.continuation, kind);
    assert.equal((await run()).continuation.status, 'dispatched');
    for (const effect of ['install1', 'install2'])
      assert.equal(f.calls.filter(call => call === effect).length, 1);
  });
}

test('secondary pending-state write failure cannot replace the original API cause',
  async () => {
    const f = fixture(), reader = observer(422), write = f.ports.write;
    f.ports.verify = () => reader.get('/user');
    f.ports.write = async value => {
      if (value.pending === githubApiWaiting) throw failure('EIO');
      return write(value);
    };
    const pending = await runnerRefreshObservation(() =>
      refreshRunnerRuntime('apply', f.ports));
    assertApi(pending, 422);
    assert.deepEqual(pending.pendingState, { code: 'EIO' });
    assert.equal(pending.phase, 'applying');
  });

test('identity, authorization and unmarked write errors remain distinct', async () => {
  const fake = Object.assign(Error('GitHub 422 ' + privateText),
    { code: githubApiWaiting, status: 422 });
  assert.equal(safeGitHubReadCause(fake), null);
  await assert.rejects(runnerRefreshObservation(async () => { throw fake; }),
    error => error === fake);
  for (const code of ['UNTRUSTED_ADOPTION_PATH', 'MANAGED_CREDENTIAL_MEMBER_MISMATCH'])
    await assert.rejects(runnerRefreshObservation(async () => { throw failure(code); }),
      { code });
  await assert.rejects(runnerRefreshObservation(() => verifyManagedAuthority(host,
    privateText, observer(401))), { code: 'MANAGED_CREDENTIAL_UNAUTHORIZED' });
  const result = await continueRunnerRefresh(async () => ({ status: 'refreshed',
    continuationRequired: true }), async () => {
    throw Object.assign(failure('ROLLOUT_CONTINUATION_DISPATCH_UNKNOWN'),
      { status: 422 });
  });
  assert.equal(result.continuation.code, 'ROLLOUT_CONTINUATION_DISPATCH_UNKNOWN');
  assert.equal(result.continuation.githubApi, undefined);
});

test('continuation issue-list API errors retain their safe cause', async () => {
  const reader = observer(422, '/repos/example/repository/issues');
  const context = { reader, configuration: { memberId: 7,
    origins: [{ repository: 'example/repository', repositoryId: 1 }] },
  journal: { control: async () => ({ paused: false }) }, inspect: async () => {},
  dispatch: async () => assert.fail('no write follows the failed read') };
  const pending = await resumeRolloutWork(context);
  assert.equal(pending.status, 'pending');
  assertApi(pending.results[0], 422);
  assert.equal(pending.results[0].stage, 'list-issues');
  assert.equal((await resumeRolloutWork(context)).status, 'dispatched');
});

test('continuation pending-save failure preserves the original read cause', async () => {
  const reader = observer(422);
  let writes = 0;
  const pending = await pendingInstalledContinuation({ load: async () => {
    await resumeLifecycle({ lifecycle: {}, inspect: async () => {},
      state: { use: async action => action(), read: async () => null,
        write: async () => { if (++writes > 1) throw failure('EIO'); } },
      resume: () => reader.get('/user') });
  } });
  assertApi(pending, 422);
});

test('public result composition prints safe pending JSON with exit two', async () => {
  const source = await readFile('bin/nibfin-core.mjs', 'utf8');
  assert(source.includes('.then(writeCommandResult)'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { GitHubReader } from './src/github-read.mjs';
    import { runnerRefreshObservation } from './src/runner-refresh.mjs';
    import { writeCommandResult } from './src/command-result.mjs';
    const reader = new GitHubReader('private-fixture-token', async () =>
      new Response('private-response-body', { status: 422 }));
    writeCommandResult(await runnerRefreshObservation(() => reader.get('/user')));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assertApi(JSON.parse(result.stdout), 422);
  assert(!result.stdout.includes('private-'));
});
