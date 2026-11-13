import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunnerBinding } from '../src/runner-binding.mjs';
import { decideStage } from '../src/stages.mjs';
import { executionProfile } from '../src/execution-profiles.mjs';
import { codexEnvironment } from '../src/codex-environment.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

test('native Runner OS is observed without granting backend support', async () => {
  for (const os of ['linux', 'windows', 'osx']) {
    const f = runnerProviderFixture();
    f.expected.os = os;
    f.runner.os = os;
    const binding = await readRunnerBinding(f.reader, f.expected);
    assert.equal(binding.os, os);
    assert.equal(Object.hasOwn(binding, 'authorized'), false);
    f.expected.os = 'different';
    await assert.rejects(
      readRunnerBinding(f.reader, f.expected),
      /ACTUAL_RUNNER_BINDING_MISMATCH/,
    );
  }
});

test('a known backend cannot authorize a different or unknown Runner OS', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  for (const os of ['windows', 'osx', 'unknown', undefined]) {
    const context = stageFixture();
    context.runner.os = os;
    assert.equal(
      decideStage('shape', context, now).code,
      'ISOLATION_OR_WRITER_PROOF_REQUIRED',
    );
  }
});

test('unimplemented Desktop profiles and caller-selected adapters deny', async () => {
  const context = stageFixture();
  const now = Date.parse('2026-11-03T12:00:00Z');
  for (const name of ['docker-desktop', '/tmp/adapter.mjs', 'constructor']) {
    context.isolation.profile = name;
    assert.equal(decideStage('shape', context, now).code, 'UNVERIFIED_EXECUTION_BACKEND');
    await assert.rejects(
      () => codexEnvironment({ kind: name }, '/installed'),
      /UNVERIFIED_EXECUTION_BACKEND/,
    );
  }
  assert.equal(Object.isFrozen(executionProfile('linux-rootless-docker-v1')), true);
});

test('both Linux backends retain the same writer and execution gates', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const mutations = [
    (c) => {
      c.isolation.writerStatus = 'unknown';
    },
    (c) => {
      c.isolation.executionId = 'foreign';
    },
    (c) => {
      c.isolation.observationHash = '';
    },
  ];
  for (const profile of ['linux-rootless-docker-v1', 'linux-rootful-docker-v1']) {
    const context = stageFixture();
    context.isolation.profile = profile;
    assert.equal(decideStage('shape', context, now).status, 'allowed');
    for (const mutation of mutations) {
      const changed = structuredClone(context);
      mutation(changed);
      assert.equal(decideStage('shape', changed, now).status, 'denied');
    }
    context.runner.os = 'windows';
    assert.equal(decideStage('shape', context, now).status, 'denied');
  }
});

test('Agent and Hooks cannot use different privileged Docker endpoints', async () => {
  if (process.platform !== 'linux') return;
  await assert.rejects(
    () =>
      codexEnvironment(
        {
          kind: 'linux-rootless-docker-v1',
          agent: { docker: '/usr/bin/docker', socket: '/run/user/1000/docker.sock' },
          hooks: { docker: '/usr/bin/docker', socket: '/different.sock' },
        },
        '/installed',
      ),
    /SPLIT_HOST_DAEMON/,
  );
});
