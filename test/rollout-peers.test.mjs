import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRolloutPeer } from '../src/rollout-peers.mjs';
import { validateRolloutIsolation } from '../src/host-rollout.mjs';
import { providerHost } from './provider-fixture.mjs';

function fixture() {
  const host = providerHost();
  host.repository.isolation.agent = { socket: '/engine', network: 'one',
    gatewayId: 'first', mcpPolicyDirectory: '/policy/one' };
  host.sharedRunner.additionalRunner.isolation.agent = { socket: '/engine',
    network: 'two', gatewayId: 'second', mcpPolicyDirectory: '/policy/two' };
  return host;
}

test('peer source refresh retains its registration, credentials and isolation', () => {
  const current = fixture();
  current.repository.approval.repository = 'taco3064/nibfin-core';
  current.repository.runner = { runnerId: 42, workflowId: 50, workflowPath: 'wake',
    sourceCommit: 'old', workflowBlob: 'old' };
  current.repository.eventRunner = { runnerId: 42, workflowId: 51, workflowPath: 'issue',
    sourceCommit: 'old', workflowBlob: 'old', reusable: { commit: 'old' } };
  current.repository.eventCaller = { eventName: 'issues', reusable: { commit: 'old' } };
  const canonical = structuredClone(current);
  canonical.installation.pin.commit = 'new';
  for (const key of ['runner', 'eventRunner']) {
    canonical.repository[key].sourceCommit = 'new';
    canonical.repository[key].workflowBlob = 'new';
    canonical.repository[key].runnerId = 99; // Canonical identity must not be copied.
  }
  let validated = false;
  const before = structuredClone(current);
  const next = refreshRolloutPeer(current, canonical, {}, {}, 'action',
    (repository, old, value) => {
      assert.equal(repository, 'nibfin-core');
      assert.deepEqual(old, before);
      assert.equal(value.repository.runner.runnerId, 42);
      validated = true;
    });
  assert(validated);
  assert.equal(next.repository.runner.sourceCommit, 'new');
  assert.equal(next.repository.eventRunner.runnerId, 42);
  assert.equal(next.tokenFile, current.tokenFile);
  assert.deepEqual(next.repository.isolation, current.repository.isolation);
  assert.deepEqual(next.sharedRunner, current.sharedRunner);
  assert.deepEqual(current, before);
});

test('enrolled views share their slot while the two slots remain isolated', () => {
  const current = fixture(), next = structuredClone(current);
  const hosts = [{ current, next }, { current: structuredClone(current),
    next: structuredClone(next) }];
  assert.deepEqual(validateRolloutIsolation(hosts),
    current.sharedRunner.additionalRunner.isolation);
  hosts[1].next.repository.isolation.agent.network = 'changed';
  assert.throws(() => validateRolloutIsolation(hosts),
    { code: 'ROLLOUT_RUNNER_ISOLATION_CHANGED' });
  hosts.pop();
  current.sharedRunner.additionalRunner.isolation.agent.network = 'one';
  assert.throws(() => validateRolloutIsolation(hosts),
    { code: 'SHARED_RUNNER_SLOT_ISOLATION_CONFLICT' });
});
