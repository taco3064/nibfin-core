import { pressureFixture } from './host-pressure-fixture.mjs';
import { hostMemoryPressure, pressureStages } from '../src/host-memory-pressure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { continueStages } from '../src/stage-continuation.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';
import { digest } from '../src/identity.mjs';
import { issueRequirementsChanged } from '../src/stages.mjs';
import { githubReadWaiting } from '../src/observation-failure.mjs';
import { codexPreflightExits } from '../src/codex-bootstrap.mjs';

function fixture() {
  const receipts = {},
    objects = {},
    calls = [];
  const store = {
    load: async () => structuredClone(receipts),
    get: async (hash) => objects[hash],
  };
  const options = {
    store,
    inspect: async () => {},
    wait: async () => {},
    execute: async (stage) => {
      calls.push(stage);
      const receipt = { stage, outcome: stageSuccess[stage] };
      const hash = digest(receipt);
      receipts[stage] = receipt;
      objects[hash] = receipt;
      return { stage, status: 'completed', receiptHash: hash };
    },
  };
  return { receipts, objects, calls, options };
}

test('continuation does not replay completed stages after a new dispatch', async () => {
  const f = fixture();
  f.receipts.shape = { stage: 'shape', outcome: 'ready' };
  assert.equal((await continueStages(f.options)).stage, 'close');
  assert.equal(f.calls.includes('shape'), false);
  const count = f.calls.length;
  assert.equal((await continueStages(f.options)).code, 'DELIVERY_ALREADY_RECORDED');
  assert.equal(f.calls.length, count);
});

test('blocked Shape retries after edits and migrates old receipts', async () => {
  for (const prior of [undefined, 'Earlier requirements', 'Current requirements']) {
    const f = fixture();
    const issue = { body: 'Current requirements\r\n' };
    f.receipts.shape = { stage: 'shape', outcome: 'blocked', requirementsBody: prior };
    f.options.refreshRequirements = receipts => issueRequirementsChanged(issue, receipts,
      () => assert.fail('A failed Shape has no published artifact to read'));
    const result = await continueStages(f.options);
    assert.equal(f.calls.includes('shape'), prior !== 'Current requirements');
    assert.equal(result.stage, prior === 'Current requirements' ? 'shape' : 'close');
  }
});

test('temporary pre-effect GitHub reads resume Accept without replaying Deliver',
  async () => {
    const f = fixture();
    const execute = f.options.execute;
    const delays = [];
    let accept = 0;
    let now = 0;
    f.options.clock = () => now;
    f.options.wait = async delay => { delays.push(delay); now += delay; };
    f.options.execute = async stage => {
      if (stage === 'accept' && ++accept < 3) {
        return { stage, status: 'pending', code: githubReadWaiting, retryAfterMs: 60000 };
      }
      return execute(stage);
    };
    assert.equal((await continueStages(f.options)).stage, 'close');
    assert.equal(accept, 3);
    assert.deepEqual(delays, [60000, 60000]);
    assert.equal(f.calls.filter(stage => stage === 'deliver').length, 1);
  });

test('published requirements compare actual Issue text', async () => {
  const issue = { body: 'Published text\r\n' };
  const shape = { requirementsBody: 'Original input' };
  const stored = () => assert.fail('New receipts store the actual published text');
  const published = { requirementsBody: 'Published text' };
  const receipts = { shape, 'publish-shape': published };
  assert.equal(await issueRequirementsChanged(issue, receipts, stored), false);
  issue.body = 'Edited text';
  assert.equal(await issueRequirementsChanged(issue, receipts, stored), true);
  receipts.merge = {};
  assert.equal(await issueRequirementsChanged(issue, receipts, stored), false);
});

test('a new dispatch resumes only a Core-proven idle interruption', async () => {
  for (const matching of [true, false]) {
    const f = fixture();
    const execution = { id: 'prior-execution' };
    const proof = {
      executionId: matching ? execution.id : 'another-execution',
      terminationHash: 'a'.repeat(64),
      code: 'CODEX_IDLE_TIMEOUT',
    };
    const hash = digest(proof);
    f.objects[hash] = proof;
    f.receipts.shape = {
      stage: 'shape', outcome: 'blocked', execution,
      references: [`evidence:${hash}`],
    };
    const result = await continueStages(f.options);
    assert.equal(result.stage, matching ? 'close' : 'shape');
    assert.equal(f.calls[0], matching ? 'shape' : undefined);
  }
});

