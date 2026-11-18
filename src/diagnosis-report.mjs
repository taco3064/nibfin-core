import { digest, requireThat } from './identity.mjs';
import { safeDiagnosisResult } from './diagnosis-plan.mjs';

// Both immediate responses and historical reads expose the same bounded report.
// Provenance comes from Core's selected evidence, never from the diagnosis Agent.
export function projectDiagnosisReport(report, record) {
  const timestamp = value => typeof value === 'string' && value.length <= 64 &&
    Number.isFinite(Date.parse(value));
  const list = (values, limit, valid) => Array.isArray(values) &&
    values.length <= limit && values.every(valid);
  requireThat(report && report.invocationId === record.invocationId &&
    report.evidenceId === record.evidenceId &&
    report.subjectId === record.subjectId &&
    digest(report.issue) === digest(record.issue) &&
    digest(report.attempt) === digest(record.attempt) &&
    timestamp(report.observedAt) &&
    list(report.confirmed, 32, value => typeof value === 'string' &&
      /^[A-Z][A-Z0-9_]{0,95}$/.test(value)) &&
    list(report.sourceReports, 160, value => typeof value === 'string' &&
      /^report:[a-f0-9]{64}$/.test(value)) &&
    list(report.sourceTimes, 160, value => value === null || timestamp(value)) &&
    report.sourceReports.length === report.sourceTimes.length,
  'UNTRUSTED_REPORT');
  const result = safeDiagnosisResult({ explanation: report.explanation,
    hypotheses: report.hypotheses, missing: report.missing });
  return { ...result, invocationId: record.invocationId,
    evidenceId: record.evidenceId, subjectId: record.subjectId,
    issue: record.issue, attempt: record.attempt, observedAt: report.observedAt,
    confirmed: [...report.confirmed], sourceReports: [...report.sourceReports],
    sourceTimes: [...report.sourceTimes] };
}
