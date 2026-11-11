import test from 'node:test';
import assert from 'node:assert/strict';
import { continueStages } from '../src/stage-continuation.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';
import { digest } from '../src/identity.mjs';

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
    f.options.ciTimeout = 10000;
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

test('review changes go through Deliver and fresh Accept before merge', async () => {
  const f = fixture();
  const execute = f.options.execute;
  let candidateHash, revision = 0, reviewed = false;
  f.options.execute = async stage => {
    if (stage === 'deliver') {
      const candidate = {
        repository: 'example/core', repositoryId: 10, issueId: 'I_target',
        diffHash: String(++revision).repeat(64), paths: ['src/example.mjs'],
        obligations: { artifacts: [], hooks: [] }, artifacts: [], hookSources: [],
      };
      candidateHash = digest(candidate);
      f.objects[candidateHash] = candidate;
    }
    const result = await execute(stage);
    if (!candidateHash) return result;
    const receipt = f.receipts[stage];
    receipt.artifacts = { candidateHash };
    if (stage === 'review-pr' && !reviewed) {
      reviewed = true;
      receipt.outcome = 'changes_required';
      result.status = 'denied';
      result.code = 'STAGE_REQUIRES_CORRECTION';
    }
    result.receiptHash = digest(receipt);
    f.objects[result.receiptHash] = receipt;
    return result;
  };
  assert.equal((await continueStages(f.options)).stage, 'close');
  assert.deepEqual(f.calls.slice(3), [
    'deliver', 'pre-accept-hooks', 'accept', 'post-accept-hooks',
    'commit-pr', 'review-pr', 'deliver', 'pre-accept-hooks', 'accept',
    'post-accept-hooks', 'commit-pr', 'review-pr', 'merge', 'close',
  ]);
});

test('unchanged rebase retains hooks, Accept and Final Review evidence', async () => {
  const f = fixture();
  const shapeHash = 'a'.repeat(64);
  const old = { base: '1'.repeat(40), tree: '2'.repeat(40),
    repository: 'example/core', repositoryId: 10, issueId: 'I_target',
    diffHash: 'b'.repeat(64), paths: ['src/example.mjs'],
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
