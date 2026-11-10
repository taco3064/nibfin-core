import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRolloutHost } from '../src/host-rollout.mjs';

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
