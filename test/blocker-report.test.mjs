import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBlockerReport, projectBlockerReport, terminationObservation }
  from '../src/blocker-report.mjs';
import { saveBlockerReport } from '../src/blocker-report-store.mjs';
import { localReportReader, selectReports } from '../src/local-work-reports.mjs';
import { fixture, identity } from './local-work-fixture.mjs';

function context() {
  const value = fixture().context;
  value.execution.sessionId = '87654321-1234-1234-1234-123456789012';
  value.runner.repository = 'example/pool';
  return value;
}
function agentReport(value = context()) {
  return makeBlockerReport(value, 'deliver', { result: {
    rootCause: 'The required native check is unavailable.',
    failureClass: 'external_failure', blockingFindings: ['Native evidence is absent.'],
    evidenceReferences: [
      'https://github.com/example/project/issues/7',
      'https://github.com/other/private/actions/runs/100?token=secret',
      'file:///etc/passwd', 'evidence:' + 'a'.repeat(64),
      'https://github.com/example/pool/actions/runs/999',
    ],
  } });
}

test('agent cause remains attributed and references require subject ownership', () => {
  const report = agentReport();
  assert.equal(report.rootCause, 'The required native check is unavailable.');
  assert.equal(report.failureClass, 'external_failure');
  const projected = projectBlockerReport(report, { issue: identity, subjectId: 5 });
  assert.equal(projected.confidence, 'attributed');
  assert.equal(projected.executionAuthority, false);
  assert.equal(projected.rootCause, report.rootCause);
  assert.deepEqual(projected.references,
    ['https://github.com/example/project/issues/7']);
  assert.throws(() => projectBlockerReport(report,
    { issue: identity, subjectId: 6 }));
});

test('exit 137 alone does not establish OOM or an implementation failure', () => {
  const value = context();
  const observation = terminationObservation({ Id: 'a'.repeat(64),
    State: { Running: false, ExitCode: 137, OOMKilled: false } },
  value.execution.id, '2026-11-18T12:00:00Z');
  const report = makeBlockerReport(value, 'deliver', { producer: 'core-native',
    termination: observation, code: 'PROCESS_FAILED' });
  assert.equal(report.failureClass, null);
  assert.equal(report.rootCause, null);
  assert.equal(report.termination.exitCode, 137);
  assert.ok(!report.confirmed.includes('EXACT_CONTAINER_OOM'));
  observation.oomKilled = true;
  const oom = makeBlockerReport(value, 'deliver', { producer: 'core-native',
    termination: observation });
  assert.ok(oom.confirmed.includes('EXACT_CONTAINER_OOM'));
  assert.ok(oom.missing.includes('GUEST_AND_HOST_MEMORY_CAUSE_UNAVAILABLE'));
});

test('admission reports leave absent Agent identity unknown', () => {
  const report = makeBlockerReport(context(), 'deliver', { producer: 'core-native',
    agentStarted: false, code: 'ADMISSION_CHANGED' });
  assert.equal(report.binding.executionId, null);
  assert.equal(report.binding.sessionId, null);
  assert.equal(report.binding.admissionId, context().execution.id);
  assert.equal(report.binding.native.jobId, 200);
});

test('immutable attempt history can be read without live jobs or stage pointers',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'blocker-reports-'));
    try {
      const receipts = join(root, 'issue-2-7', 'receipts');
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      const first = agentReport();
      await saveBlockerReport(receipts, first);
      const secondContext = context();
      secondContext.execution.id = '22222222-1234-1234-1234-123456789012';
      await saveBlockerReport(receipts, agentReport(secondContext));
      const reader = localReportReader({ stateRoot: root,
        uid: process.getuid(), subjectId: 5 });
      const reports = await reader.reports(identity);
      assert.equal(reports.length, 2);
      assert.equal(selectReports(reports, { stage: 'deliver',
        id: first.binding.admissionId }).length, 1);
      await reader.confirm();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('workflow failures retain the corresponding native result without logs', () => {
  const value = context();
  value.ciFailure = { runId: 300, attempt: 2, jobId: 400, number: 20,
    head: 'a'.repeat(40), base: 'b'.repeat(40), conclusion: 'failure',
    url: 'https://github.com/example/project/actions/runs/300/job/400',
    check: 'private log text', step: 'private step', logsUnavailable: true };
  const report = makeBlockerReport(value, 'deliver', { producer: 'core-native',
    code: 'CI_REQUIRED_CHECK_FAILED' });
  assert.equal(report.workflow.runId, 300);
  assert.equal(report.workflow.attempt, 2);
  assert.equal(report.workflow.conclusion, 'failure');
  assert.equal(report.workflow.check, undefined);
  assert.ok(report.confirmed.includes('AUTHORITATIVE_WORKFLOW_RESULT'));
  assert.ok(report.missing.includes('WORKFLOW_LOG_UNAVAILABLE'));
  assert.equal(report.failureClass, null);
});

test('private attributed cause stays precise when public text needs redaction', () => {
  const cause = 'A private path /controller/evidence cannot be read. ' + 'x'.repeat(2100);
  const report = makeBlockerReport(context(), 'deliver', { result: {
    rootCause: cause, failureClass: 'authority_gap',
    blockingFindings: ['Inspect private evidence.'],
    evidenceReferences: ['/controller/private-evidence'],
  } });
  assert.equal(report.rootCause, cause);
  assert.deepEqual(report.agentEvidenceReferences, ['/controller/private-evidence']);
  const projected = projectBlockerReport(report, { issue: identity, subjectId: 5 });
  assert.equal(projected.rootCause, null);
  assert.ok(projected.missing.includes('PUBLIC_CAUSE_TEXT_UNAVAILABLE'));
  assert.ok(!JSON.stringify(projected).includes('/controller'));
});
