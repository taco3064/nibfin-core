import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateCorrectionRequired } from '../src/candidate-correction.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';
import { digest } from '../src/identity.mjs';

const blocked = () => ({ stage: 'accept', outcome: 'blocked',
  findings: ['The fixture ancestor has UID 65534 instead of root or Controller.'],
  report: { producer: 'agent', failureClass: 'external_failure',
    termination: { running: false, exitCode: 0 } } });

test('recorded fixture blockers return to the Candidate author, not native failures',
  () => {
    assert.equal(candidateCorrectionRequired(blocked()), true);
    for (const mutate of [
      r => { r.report.producer = 'core-native'; },
      r => { r.report.termination.running = true; },
      r => { r.report.termination.exitCode = 1; },
      r => { r.report.failureClass = 'authority_gap'; },
      r => { delete r.report.termination; },
      r => { r.stage = 'shape'; },
    ]) {
      const receipt = blocked();
      mutate(receipt);
      assert.equal(candidateCorrectionRequired(receipt), false);
    }
  });

async function replay(saved) {
  const receipts = {}, objects = {}, calls = [];
  let candidate, rejected = saved, revision = 0;
  const store = { load: async () => structuredClone(receipts),
    get: async hash => objects[hash] };
  const append = receipt => {
    receipts[receipt.stage] = receipt;
    const hash = digest(receipt);
    objects[hash] = receipt;
    return hash;
  };
  const execute = async stage => {
    calls.push(stage);
    if (stage === 'deliver') {
      candidate = digest({ revision: ++revision });
      objects[candidate] = { repository: 'example/core', repositoryId: 10,
        issueId: 'I_target', changes: String(revision), paths: ['test/fixture.mjs'],
        obligations: { artifacts: [], hooks: [] }, artifacts: [], hookSources: [] };
    }
    const receipt = { stage, outcome: stageSuccess[stage],
      artifacts: candidate ? { candidateHash: candidate } : {} };
    if (stage === 'accept' && !rejected) {
      rejected = true;
      Object.assign(receipt, blocked());
    }
    const receiptHash = append(receipt);
    return { stage, receiptHash,
      status: receipt.outcome === 'blocked' ? 'denied' : 'completed',
      code: receipt.outcome === 'blocked' ? 'STAGE_REQUIRES_CORRECTION' : 'DONE' };
  };
  if (saved) {
    for (const stage of ['shape', 'validate-shape', 'publish-shape', 'deliver',
      'pre-accept-hooks']) await execute(stage);
    append({ ...blocked(), artifacts: { candidateHash: candidate } });
    calls.length = 0;
  }
  const options = { store, execute, inspect: async () => {}, wait: async () => {} };
  const result = await continueStages(options);
  assert.equal(result.stage, 'close');
  assert.equal(calls.filter(stage => stage === 'accept').length, saved ? 1 : 2);
  assert.equal(calls.filter(stage => stage === 'deliver').length, saved ? 1 : 2);
  assert.ok(calls.indexOf('deliver') < calls.indexOf('accept'));
  const publications = calls.filter(stage => stage === 'commit-pr').length;
  assert.equal(publications, 1);
  assert.equal((await continueStages(options)).code, 'DELIVERY_ALREADY_RECORDED');
  assert.equal(calls.filter(stage => stage === 'commit-pr').length, publications);
}

test('historical Accept blocker resumes through Deliver and fresh acceptance',
  () => replay(true));
test('a new settled Accept blocker enters the same correction path',
  () => replay(false));
