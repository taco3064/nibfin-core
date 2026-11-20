import { mock } from 'node:test';
import assert from 'node:assert/strict';

async function replace(path, overrides) {
  const actual = await import(path);
  mock.module(path, { namedExports: { ...actual, ...overrides } });
}

const events = [];
const pin = { commit: 'a'.repeat(40), repository: 'taco3064/nibfin-core' };
const runners = [{ id: 1, name: 'one' }, { id: 2, name: 'two' }];
const host = { tokenFile: '/controlled/token', repository: {
  approval: { repositoryId: 10 },
} };
let plan = { schemaVersion: 2, pin, actionCommit: 'b'.repeat(40), phase: 'verifying',
  binding: { slots: [{}, {}], repositories: [{ repositoryId: 10 }],
    pool: { repository: 'example/core', runners } },
  apply: { completed: true, targets: [] } };
let permission = false, loseReply = true, closed = true;

mock.method(process, 'getuid', () => 0);
await replace('../src/host-paths.mjs', { rootOwnedPath: async () => {} });
await replace('../src/host-adoption.mjs', {
  boundedHostFile: async () => JSON.stringify(host), coreRoot: '/opt/nibfin/core',
});
await replace('../src/retirement-files.mjs', {
  readRetirementFile: async () => plan,
  writeRetirementFile: async (path, value) => {
    events.push('save:' + value.phase);
    plan = value;
  },
});
await replace('../src/rollout-admission.mjs', {
  requireRolloutClosure: async () => { assert.equal(closed, true); },
  removeRolloutClosure: async () => { closed = false; events.push('open'); },
});
await replace('../src/rollout-gates.mjs', {
  withRolloutGates: async (unused, action) => action(),
  rolloutHasRelay: async () => false,
});
await replace('../src/source-package.mjs', {
  verifyInstalledSource: async (path, value) => {
    assert.equal(path, '/opt/nibfin/core');
    assert.deepEqual(value, pin);
    events.push('source');
  },
});
const { prepareStorageReclamation } =
  await import('../src/storage-reclamation-install.mjs');
await replace('../src/storage-reclamation-install.mjs', {
  prepareStorageReclamation: () => prepareStorageReclamation(async () => {
    assert.equal(events.at(-1), 'source');
    permission = true;
    events.push('permission');
    if (loseReply) { loseReply = false; throw Error('publication response lost'); }
  }),
});
await replace('../src/shared-host-inspect.mjs', {
  inspectSharedHost: async () => ({ adoptedRepositoryIds: [10] }),
});
await replace('../src/managed-credential-files.mjs', { readPrivate: async () => '' });
await replace('../src/retirement-admission.mjs', {
  requireNoRetirement: async () => {}, requirePoolConsumersSettled: async () => {},
});
await replace('../src/managed-credentials.mjs', {
  assertNoCredentialConsumers: async () => {},
});
await replace('../src/managed-credential-settlement.mjs', {
  managedSettlement: async () => {},
});
await replace('../src/rollout-enrollments.mjs', {
  verifyRolloutEnrollments: async () => {},
});
await replace('../src/shared-runner.mjs', {
  sharedRunner: () => ({ runner: {} }), sharedDispatchWorkflow: async () => {},
});
await replace('../src/github-read.mjs', {
  GitHubReader: class {
    async list() { return runners.map(row => ({ ...row, status: 'online' })); }
  },
});
await replace('../src/retirement-observe.mjs', {
  observeRetirementRegistrations: async () => ['present', 'present'],
  observeRetirementUnit: async () => ({ ActiveState: 'active' }),
});
await replace('../src/shared-slot-identity.mjs', {
  verifySharedSlotIdentity: async () => {},
});
await replace('../src/retirement-services.mjs', {
  RetirementServices: class { async supervisors() {} },
});

const { advanceRolloutPool } = await import('../src/rollout-pool.mjs');
assert.deepEqual(await advanceRolloutPool('verify'), { status: 'verified' });
assert.equal(permission, true);
assert.equal(closed, true);
assert.equal(plan.phase, 'verifying');
assert.deepEqual(events, ['source', 'permission']);
assert.deepEqual(await advanceRolloutPool('release'), { status: 'complete' });
assert.equal(closed, false);
assert.equal(plan.phase, 'complete');
assert.deepEqual(events, ['source', 'permission', 'source', 'permission',
  'save:complete', 'open']);
console.log('Controlled rollout completion and retry passed');

// A predecessor promoter can finish without running any newly loaded module.
// The normal fixed lifecycle entry must reconcile from the installed package.
await replace('../src/managed-credential-admission.mjs', {
  withManagedAdmission: async action => action(),
});
await replace('../src/adopted-host.mjs', {
  loadAdoptedHost: async () => { events.push('source'); return host; },
});
await replace('../src/rollout-resume.mjs', {
  pendingInstalledContinuation: async ({ load }) => {
    assert.equal(await load(), host);
    return { status: 'paused', results: [] };
  },
});
mock.module('../src/core-package-retirement-host.mjs', { namedExports: {
  retireInstalledCorePackages: async () => { events.push('retire'); return []; },
} });
const { completeInstalledLifecycle } = await import('../src/installed-lifecycle.mjs');
loseReply = true;
for (let attempt = 0; attempt < 2; attempt++) {
  assert.deepEqual(await completeInstalledLifecycle(),
    { status: 'paused', results: [], cleanup: [] });
  assert.deepEqual(events.slice(-3), ['retire', 'source', 'permission']);
}
console.log('Controlled installed lifecycle preparation and retry passed');
