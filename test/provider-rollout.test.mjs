import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createProviderBinding } from '../src/provider-binding.mjs';
import { providerHost } from './provider-fixture.mjs';
import { peerConfiguration } from '../src/shared-peer-adoption.mjs';
import { validateRolloutHosts } from '../src/host-rollout.mjs';

test('rollout updates component source and carries the original into E2E', () => {
  const host = providerHost();
  host.providerBinding = createProviderBinding(host);
  Object.assign(host.repository, {
    approval: {}, runner: {}, eventRunner: { reusable: {} },
    eventCaller: { reusable: {} },
  });
  const result = spawnSync('python3', ['-B', '-c', `
import copy
import json
import runpy
import sys

module = runpy.run_path(sys.argv[1])
host = json.loads(sys.stdin.read())
original = copy.deepcopy(host["providerBinding"]["original"])
configure = module["configure"]
configure.__globals__["consumer_workflows"] = lambda *_: []
pins = {"core": {"repository": "taco3064/nibfin-core", "commit": "e" * 40,
                 "manifestHash": "f" * 64}, "action": {"commit": "d" * 40}}
configure("example/peer", host, "base", pins, {}, "blob")
assert host["providerBinding"]["original"] == original
assert host["providerBinding"]["components"]["source"] == pins["core"]
legacy = copy.deepcopy(host)
del legacy["providerBinding"]
configure("example/peer", legacy, "base", pins, {}, "blob")
assert "providerBinding" not in legacy

compose = module["configure_e2e"]
e2e = module["E2E"]
def api(path):
    if path == f"repos/{e2e}":
        return {"full_name": e2e, "private": False, "default_branch": "main", "id": 2}
    if path.endswith("required_status_checks"):
        return {"checks": [{"context": "verify", "app_id": 15368}]}
    if path.endswith("branches/main"):
        return {"protected": True, "commit": {"sha": "base"}}
    return {"path": module["ISSUE"], "state": "active", "id": 10}
compose.__globals__["api"] = api
compose.__globals__["e2e_issue_recipe"] = lambda _: b"fixed-caller"
compose.__globals__["content"] = lambda *_: (b"fixed-caller", "b")
peer = compose(host, "base", pins, {}, "blob")
assert peer["providerBinding"] == host["providerBinding"]
assert peer["providerBinding"]["original"] == original
`, new URL('../scripts/host-auto-rollout.py', import.meta.url).pathname],
  { input: JSON.stringify(host), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// Use the same batch boundary as promotion, with peers produced by adoption.
// These are controlled configurations, not a real-host promotion.
function rolloutPool(explicit = true) {
  const primary = providerHost();
  primary.runnerId = primary.sharedRunner.runner.runnerId;
  primary.repository.runner.repository = 'taco3064/nibfin-core';
  primary.sharedRunner.runner.repository = 'taco3064/nibfin-core';
  const pin = primary.installation.pin;
  const source = { repository: pin.repository, commit: pin.commit };
  const action = 'd'.repeat(40);
  const runner = primary.repository.runner;
  Object.assign(runner, { actionCommit: action, actionCoreCommit: pin.commit });
  Object.assign(primary.repository, { approval: { repositoryId: 1, source },
    eventRunner: { ...runner, reusable: { commit: pin.commit } },
    eventCaller: { reusable: { commit: pin.commit } } });
  if (explicit) primary.providerBinding = createProviderBinding(primary);
  const peer = peerConfiguration(primary, 'taco3064/nibfin-act', 2, source,
    action, { head: 'e'.repeat(40), action: {}, issue: {} }, 'f'.repeat(40));
  const hosts = [{ repository: 'nibfin-core', current: primary },
    { repository: 'nibfin-act', current: JSON.parse(JSON.stringify(peer)) }];
  const nextPin = { ...pin, commit: 'e'.repeat(40) };
  const nextSource = { ...source, commit: nextPin.commit };
  const staged = spawnSync('python3', ['-B', '-c', `
import json
import runpy
import sys

module = runpy.run_path(sys.argv[1])
configure = module["configure"]
configure.__globals__["consumer_workflows"] = lambda *_: []
inputs = json.load(sys.stdin)
for host in inputs["hosts"]:
    host["next"] = configure("taco3064/" + host["repository"],
                             json.loads(json.dumps(host["current"])), "base",
                             inputs["pins"], inputs["source"], "blob")
print(json.dumps(inputs["hosts"]))
`, new URL('../scripts/host-auto-rollout.py', import.meta.url).pathname],
  { input: JSON.stringify({ hosts, pins: { core: nextPin,
    action: { commit: action } }, source: nextSource }), encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const configured = JSON.parse(staged.stdout);
  return { hosts: configured, pin: nextPin, source: nextSource, action };
}

test('promotion accepts adopted peers for legacy and bound same-provider updates', () => {
  for (const explicit of [false, true]) {
    const { hosts, pin, source, action } = rolloutPool(explicit);
    assert.equal(hosts[1].current.model, undefined);
    assert.equal(hosts[1].current.authFile, undefined);
    validateRolloutHosts(hosts, pin, source, action);
    assert.deepEqual(hosts[1].next.providerBinding, hosts[0].next.providerBinding);
    if (explicit) assert.deepEqual(hosts[1].next.providerBinding.original,
      hosts[0].current.providerBinding.original);
  }
});

test('promotion rejects conflicting current or staged peer views', () => {
  for (const phase of ['current', 'next']) {
    for (const mutate of [
      peer => { peer.provider = 'claude'; },
      peer => { peer.providerBinding.original.pool.runners[0].id++; },
      peer => { delete peer.providerBinding; },
      peer => { peer.providerBinding.components.modelRunner = 'unavailable'; },
      peer => { peer.repository.isolation.agent.image = 'sha256:' + '0'.repeat(64); },
    ]) {
      const { hosts, pin, source, action } = rolloutPool();
      mutate(hosts[1][phase]);
      assert.throws(() => validateRolloutHosts(hosts, pin, source, action),
        { code: 'PROVIDER_VIEW_MISMATCH' });
    }
  }
});

test('promotion validates the primary composition before enrolled peers', () => {
  const { hosts, pin, source, action } = rolloutPool();
  hosts[0].next.providerBinding.components.modelRunner = 'unavailable';
  assert.throws(() => validateRolloutHosts(hosts, pin, source, action),
    { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
});
