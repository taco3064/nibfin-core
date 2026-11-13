import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerE2ePeer, validateE2eRollout, validateRolloutHost,
} from '../src/host-rollout.mjs';

const pin = { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40) };
const source = { repository: pin.repository, commit: pin.commit };
const action = 'b'.repeat(40);
const current = { kind: 'single-host-linux-v1', uid: 100, runnerUid: 101,
  runnerId: 23, memberId: 10, stateRoot: '/state', tokenFile: '/auth/token',
  authFile: '/auth/codex' };

function staged(repository) {
  const runner = { repository: `taco3064/${repository}`, runnerId: 23, memberId: 10 };
  return { ...current, installation: { directory: '/opt/nibfin/core', pin },
    repository: { approval: { source },
      runner: { ...runner, actionCommit: action, actionCoreCommit: pin.commit },
      eventRunner: { ...runner, reusable: { commit: pin.commit } },
      eventCaller: { reusable: { commit: pin.commit } },
    } };
}

test('host promotion requires the same Core and Action for all bindings', () => {
  for (const repository of ['nibfin-core', 'nibfin-act', 'gh-nibfin']) {
    const next = staged(repository);
    validateRolloutHost(repository, current, next, pin, source, action);
    const wrong = structuredClone(next);
    wrong.repository.eventRunner.reusable.commit = 'c'.repeat(40);
    assert.throws(() => validateRolloutHost(repository, current, wrong, pin, source,
      action), { code: 'ROLLOUT_HOST_BINDING_MISMATCH' });
    assert.throws(() => validateRolloutHost(repository, current,
      { ...next, tokenFile: '/other' }, pin, source, action),
    { code: 'ROLLOUT_HOST_BINDING_MISMATCH' });
  }
});

test('E2E adoption binds the shared host and verified Issue caller', () => {
  const primary = staged('nibfin-core');
  primary.sharedRunner = { runner: { runnerId: primary.runnerId } };
  primary.repository.isolation = { kind: 'linux-rootful-docker-v1' };
  const repository = 'taco3064/nibfin-e2e';
  const repositoryId = 1445256917;
  const runner = { repository, repositoryId, runnerId: primary.runnerId,
    memberId: primary.memberId, workflowPath: '.github/workflows/nibfin-issue.yml' };
  const next = { ...primary, issues: {}, repository: {
    runner,
    approval: { kind: 'repository-admission-v1', repository, repositoryId,
      memberId: primary.memberId, source },
    eventRunner: { ...runner, reusable: { commit: pin.commit } },
    eventCaller: { eventName: 'issues' },
    isolation: primary.repository.isolation,
  } };
  assert.equal(validateE2eRollout(next, primary, source), repositoryId);
  const wrong = structuredClone(next);
  wrong.repository.eventRunner.reusable.commit = 'c'.repeat(40);
  assert.throws(() => validateE2eRollout(wrong, primary, source),
    { code: 'ROLLOUT_E2E_BINDING_MISMATCH' });
  assert.throws(() => validateE2eRollout({ ...next, tokenFile: '/other' },
    primary, source), { code: 'ROLLOUT_E2E_BINDING_MISMATCH' });
});

test('E2E enrollment covers the CLI host used by the second shared Runner', () => {
  const e2ePath = '/etc/nibfin/host.nibfin-e2e.json';
  const corePeer = '/etc/nibfin/host.core-peer.json';
  const cliHost = {
    wakePeerFiles: [corePeer],
    sharedRunner: { runner: { runnerId: 24 }, repositories: [1442713731] },
  };
  const repositoryId = 1445256917;
  registerE2ePeer(cliHost, e2ePath, repositoryId);
  registerE2ePeer(cliHost, e2ePath, repositoryId);
  assert.deepEqual(cliHost, {
    wakePeerFiles: [corePeer, e2ePath],
    sharedRunner: { runner: { runnerId: 24 }, repositories: [1442713731, repositoryId] },
  });
});
