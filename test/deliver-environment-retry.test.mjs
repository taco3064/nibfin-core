import test from 'node:test';
import assert from 'node:assert/strict';
import { continueStages } from '../src/stage-continuation.mjs';
import { settleHostStage } from '../src/host-stage-settlement.mjs';
import { digest } from '../src/identity.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';

test('guest maintenance failure releases its fence and resumes after maintenance',
  async () => {
    const execution = { id: 'old-writer' };
    const proof = { executionId: execution.id, terminationHash: 'a'.repeat(64),
      code: 'JOB_VM_TOOL_OUTPUT_UNAVAILABLE' };
    const hash = digest(proof);
    const receipts = Object.fromEntries(['shape', 'validate-shape', 'publish-shape']
      .map(stage => [stage, { stage, outcome: stageSuccess[stage] }]));
    receipts.deliver = { stage: 'deliver', outcome: 'blocked', execution,
      references: ['evidence:' + hash] };
    let releases = 0;
    const result = await settleHostStage(async () => ({ status: 'denied',
      code: proof.code }), async () => { releases++; }, () => {});
    assert.equal(releases, 1);
    assert.equal(result.retrySettled, true);
    const calls = [];
    const objects = { [hash]: proof };
    const resumed = await continueStages({
      store: { load: async () => structuredClone(receipts),
        get: async key => objects[key] },
      inspect: async () => {}, wait: async () => {},
      execute: async stage => {
        calls.push(stage);
        const entry = { stage, outcome: stageSuccess[stage] };
        const key = digest(entry);
        receipts[stage] = entry; objects[key] = entry;
        return { stage, status: 'completed', receiptHash: key };
      },
    });
    assert.equal(resumed.stage, 'close');
    assert.equal(calls[0], 'deliver');
    assert.equal(calls.includes('shape'), false);
  });

test('a settled historical #277/#564 environment failure can retry explicitly',
  async () => {
    for (const confirmed of [true, false]) {
      const calls = [];
      const receipts = {
        shape: { outcome: 'ready' }, 'validate-shape': { outcome: 'approved' },
        'publish-shape': { outcome: 'published' },
        deliver: { outcome: 'blocked', execution: { id: 'historical-writer' },
          references: ['First failed command', 'Second failed command'], report: {
            producer: 'agent', failureClass: 'external_failure',
            binding: { executionId: 'historical-writer' },
            termination: { owner: 'docker-inspect',
              executionId: 'historical-writer', running: !confirmed, exitCode: 0 },
          } },
      };
      const result = await continueStages({
        store: { load: async () => receipts },
        inspect: async () => {}, wait: async () => {},
        execute: async stage => {
          calls.push(stage);
          return { status: 'pending', code: 'FIXTURE_FRESH_DELIVER', stage };
        },
      });
      assert.equal(result.code,
        confirmed ? 'FIXTURE_FRESH_DELIVER' : 'STAGE_REQUIRES_CORRECTION');
      assert.deepEqual(calls, confirmed ? ['deliver'] : []);
    }
  });
