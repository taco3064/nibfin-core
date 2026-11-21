import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResult } from '../src/claude-result.mjs';
import { parseAgentResult, validateAgentResult } from '../src/agent-result.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { digest } from '../src/identity.mjs';

const progress = {
  outcome: 'progress', body: '', summary: 'Meaningful implementation progress',
  rootCause: '', failureClass: 'none', evidenceReferences: ['src/example.mjs'],
  blockingFindings: [], contractConflicts: [],
};

test('progress belongs only to Deliver and rejects unresolved findings', () => {
  assert.equal(validateAgentResult('deliver', progress).outcome, 'progress');
  for (const stage of ['shape', 'validate-shape', 'accept', 'review-pr'])
    assert.throws(() => validateAgentResult(stage, progress),
      { code: 'WRONG_ROLE_OUTCOME' });
  assert.throws(() => validateAgentResult('deliver', {
    ...progress, blockingFindings: ['Unresolved implementation failure'],
  }), { code: 'INCONSISTENT_AGENT_RESULT' });
});

for (const restoredReceipt of [false, true]) {
  test(`progress resumes with zero repair budget, local receipt: ${restoredReceipt}`,
    async () => {
      const c = stageFixture('accept');
      const receipts = structuredClone(c.receipts);
      const objects = new Map();
      const stages = [];
      const checkpoint = { branch: 'nibfin/deliver-2', head: 'a'.repeat(40) };
      for (const name of Object.keys(receipts).slice(
        Object.keys(receipts).indexOf('deliver')))
        delete receipts[name];
      const shapeHash = c.shape.hash;
      if (restoredReceipt) receipts.deliver = { stage: 'deliver', outcome: 'progress',
        artifacts: { shapeHash }, deliveryCheckpoint: checkpoint };
      let attempts = 0;
      const result = await continueStages({ correctionRepairs: 0,
        store: { load: async () => structuredClone(receipts),
          get: async key => objects.get(key) }, inspect: async () => {},
        execute: async stage => {
          stages.push(stage);
          if (stage !== 'deliver') return { stage, status: 'denied' };
          attempts++;
          const outcome = attempts === 1 ? 'progress' : 'ready';
          const receipt = { stage, outcome, artifacts: { shapeHash },
            deliveryCheckpoint: checkpoint };
          receipts.deliver = receipt;
          const receiptHash = digest(receipt);
          objects.set(receiptHash, receipt);
          return { stage, status: outcome === 'progress' ? 'pending' : 'completed',
            code: outcome === 'progress' ? 'DELIVER_PROGRESS_SAVED' : 'STAGE_COMPLETED',
            receiptHash };
        } });
      assert.deepEqual(stages, ['deliver', 'deliver', 'pre-accept-hooks']);
      assert.equal(result.stage, 'pre-accept-hooks');
    });
}


test('both provider adapters share the progress contract at completed execution', () => {
  const thread = '00000000-0000-4000-8000-000000000001';
  const lastMessage = JSON.stringify(progress);
  const events = [{ type: 'thread.started', thread_id: thread },
    { type: 'turn.started' }, { type: 'item.completed',
      item: { type: 'agent_message', text: lastMessage } }, { type: 'turn.completed' }];
  assert.deepEqual(parseAgentResult('deliver', events.map(JSON.stringify).join('\n'),
    lastMessage).result, progress);
  assert.deepEqual(parseClaudeResult('deliver', JSON.stringify({ type: 'result',
    is_error: false, subtype: 'success', session_id: thread,
    structured_output: progress })).result, progress);
  assert.throws(() => parseAgentResult('deliver',
    events.slice(0, -1).map(JSON.stringify).join('\n'), lastMessage),
  { code: 'AGENT_TURN_INCOMPLETE' });
});

for (const route of ['correction', 'ci-correction', 'integration', 'checkpoint']) {
  test(`nested ${route} resumes progress before advancing`, async () => {
    const c = stageFixture('accept');
    const receipts = {};
    const objects = new Map();
    const calls = [];
    const events = [];
    const names = Object.keys(c.receipts).concat('close');
    const checkpoint = { branch: 'nibfin/deliver-2', head: 'a'.repeat(40) };
    const failure = { check: 'verify', conclusion: 'failure' };
    let deliveries = 0, triggered = false, candidateHash;
    const store = { load: async () => structuredClone(receipts),
      get: async key => objects.get(key) };
    const result = await continueStages({ store, correctionRepairs: 1,
      saveDeliverCheckpoint: route === 'checkpoint',
      inspect: async () => { events.push('inspect'); },
      execute: async (stage, findings) => {
        calls.push(stage);
        events.push(stage);
        const target = route === 'correction' ? 'accept' :
          route === 'checkpoint' ? 'pre-accept-hooks' : 'review-pr';
        if (stage === target && !triggered) {
          triggered = true;
          if (route !== 'correction') return { stage, status: 'denied',
            code: route === 'checkpoint' ? 'DELIVER_CHECKPOINT_REQUIRED' :
              route === 'integration' ? 'PR_BRANCH_UPDATE_REQUIRED' :
                'CI_REQUIRED_CHECK_FAILED',
            ...(route === 'ci-correction' ? { failure } : {}) };
        }
        const receipt = structuredClone(c.receipts[stage] ??
          { stage, outcome: 'closed' });
        if (stage === 'deliver') {
          deliveries++;
          assert.deepEqual(findings,
            route === 'ci-correction' && deliveries > 1 ? failure : undefined);
          for (const name of names.slice(names.indexOf('deliver')))
            delete receipts[name];
          receipt.deliveryCheckpoint = checkpoint;
          if (deliveries === 2) {
            receipt.outcome = 'progress';
            delete receipt.artifacts.candidateHash;
          } else {
            const candidate = { ...c.candidate, changes: String(deliveries) };
            candidateHash = digest(candidate);
            objects.set(candidateHash, candidate);
          }
        }
        if (receipt.artifacts?.candidateHash)
          receipt.artifacts.candidateHash = candidateHash;
        if (route === 'correction' && stage === 'accept' && deliveries === 1)
          receipt.outcome = 'changes_required';
        receipts[stage] = receipt;
        const receiptHash = digest(receipt);
        objects.set(receiptHash, structuredClone(receipt));
        const progress = receipt.outcome === 'progress';
        const rejected = receipt.outcome === 'changes_required';
        return { stage, receiptHash,
          status: progress ? 'pending' : rejected ? 'denied' : 'completed',
          code: progress ? 'DELIVER_PROGRESS_SAVED' : rejected ?
            'STAGE_REQUIRES_CORRECTION' : 'STAGE_COMPLETED' };
      } });
    assert.equal(result.stage, 'close');
    assert.equal(result.status, 'completed');
    assert.equal(deliveries, 3);
    const resumed = calls.indexOf('deliver', calls.indexOf('deliver') + 1);
    assert.deepEqual(calls.slice(resumed, resumed + 3),
      ['deliver', 'deliver', 'pre-accept-hooks']);
    const progressEvent = events.indexOf('deliver', events.indexOf('deliver') + 1);
    assert.deepEqual(events.slice(progressEvent, progressEvent + 3),
      ['deliver', 'inspect', 'deliver']);
    assert.equal(receipts.accept.outcome, 'accepted');
  });
}
