import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { callerRecipeVariants } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';
import { lifecycleRoute, observeNativeConfiguration, verifyLifecycleActivation }
  from '../src/lifecycle-route.mjs';
import { settleLifecycleNotifications, notificationAffectsPool }
  from '../src/lifecycle-settlement.mjs';
import { consumerContract } from '../src/public-api.mjs';

const commit = 'a'.repeat(40);
const destination = { repository: 'owner/pool', repositoryId: 10, ref: 'main' };
function configuration() {
  const variables = [{ name: 'NIBFIN_SHARED_RUNNER_POOL', value: 'true' },
    { name: 'NIBFIN_SHARED_RUNNER_DESTINATION', value: JSON.stringify(destination) }];
  const secrets = [{ name: 'NIBFIN_WAKE_TOKEN' }];
  return { variables, secrets, reader: { list: async (path, key) => {
    assert.ok(path.startsWith('/repos/owner/source/actions/'));
    return key === 'variables' ? variables : secrets;
  } } };
}

test('current and historical callers select routes independently of files', () => {
  for (const [kind, expected] of [['issue', 'native'], ['issue-managed', 'artifact']]) {
    for (const recipe of callerRecipeVariants(kind, commit)) {
      for (const text of [recipe, recipe.replaceAll('\n', '\r\n')]) {
        assert.equal(lifecycleRoute({ workflowBlob: gitBlob(text) }, commit), expected);
      }
    }
  }
  assert.throws(() => lifecycleRoute({ workflowBlob: 'b'.repeat(40) }, commit),
    { code: 'LIFECYCLE_ROUTE_UNKNOWN' });
});

test('native readiness observes routing and credential metadata', async () => {
  const f = configuration();
  const observe = () => observeNativeConfiguration(f.reader, 'owner/source', destination);
  await observe();
  f.variables[0].value = 'false';
  await assert.rejects(observe(), { code: 'LIFECYCLE_NATIVE_CONFIGURATION_UNKNOWN' });
  f.variables[0].value = 'true';
  f.variables[1].value = JSON.stringify({ ...destination, repositoryId: 99 });
  await assert.rejects(observe(), { code: 'LIFECYCLE_DESTINATION_CONFLICT' });
  f.variables[1].value = 'malformed';
  await assert.rejects(observe(), { code: 'LIFECYCLE_DESTINATION_CONFLICT' });
  f.variables.pop();
  await assert.rejects(observe(), { code: 'LIFECYCLE_DESTINATION_CONFLICT' });
  await observeNativeConfiguration(f.reader, 'owner/source', {
    repository: 'taco3064/nibfin-core', repositoryId: 1, ref: 'main',
  });
  f.secrets.length = 0;
  await assert.rejects(observe(), { code: 'LIFECYCLE_NATIVE_CONFIGURATION_UNKNOWN' });
});

test('native activation never invokes relay inspection; mixed routes retain readiness',
  async () => {
    const missing = async () => { throw new Error('obsolete relay unavailable'); };
    await verifyLifecycleActivation([{ route: 'native' }], missing);
    await assert.rejects(verifyLifecycleActivation([
      { route: 'native' }, { route: 'artifact' },
    ], missing), /obsolete relay unavailable/);
    await assert.rejects(verifyLifecycleActivation([{ route: 'artifact' }], async () => ({
      github: { status: 'unverified' }, recovery: {}, resources: [], service: {},
    })), { code: 'RETIREMENT_RELAY_UNVERIFIED' });
  });

test('native settlement allows absent control and unrelated effects', async () => {
  const binding = { pool: { repositoryId: 10 }, repositories: [{ repositoryId: 1 }] };
  const record = { status: 'pending', origin: { repositoryId: 2 },
    intent: { destination: { repositoryId: 20 } } };
  assert.equal(notificationAffectsPool(record, binding), false);
  const ports = { exists: async () => false,
    journal: { records: assert.fail, requireSettled: assert.fail } };
  await settleLifecycleNotifications(binding, false, ports);
  ports.exists = async () => true;
  ports.gate = action => action();
  ports.journal.requireReplacementEffectsSettled = async () => {};
  ports.journal.records = async () => [record];
  await settleLifecycleNotifications(binding, false, ports);
  record.intent.destination.repositoryId = 10;
  await assert.rejects(settleLifecycleNotifications(binding, false, ports),
    { code: 'RETIREMENT_RELAY_EFFECT_PENDING' });
  record.status = 'consumed';
  await settleLifecycleNotifications(binding, false, ports);
  let artifactChecked = false;
  ports.journal.requireSettled = async affects => {
    assert.equal(affects({ ...record, status: 'pending' }), true);
    assert.equal(affects({ status: 'pending', origin: { repositoryId: 99 },
      intent: { destination: { repositoryId: 99 } } }), false);
    artifactChecked = true;
  };
  await settleLifecycleNotifications(binding, true, ports);
  assert.equal(artifactChecked, true);
});

test('public cleanup and native refresh refuse arguments and uninstalled success', () => {
  assert.equal(consumerContract.managedNotificationLifecycle.cleanupCommand,
    'cleanup-notifications');
  for (const args of [
    ['cleanup-notifications', '/caller/path'], ['cleanup-notifications'],
    ['refresh-native-issue-caller', 'owner/source', '1'],
  ]) {
    const child = spawnSync(process.execPath, ['bin/nibfin-core.mjs', ...args],
      { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stderr);
    assert.equal(result.status, 'denied');
    assert.ok(['INVALID_COMMAND', 'NOTIFICATION_REQUIRES_INSTALLED_ADMINISTRATOR',
      'PEER_INSTALLATION_REQUIRES_HOST_ADMIN'].includes(result.code), result.code);
  }
});

test('cleanup reconciles exact returned IDs and preserves lost dispatch evidence',
  async () => {
    const { reconcileLifecycleNotifications } =
      await import('../src/lifecycle-settlement.mjs');
    const destination = { repository: 'owner/pool',
      repositoryId: 10, id: 7, path: '.github/workflows/shared-runner.yml',
      commit, ref: 'main' };
    const actor = { id: 5, login: 'owner' };
    const intent = { destination, actor, issue: { repositoryId: 1, number: 2 },
      createdAt: '2026-11-19T00:00:00Z' };
    const known = { status: 'pending', intent, runId: 99 };
    const lost = { status: 'pending', intent };
    const records = [known, lost];
    let writes = 0, available = false;
    const reader = { get: async path => {
      assert.equal(path, '/repos/owner/pool/actions/runs/99');
      if (!available) throw new Error('unavailable readback');
      return { id: 99, event: 'workflow_dispatch', run_attempt: 1,
        repository: { id: 10, full_name: 'owner/pool' }, head_repository: { id: 10 },
        actor, triggering_actor: actor, workflow_id: 7, path: destination.path,
        head_sha: commit, head_branch: 'main', display_title: 'Nibfin 1 #2 wake',
        created_at: '2026-11-19T00:00:01Z' };
    } };
    const journal = { records: async () => records, write: async record => {
      writes++; Object.assign(known, record);
    } };
    await reconcileLifecycleNotifications(journal, reader);
    assert.equal(writes, 0);
    available = true;
    await reconcileLifecycleNotifications(journal, reader);
    await reconcileLifecycleNotifications(journal, reader);
    assert.equal(writes, 1);
    assert.equal(known.status, 'consumed');
    assert.equal(lost.status, 'pending');
  });
