import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectLocalWork } from '../src/local-work-observation.mjs';
import { localReportReader } from '../src/local-work-reports.mjs';
import { coordinateDiagnosis } from '../src/diagnosis-coordinator.mjs';
import { fixture, identity, subject } from './local-work-fixture.mjs';

test('observation adds a diagnosis summary without acquiring work', async () => {
  const f = fixture();
  const diagnosis = { status: 'reported', reports: [{ reference: 'report:retained' }] };
  f.local.diagnosis = diagnosis;
  const result = await collectLocalWork('private', { reader: f.reader,
    discover: f.discover, evidenceFactory: f.evidenceFactory });
  assert.equal(result.status, 'observed');
  assert.equal(result.subject.id, subject.id);
  assert.equal(result.work[0].issue.id, identity.id);
  assert.deepEqual(result.work[0].diagnosis, diagnosis);
  assert.equal(result.work[0].waiting.value, 'no-admission-observed');
});

test('retained second reports are subject-scoped and observation creates no files',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'diagnosis-history-'));
    try {
      const host = { uid: process.getuid(), stateRoot: root,
        confirm: async () => {}, subjectId: subject.id };
      const input = { host, subject, issue: identity,
        attempt: { stage: 'deliver', id: '12345678-1234-1234-1234-123456789012' },
        evidenceId: 'a'.repeat(64), evidence: [
          { reference: 'report:' + 'b'.repeat(64),
            observedAt: '2026-11-18T08:00:00.000Z',
            confirmed: ['EXACT_CONTAINER_STATE'] },
          { reference: 'report:' + 'c'.repeat(64),
            observedAt: '2026-11-18T08:01:00.000Z',
            confirmed: ['CORE_ADMISSION_OR_SETTLEMENT_CODE'] },
        ] };
      const completed = await coordinateDiagnosis(input, {
        prepare: async () => async () => ({
        terminated: true, report: { explanation: 'The cause remains unknown.',
          hypotheses: [], missing: ['Guest evidence is missing.'] },
      }) });
      const before = await readdir(join(root, 'diagnoses'));
      const reader = localReportReader(host);
      const history = await reader.diagnoses(identity);
      assert.equal(history.results[0].explanation, 'The cause remains unknown.');
      assert.equal(history.results[0].executionAuthority, false);
      const { status, ...retained } = history.results[0];
      assert.equal(status, 'reported');
      assert.deepEqual(retained, completed.report);
      assert.deepEqual(retained.confirmed,
        input.evidence.flatMap(item => item.confirmed));
      assert.deepEqual(retained.sourceReports,
        input.evidence.map(item => item.reference));
      assert.deepEqual(retained.sourceTimes,
        input.evidence.map(item => item.observedAt));
      assert.equal(retained.confidence, 'attributed');
      assert.deepEqual(retained.hypotheses, []);
      assert.deepEqual(retained.missing, ['Guest evidence is missing.']);
      assert.equal(retained.invocationId, completed.report.invocationId);
      assert.notEqual(retained.invocationId, input.attempt.id);
      const cached = await coordinateDiagnosis(input, {
        prepare: () => { throw new Error('Must reuse the retained report'); },
      });
      assert.deepEqual(cached.report, retained);
      const foreign = await localReportReader({ ...host, subjectId: 8 })
        .diagnoses(identity);
      assert.deepEqual(foreign.results, []);
      await reader.confirm();
      assert.deepEqual(await readdir(join(root, 'diagnoses')), before);
      const path = join(root, 'diagnoses', before[0]);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      for (const changes of [
        { sourceReports: ['https://unrelated.example/private'] },
        { sourceReports: ['/private/evidence'] },
        { sourceTimes: ['invalid'] },
        { sourceTimes: [] },
        { confirmed: ['private/path'] },
        { subjectId: 8 },
      ]) {
        const changed = structuredClone(saved);
        Object.assign(changed.response.report, changes);
        await writeFile(path, JSON.stringify(changed));
        await assert.rejects(localReportReader(host).diagnoses(identity),
          { code: 'UNTRUSTED_REPORT' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
