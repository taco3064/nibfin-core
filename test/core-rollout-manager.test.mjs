import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { administratorTarget } from '../src/core-rollout-manager.mjs';
import { admitRolloutManager, requireManagerContext }
  from '../src/rollout-manager-context.mjs';
import { inspectManagerHost } from '../src/shared-host-inspect.mjs';
import { managerCredentialHost, managedCredentialHost }
  from '../src/managed-credential-host.mjs';
import { assertNoCredentialConsumers, assertNoOtherCredentialConsumers,
  consumeManagedCredentials, manageCredentials } from '../src/managed-credentials.mjs';
import { requirePromotionSettlement } from '../src/rollout-pool.mjs';
import { settlePoolWork, observeRetirementRegistrations }
  from '../src/retirement-observe.mjs';

test('readonly native identity may observe busy; transaction default remains idle',
  async () => {
    const pool = { repository: 'owner/pool', repositoryId: 1, memberId: 5,
      runners: [{ id: 42, name: 'slot-1' }] };
    const native = { id: 42, name: 'slot-1', os: 'Linux', busy: true,
      status: 'online', labels: [{ name: 'nibfin-shared' },
        { name: 'nibfin-user-5' }] };
    const reader = { get: async () => ({ id: 1, full_name: pool.repository }),
      list: async () => [native] };
    await assert.rejects(observeRetirementRegistrations(reader, pool,
      { allowOnline: true }), { code: 'RETIREMENT_NATIVE_BUSY' });
    assert.deepEqual(await observeRetirementRegistrations(reader, pool,
      { allowOnline: true, allowBusy: true }), ['present']);
    native.id = 99;
    await assert.rejects(observeRetirementRegistrations(reader, pool,
      { allowOnline: true, allowBusy: true }),
    { code: 'RETIREMENT_NATIVE_IDENTITY_CHANGED' });
  });

test('administrator input names exactly one native run and artifact', () => {
  assert.deepEqual(administratorTarget('123', '456'), { runId: 123, artifactId: 456 });
  for (const values of [['0', '1'], ['1', '../script'], ['1', '1;reboot'],
    ['1', '--service'], ['1', '9007199254740992'], ['a'.repeat(40), '1']])
    assert.throws(() => administratorTarget(...values),
      { code: 'INVALID_CORE_ROLLOUT_TARGET' });
});

test('request flags and environment cannot create manager authority', async () => {
  const fakeContexts = [{}, { admitted: true }, { codeRoot: '/opt/nibfin/core' }];
  for (const fake of fakeContexts) {
    assert.throws(() => requireManagerContext(fake),
      { code: 'ROLLOUT_MANAGER_NOT_ADMITTED' });
    await assert.rejects(inspectManagerHost(fake),
      { code: 'ROLLOUT_MANAGER_NOT_ADMITTED' });
    await assert.rejects(managerCredentialHost(fake),
      { code: 'ROLLOUT_MANAGER_NOT_ADMITTED' });
  }
  process.env.NIBFIN_CORE_ROOT = '/opt/nibfin/core';
  try {
    await assert.rejects(admitRolloutManager(),
      { code: 'ROLLOUT_MANAGER_REQUIRES_INSTALLED_ADMIN' });
    await assert.rejects(managedCredentialHost(true),
      { code: 'MANAGED_CREDENTIAL_REQUIRES_LOCAL_ADMIN' });
  } finally { delete process.env.NIBFIN_CORE_ROOT; }
});

const linux = {
  skip: process.platform !== 'linux' ? 'Linux private inode policy' : false,
};

async function credentialFixture(t) {
  const base = resolve('.deliver-test-tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'rollout-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['state', 'credentials', 'codex'])
    await mkdir(join(root, name), { mode: 0o700 });
  const host = { uid: process.getuid(), gid: process.getgid(), memberId: 77,
    stateRoot: join(root, 'state'), tokenFile: join(root, 'credentials/token'),
    authFile: join(root, 'codex/auth.json') };
  await manageCredentials(host, 'intake', { token: 'fake-test-token', auth: '{}' },
    { verify: async () => {}, settle: async () => {} });
  return host;
}

test('only exact active own lease may be excluded; others and expiry still block',
  linux, async t => {
    const host = await credentialFixture(t);
    let expired;
    await consumeManagedCredentials(host, async scope => {
      expired = scope;
      await assert.rejects(assertNoCredentialConsumers(host),
        { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      await assertNoOtherCredentialConsumers(host, scope);
      await assert.rejects(assertNoOtherCredentialConsumers({ ...host,
        memberId: 78 }, scope), { code: 'MANAGED_CREDENTIAL_CONSUMER_SCOPE_INVALID' });
      await consumeManagedCredentials(host, async () => {
        await assert.rejects(assertNoOtherCredentialConsumers(host, scope),
          { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      }, { verify: async () => {} });
      await assertNoOtherCredentialConsumers(host, scope);
    }, { verify: async () => {} });
    await assertNoCredentialConsumers(host);
    await assert.rejects(assertNoOtherCredentialConsumers(host, expired),
      { code: 'MANAGED_CREDENTIAL_CONSUMER_SCOPE_INVALID' });
    await assert.rejects(assertNoOtherCredentialConsumers(host, {}),
      { code: 'MANAGED_CREDENTIAL_CONSUMER_SCOPE_INVALID' });
  });

test('replaced own lease inode is rejected', linux, async t => {
  const host = await credentialFixture(t);
  await consumeManagedCredentials(host, async scope => {
    const directory = dirname(host.tokenFile);
    const name = (await readdir(directory)).find(value => value.startsWith('consumer-'));
    const path = join(directory, name);
    const replaced = join(directory, 'replaced-test-lease');
    await rename(path, replaced);
    await writeFile(path, '{}', { mode: 0o600 });
    await assert.rejects(assertNoOtherCredentialConsumers(host, scope),
      { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
    await rm(path);
    await rename(replaced, path);
  }, { verify: async () => {} });
  await assertNoCredentialConsumers(host);
});

test('real managed admission reaches promotion settlement with only its own lease',
  linux, async t => {
    const host = await credentialFixture(t);
    host.runnerUid = host.uid;
    host.repository = { isolation: {} };
    host.sharedRunner = { additionalRunner: { uid: host.uid + 1 } };
    const plan = { binding: { adoptions: [
      { path: '/etc/nibfin/host.json', bytes: JSON.stringify(host) },
    ], repositories: [], pool: {} } };
    const observations = [];
    const ports = {
      closure: async () => observations.push('closure'),
      reader: () => ({}),
      settle: (current, reader, binding, options) =>
        settlePoolWork(current, reader, binding, undefined, options, {
          containers: async () => observations.push('containers'),
          jobs: async () => observations.push('jobs'),
          registrations: async () => observations.push('registrations'),
        }),
      unit: async slot => observations.push(`inactive-${slot}`),
      cgroups: async () => observations.push('cgroups'),
    };
    await consumeManagedCredentials(host, async scope => {
      await assert.rejects(requirePromotionSettlement(plan, undefined, ports),
        { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      await requirePromotionSettlement(plan, scope, ports);
      assert.ok(observations.includes('inactive-2'));
      await consumeManagedCredentials(host, async () => {
        await assert.rejects(requirePromotionSettlement(plan, scope, ports),
          { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
      }, { verify: async () => {} });
    }, { verify: async () => {} });
    await assertNoCredentialConsumers(host);
  });
