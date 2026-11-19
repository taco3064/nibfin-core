import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCoreOnlyUpdate, coreOnlyRuntimeFacts }
  from '../src/core-only-compatibility.mjs';
import { providerHost } from './provider-fixture.mjs';

const observations = { kernel: 'x86_64', runtime: 'x64' };
const runtime = { node: '24.22.1', artifactArch: 'x64', elfMachine: 62,
  nodeSha256: 'a'.repeat(64), observations: ['amd64', 'x64', 'x86_64'],
  files: { dispatcher: 'fixed dispatcher', service: 'fixed service' } };

function hosts() {
  const current = providerHost();
  current.runnerId = current.sharedRunner.runner.runnerId;
  const next = structuredClone(current);
  next.installation.pin.commit = '2'.repeat(40);
  next.installation.pin.manifestHash = '3'.repeat(64);
  return [{ current, next }];
}

test('compatible Core source changes do not select Runner maintenance', () => {
  assert.deepEqual(classifyCoreOnlyUpdate(hosts(), runtime, runtime, observations),
    { status: 'compatible', mode: 'core-only' });
  const aliases = { ...runtime, observations: [...runtime.observations, 'new_alias'] };
  assert.equal(classifyCoreOnlyUpdate(hosts(), runtime, aliases,
    observations).status, 'compatible');
});

test('runtime and service changes require separate maintenance', () => {
  for (const patch of [{ node: '25.0.0' }, { nodeSha256: 'b'.repeat(64) },
    { artifactArch: 'arm64' }, { elfMachine: 183 },
    { files: { ...runtime.files, dispatcher: 'changed' } },
    { observations: ['amd64'] }]) {
    const result = classifyCoreOnlyUpdate(hosts(), runtime,
      { ...runtime, ...patch }, observations);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.code, 'CORE_ONLY_MAINTENANCE_REQUIRED');
  }
});

test('pool, layout, provider and credential identities are preserved', () => {
  for (const change of [
    next => { next.sharedRunner.additionalRunner.id++; },
    next => { next.sharedRunner.additionalRunner.uid++; },
    next => { next.installation.directory = '/different/core'; },
    next => { next.tokenFile = '/different/token'; },
    next => { next.provider = 'claude'; },
    next => { next.repository.isolation.agent.image = 'sha256:' + 'e'.repeat(64); },
  ]) {
    const input = hosts();
    change(input[0].next);
    assert.equal(classifyCoreOnlyUpdate(input, runtime, runtime,
      observations).status, 'unsupported');
  }
});

test('package observation reuses the maintained platform contract and fixed files',
  async () => {
    const actual = await coreOnlyRuntimeFacts(process.cwd(), 'amd64');
    assert.equal(actual.artifactArch, 'x64');
    assert(actual.files['src/security/shared-worker-dispatcher.sh']
      .includes('/opt/nibfin/core/src/security/shared-worker-dispatch.py'));
    const failure = new Error('source unavailable');
    await assert.rejects(coreOnlyRuntimeFacts(process.cwd(), 'amd64',
      async () => { throw failure; }), error => error === failure);
  });
