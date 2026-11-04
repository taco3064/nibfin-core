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
      await assert.rejects(continueStages(f.options));
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