test('saved native preflight failures recheck unfinished work on continuation',
  async () => {
    for (const code of Object.keys(codexPreflightExits)) {
      const f = fixture();
      for (const stage of ['shape', 'validate-shape', 'publish-shape'])
        f.receipts[stage] = { stage, outcome: stageSuccess[stage] };
      const execution = { id: 'stopped-before-agent' };
      const proof = { executionId: execution.id,
        terminationHash: 'a'.repeat(64), code };
      const hash = digest(proof);
      f.objects[hash] = proof;
      f.receipts.deliver = { stage: 'deliver', outcome: 'blocked', execution,
        references: ['evidence:' + hash] };
      assert.equal((await continueStages(f.options)).stage, 'close');
      assert.equal(f.calls[0], 'deliver');
      assert.equal(f.calls.filter(stage => stage === 'commit-pr').length, 1);
      const completed = f.calls.length;
      assert.equal((await continueStages(f.options)).code,
        'DELIVERY_ALREADY_RECORDED');
      assert.equal(f.calls.length, completed);
    }
  });

test('preflight restart still requires matching, proven termination', async () => {
  for (const kind of ['foreign-execution', 'missing-termination', 'product-failure']) {
    const f = fixture();
    const execution = { id: 'stopped-before-agent' };
    const proof = { executionId: execution.id,
      terminationHash: 'a'.repeat(64), code: 'SANDBOX_PROBE_FAILED' };
    if (kind === 'foreign-execution') proof.executionId = 'another-execution';
    if (kind === 'missing-termination') delete proof.terminationHash;
    if (kind === 'product-failure') proof.code = 'PRODUCT_FAILURE';
    const hash = digest(proof);
    f.objects[hash] = proof;
    f.receipts.shape = { stage: 'shape', outcome: 'blocked', execution,
      references: ['evidence:' + hash] };
    assert.equal((await continueStages(f.options)).code, 'STAGE_REQUIRES_CORRECTION');
    assert.equal(f.calls.length, 0);
  }
});

test('saved external Deliver blockers retry only a matching clean execution',
  async () => {
    for (const kind of ['settled', 'running', 'failed', 'foreign', 'product']) {
      const f = fixture();
      for (const stage of ['shape', 'validate-shape', 'publish-shape'])
        f.receipts[stage] = { stage, outcome: stageSuccess[stage] };
      const id = 'writer-completed';
      const report = { producer: 'agent', failureClass: 'external_failure',
        binding: { executionId: id },
        termination: { executionId: id, running: false, exitCode: 0 } };
      if (kind === 'running') report.termination.running = true;
      if (kind === 'failed') report.termination.exitCode = 1;
      if (kind === 'foreign') report.termination.executionId = 'another-writer';
      if (kind === 'product') report.failureClass = 'implementation_defect';
      f.receipts.deliver = { stage: 'deliver', outcome: 'blocked', report,
        execution: { id }, references: ['/work/runtime/lock'] };
      const result = await continueStages(f.options);
      assert.equal(result.stage, kind === 'settled' ? 'close' : 'deliver');
      assert.equal(f.calls.length > 0, kind === 'settled');
      if (kind === 'settled') {
        assert.equal(f.calls[0], 'deliver');
        assert.equal(f.calls.filter(stage => stage === 'commit-pr').length, 1);
        const count = f.calls.length;
        assert.equal((await continueStages(f.options)).code,
          'DELIVERY_ALREADY_RECORDED');
        assert.equal(f.calls.length, count);
      }
    }
  });

test('an idle Accept retries once only after termination is proved', async () => {
  for (const valid of [true, false]) {
    const f = fixture();
    const execute = f.options.execute;
    const proof = { executionId: 'interrupted', code: 'CODEX_IDLE_TIMEOUT',
      ...(valid ? { terminationHash: 'a'.repeat(64) } : {}) };
    const hash = digest(proof);
    f.objects[hash] = proof;
    f.options.execute = async stage => {
      const result = await execute(stage);
      if (stage !== 'accept') return result;
      const receipt = { stage, outcome: 'blocked', execution: { id: 'interrupted' },
        references: [`evidence:${hash}`] };
      f.receipts[stage] = receipt;
      return { stage, status: 'denied', code: proof.code, receiptHash: digest(receipt) };
    };
    assert.equal((await continueStages(f.options)).code, proof.code);
    assert.equal(f.calls.filter(stage => stage === 'accept').length, valid ? 2 : 1);
    assert.equal(f.calls.filter(stage => stage === 'deliver').length, 1);
  }
});

