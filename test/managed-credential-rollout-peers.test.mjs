import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialRolloutPeers } from '../src/managed-credential-rollout-peers.mjs';
import { hostFile } from '../src/host-adoption.mjs';

const peer = '/etc/nibfin/host.peer.json';
const oldPin = { commit: 'old' }, pin = { commit: 'new' };
const snapshot = (value, repository) => JSON.stringify({
  repository, installation: { directory: '/opt/nibfin/core', pin: value },
});

function fixture() {
  const targets = [hostFile, peer].map((path, index) => ({
    path, current: snapshot(oldPin, index), next: snapshot(pin, index),
  }));
  const plan = { schemaVersion: 2, mode: 'core-only', phase: 'applying', pin,
    apply: { oldPin, targets, completed: false } };
  const actual = { [hostFile]: targets[0].next, [peer]: targets[1].current };
  const pins = [], closures = [];
  return { plan, actual, pins, closures, check: () => credentialRolloutPeers([peer],
    async value => { pins.push(value); }, {
      plan: async () => plan,
      closure: async value => { closures.push(value); },
      read: async path => actual[path],
    }) };
}

test('the manager verifies both sides of the same interrupted host rollout', async () => {
  const f = fixture();
  await f.check();
  assert.deepEqual(f.pins, [oldPin, pin]);
  assert.deepEqual(f.closures, [f.plan, f.plan]);
});

test('mixed host credential evidence is rejected outside the recorded transaction',
  async () => {
    const f = fixture();
    f.plan.phase = 'verifying';
    await assert.rejects(f.check(), { code: 'MANAGED_CREDENTIAL_HOST_INVALID' });
    f.plan.phase = 'applying';
    f.actual[peer] = snapshot(oldPin, 'different-peer');
    await assert.rejects(f.check(), { code: 'MANAGED_CREDENTIAL_HOST_INVALID' });
    assert.deepEqual(f.pins, []);
  });
