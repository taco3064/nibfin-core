import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStage, stages } from '../src/stages.mjs';
import { digest } from '../src/identity.mjs';
import { now } from './approval-fixture.mjs';
import { stageFixture } from './stage-fixture.mjs';

test('each lifecycle stage requires and accepts its own complete trusted evidence chain', () => {
  for (const stage of Object.keys(stages)) {
    const result = decideStage(stage, stageFixture(stage), now);
    assert.equal(result.status, 'allowed', `${stage}: ${result.code}`);
    assert.match(result.requestHash, /^[a-f0-9]{64}$/);
  }
});

test('authority, source, scope, dependency, route, job and isolation failures deny every stage', () => {
  const changes = [
    c => { c.approval.record.operations = []; }, c => { c.approval.approvalHash = 'forged'; },
    c => { c.source = { ...c.source, commit: '9'.repeat(40) }; }, c => { c.issue.node_id = 'I_foreign'; },
    c => { c.issue.body += 'Edited'; }, c => { c.dependencies.ready = false; },
    c => { c.dependencies.identities = [{ id: 'other' }]; }, c => { c.runner.jobId++; },
    c => { c.route.userId++; }, c => { c.isolation.writerStatus = 'unknown'; },
    c => { c.execution.actorId = 99; }, c => { c.issue.labels = [{ name: 'delivered' }]; },
  ];
  for (const stage of Object.keys(stages)) for (const change of changes) {
    const c = stageFixture(stage); change(c); assert.equal(decideStage(stage, c, now).status, 'denied', stage);
  }
});

test('self-validation, self-acceptance, forged publication and old Candidate evidence reject', () => {
  const cases = [
    ['publish-shape', c => { c.receipts['validate-shape'].execution.sessionId = c.receipts.shape.execution.sessionId; }],
    ['deliver', c => { delete c.receipts['publish-shape']; }],
    ['deliver', c => { c.receipts['publish-shape'].authorized = true; }],
    ['commit-pr', c => { c.receipts.accept.execution.sessionId = c.receipts.deliver.execution.sessionId; }],
    ['accept', c => { c.candidate.tree = '9'.repeat(40); }],
    ['accept', c => { c.receipts['pre-accept-hooks'].outcome = 'blocked'; }],
    ['accept', c => { c.candidate.paths = ['.github/workflows/executor.yml']; }],
    ['accept', c => { c.candidate.artifacts = [{ path: 'unapproved' }]; }],
    ['merge', c => { c.receipts['review-pr'].execution.sessionId = c.receipts.deliver.execution.sessionId; }],
    ['merge', c => { c.receipts['review-pr'].findings = ['Unresolved defect']; }],
    ['close', c => { c.pr.merged = false; }],
    ['close', c => { delete c.receipts.merge; }],
  ];
  for (const [stage, change] of cases) { const c = stageFixture(stage); change(c); assert.equal(decideStage(stage, c, now).status, 'denied', stage); }
});

test('green unrelated checks, stale PR heads and foreign test-merge parents cannot authorize review or merge', () => {
  for (const stage of ['review-pr', 'merge']) {
    for (const change of [c => { c.pr.head = '9'.repeat(40); }, c => { c.ci.head = '9'.repeat(40); },
      c => { c.ci.checks[0].conclusion = 'neutral'; }, c => { c.ci.provenanceHash = ''; },
      c => { c.ci.testedSha = '9'.repeat(40); }, c => { c.ci.base = '9'.repeat(40); }]) {
      const c = stageFixture(stage); change(c); assert.equal(decideStage(stage, c, now).status, 'denied');
    }
  }
  const c = stageFixture('merge');
  c.ci.testedSha = c.pr.mergePreview; c.ci.checks[0].testedSha = c.pr.mergePreview; c.ci.parents = [c.pr.base, c.pr.head];
  c.receipts['review-pr'].artifacts.ciHash = digest(c.ci);
  assert.equal(decideStage('merge', c, now).status, 'allowed');
  c.ci.parents.reverse(); c.receipts['review-pr'].artifacts.ciHash = digest(c.ci);
  assert.equal(decideStage('merge', c, now).code, 'FOREIGN_TEST_MERGE');
});


test('fresh main is required and a parallel merge forces Deliver rebase before any final acceptance', () => {
  for (const stage of ['pre-accept-hooks', 'accept', 'post-accept-hooks', 'commit-pr', 'review-pr', 'merge']) {
    const c = stageFixture(stage); c.main.head = 'a'.repeat(40);
    assert.equal(decideStage(stage, c, now).code, 'REBASE_REQUIRED');
  }
  const c = stageFixture('merge'); delete c.main;
  assert.equal(decideStage('merge', c, now).code, 'CURRENT_MAIN_REQUIRED');
});

test('missing historical Shape receipts permit fresh independent revalidation, never direct delivery', () => {
  const shape = stageFixture('shape'); shape.issue.body = shape.shape.body; shape.issue.labels.push({ name: 'shaped' });
  shape.receipts = {};
  assert.equal(decideStage('shape', shape, now).status, 'allowed');
  const delivery = stageFixture('deliver'); delivery.receipts = {};
  assert.equal(decideStage('deliver', delivery, now).status, 'denied');
  for (const stage of ['validate-shape', 'publish-shape']) {
    const c = stageFixture(stage); c.issue.body = c.shape.body; c.issue.labels.push({ name: 'shaped' });
    assert.equal(decideStage(stage, c, now).status, 'allowed');
    c.issue.body += 'Changed';
    assert.equal(decideStage(stage, c, now).code, 'CURRENT_SHAPE_REVALIDATION_CHANGED');
  }
  const review = stageFixture('merge');
  assert.notEqual(review.receipts['review-pr'].execution.sessionId, review.receipts.shape.execution.sessionId);
  assert.equal(decideStage('merge', review, now).status, 'allowed');
});
