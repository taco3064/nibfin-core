import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { projectDiagnosisReport } from './diagnosis-report.mjs';

// The namespace and record subject establish ownership. A locator from a caller
// or an Agent is never used as a filename. Unknown in-flight records stay unknown.
export async function diagnosisHistory(host, issue, { readJSON, entries }) {
  const root = join(host.stateRoot, 'diagnoses');
  let names;
  try { names = await entries(root, host.uid); }
  catch (error) {
    return { status: 'unavailable', code: error.code === 'ENOENT'
      ? 'DIAGNOSIS_HISTORY_UNAVAILABLE' : 'DIAGNOSIS_HISTORY_INACCESSIBLE' };
  }
  const results = [];
  const files = names.filter(name => /^[a-f0-9]{64}\.(?:json|inflight)$/.test(name));
  for (const name of files) {
    const value = await readJSON(join(root, name));
    const record = value.record ?? value;
    if (record.subjectId !== host.subjectId ||
        digest(record.issue) !== digest(issue)) continue;
    requireThat(record.key === name.split('.')[0] &&
      record.key === digest({ subjectId: record.subjectId, issue: record.issue,
        attempt: record.attempt, evidenceId: record.evidenceId }),
    'UNTRUSTED_REPORT');
    if (name.endsWith('.inflight')) {
      results.push({ status: 'unresolved-effect', attempt: record.attempt,
        invocationId: record.invocationId, executionAuthority: false });
      continue;
    }
    const report = value.response?.report;
    if (!report) continue;
    results.push({ status: 'reported', ...projectDiagnosisReport(report, record) });
  }
  return { status: 'observed', results };
}