test(
  'unknown effects stop without retry; malformed or failed ' +
    'receipt prefixes cannot advance',
  async () => {
    for (const result of [
      { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' },
      { status: 'denied', code: 'LIVE_OBSERVATION_UNAVAILABLE' },
    ]) {
      const f = fixture();
      let calls = 0;
      f.options.execute = async () => {
        calls++;
        return result;
      };
      assert.deepEqual(await continueStages(f.options), result);
      assert.equal(calls, 1);
    }
    for (const receipts of [
      { accept: { outcome: 'accepted' } },
      { shape: { outcome: 'blocked' } },
    ]) {
      const f = fixture();
      Object.assign(f.receipts, receipts);
      if (receipts.shape) {
        assert.equal((await continueStages(f.options)).code, 'STAGE_REQUIRES_CORRECTION');
      } else await assert.rejects(continueStages(f.options));
      assert.equal(f.calls.length, 0);
    }
  },
);

test(
  'CI waiting is bounded and rechecks the fence; persisted ' +
    'receipt substitution stops',
  async () => {
    const f = fixture();
    let time = 0,
      reads = 0,
      attempts = 0;
    f.options.clock = () => time;
    f.options.ciTimeout = 45000;
    f.options.inspect = async () => {
      reads++;
    };
    f.options.wait = async (ms) => {
      time += ms;
    };
    f.options.execute = async () => {
      attempts++;
      return { status: 'pending', code: 'CI_WAITING' };
    };
    assert.equal((await continueStages(f.options)).code, 'CI_WAITING');
    assert.equal(attempts, 3);
    assert.equal(reads, 3);
    const bad = fixture();
    bad.options.store.get = async () => ({ stage: 'merge', outcome: 'merged' });
    await assert.rejects(continueStages(bad.options), /CONTINUATION_RECEIPT_CHANGED/);
    assert.deepEqual(bad.calls, ['shape']);
  },
);

test('provider branch update repairs once and resumes protected delivery', async () => {
  const f = fixture();
  const execute = f.options.execute;
  let requests = 0;
  f.options.execute = async stage => {
    if (stage === 'review-pr' && ++requests === 1) {
      return { status: 'denied', code: 'PR_BRANCH_UPDATE_REQUIRED' };
    }
    return execute(stage);
  };
  assert.equal((await continueStages(f.options)).stage, 'close');
  assert.equal(requests, 2);
  assert.equal(f.calls.filter(stage => stage === 'deliver').length, 2);
  assert.equal(f.calls.filter(stage => stage === 'accept').length, 1);
});

async function assertCorrectionContinues(failedStage, failure) {
  const f = fixture();
  const execute = f.options.execute;
  let candidateHash, revision = 0, rejected = false;
  f.options.execute = async (stage, findings) => {
    if (stage === 'deliver') {
      assert.deepEqual(findings, rejected ? failure : undefined);
      const candidate = {
        repository: 'example/core', repositoryId: 10, issueId: 'I_target',
        changes: String(++revision), paths: ['src/example.mjs'],
        obligations: { artifacts: [], hooks: [] }, artifacts: [], hookSources: [],
      };
      candidateHash = digest(candidate);
      f.objects[candidateHash] = candidate;
    }
    if (stage === failedStage && !rejected && failure) {
      rejected = true;
      f.calls.push(stage);
      return { stage, status: 'denied', code: 'CI_REQUIRED_CHECK_FAILED', failure };
    }
    const result = await execute(stage);
    if (!candidateHash) return result;
    const receipt = f.receipts[stage];
    receipt.artifacts = { candidateHash };
    if (stage === failedStage && !rejected) {
      rejected = true;
      receipt.outcome = 'changes_required';
      result.status = 'denied';
      result.code = 'STAGE_REQUIRES_CORRECTION';
    }
    result.receiptHash = digest(receipt);
    f.objects[result.receiptHash] = receipt;
    return result;
  };
  assert.equal((await continueStages(f.options)).stage, 'close');
  const stages = Object.keys(stageSuccess).slice(3);
  const failedPrefix = stages.slice(0, stages.indexOf(failedStage) + 1);
  assert.deepEqual(f.calls.slice(3), [...failedPrefix, ...stages]);
}
test('Accept changes go through Deliver and fresh Accept before merge', () =>
  assertCorrectionContinues('accept'));
test('Review changes go through Deliver and fresh Accept before merge', () =>
  assertCorrectionContinues('review-pr'));
test('Protected CI failures during Review and Merge require fresh Accept', async () => {
  for (const stage of ['review-pr', 'merge'])
    await assertCorrectionContinues(stage, { check: 'Windows', conclusion: 'failure' });
});

test('a correction retries only with a trusted blocked Deliver receipt', async () => {
  for (const confirmed of [true, false]) {
    const f = fixture();
    const execute = f.options.execute;
    const failure = { check: 'verify', conclusion: 'failure' };
    f.options.execute = async (stage, diagnostic) => {
      if (stage === 'review-pr')
        return { stage, status: 'denied', code: 'CI_REQUIRED_CHECK_FAILED', failure };
      if (!diagnostic) return execute(stage);
      assert.deepEqual(diagnostic, failure);
      const receipt = { stage, outcome: 'blocked', blockedCICorrection: confirmed };
      const receiptHash = digest(receipt);
      f.receipts[stage] = receipt;
      return { stage, status: 'denied', code: 'STAGE_REQUIRES_CORRECTION', receiptHash };
    };
    const result = await continueStages(f.options);
    assert.equal(result.code, confirmed
      ? 'CI_CORRECTION_RETRY_PENDING' : 'STAGE_REQUIRES_CORRECTION');
    assert.equal(f.calls.includes('merge'), false);
  }
});

test('unchanged rebase retains hooks, Accept and Final Review evidence', async () => {
  const f = fixture();
  const shapeHash = 'a'.repeat(64);
  const old = { base: '1'.repeat(40), tree: '2'.repeat(40),
    repository: 'example/core', repositoryId: 10, issueId: 'I_target',
    changes: 'changed path', paths: ['src/example.mjs'],
    obligations: { artifacts: [], hooks: [] }, artifacts: [], hookSources: [] };
  const rebased = { ...old, base: '3'.repeat(40), tree: '4'.repeat(40) };
  const candidateHash = digest(old), nextHash = digest(rebased);
  const proof = { shapeHash, candidateHash };
  const pr = { prId: 'PR_1', prNumber: 1 };
  f.objects[candidateHash] = old;
  f.objects[nextHash] = rebased;
  for (const stage of Object.keys(stageSuccess).slice(0, -2)) {
    const artifacts = ['shape', 'validate-shape', 'publish-shape'].includes(stage)
      ? { shapeHash } : { ...proof, ...pr };
    f.receipts[stage] = { stage, outcome: stageSuccess[stage], artifacts };
  }
  f.receipts.deliver.artifacts.candidateHash = nextHash;
  const execute = f.options.execute;
  f.options.execute = async stage => {
    if (stage !== 'commit-pr') return execute(stage);
    f.calls.push(stage);
    const receipt = { stage, outcome: 'published',
      artifacts: { ...proof, ...pr, candidateHash: nextHash } };
    const receiptHash = digest(receipt);
    f.receipts[stage] = receipt;
    f.objects[receiptHash] = receipt;
    return { stage, status: 'completed', receiptHash };
  };
  assert.equal((await continueStages(f.options)).stage, 'close');
  assert.deepEqual(f.calls, ['commit-pr', 'merge', 'close']);
});

test('pressure resumes the first unfinished Agent stage and preserves native writes',
  async () => {
    for (const interrupted of pressureStages) {
      for (const matching of [true, false]) {
        const f = fixture();
        const execution = { id: pressureFixture().binding.executionId,
          runId: 20, attempt: 1, jobId: 30 };
        const proof = { executionId: execution.id, code: hostMemoryPressure,
          stage: interrupted, terminationHash: 'a'.repeat(64),
          memoryPressure: pressureFixture({ stage: interrupted,
            jobId: matching ? 30 : 31 }) };
        const hash = digest(proof);
        f.objects[hash] = proof;
        const stages = Object.keys(stageSuccess);
        for (const stage of stages.slice(0, stages.indexOf(interrupted)))
          f.receipts[stage] = { stage, outcome: stageSuccess[stage] };
        f.receipts[interrupted] = { stage: interrupted, outcome: 'blocked',
          execution, references: ['evidence:' + hash] };
        const prior = structuredClone(f.receipts);
        const result = await continueStages(f.options);
        if (!matching) {
          assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
          assert.deepEqual(f.calls, []);
          continue;
        }
        assert.equal(result.stage, 'close');
        assert.deepEqual(f.calls, stages.slice(stages.indexOf(interrupted)));
        for (const stage of stages.slice(0, stages.indexOf(interrupted)))
          assert.deepEqual(f.receipts[stage], prior[stage]);
        if (interrupted === 'review-pr') {
          assert.equal(f.receipts['commit-pr'].outcome, 'published');
          assert.equal(f.calls.includes('commit-pr'), false);
          assert.equal(f.calls.includes('deliver'), false);
        }
      }
    }
  });
