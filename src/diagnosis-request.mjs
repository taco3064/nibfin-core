import { stages } from './stages.mjs';
import { repoPath, issuePath } from './github-read.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { observationReader } from './local-work-native.mjs';
import { discoverLocalHost } from './local-work-host.mjs';
import { subjectIdentity } from './local-work-values.mjs';
import { localReportReader, selectReports, reportEvidenceIdentity }
  from './local-work-reports.mjs';
import { coordinateDiagnosis } from './diagnosis-coordinator.mjs';

export function validateDiagnosisRequest(value) {
  requireThat(value && Object.keys(value).sort().join(',') ===
    'attempt,diagnose,issueNumber,repository,token' &&
    typeof value.token === 'string' && value.token.length > 0 &&
    value.token.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value.token) &&
    typeof value.repository === 'string' && value.repository.length <= 201 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) &&
    !value.repository.split('/').some(part => part === '.' || part === '..') &&
    isId(value.issueNumber) && typeof value.diagnose === 'boolean' &&
    value.attempt && Object.keys(value.attempt).sort().join(',') === 'id,stage' &&
    /^[a-f0-9-]{36}$/.test(value.attempt.id) &&
    typeof value.attempt.stage === 'string' &&
    (value.attempt.stage === 'continue' || Object.hasOwn(stages, value.attempt.stage)),
  'INVALID_DIAGNOSIS_REQUEST');
}

// Controlled fixture seam. Public callers cannot select dependencies or paths.
export async function collectDiagnosis(request, {
  reader = observationReader(request.token), discover = discoverLocalHost,
  reportsFactory = localReportReader, coordinate = coordinateDiagnosis,
} = {}) {
  validateDiagnosisRequest(request);
  const response = (status, code) => ({ schemaVersion: 1, status, code,
    executionAuthority: false });
  let subject;
  try { subject = subjectIdentity(await reader.get('/user')); }
  catch { return response('denied', 'AUTHENTICATION_DENIED'); }
  let host, issue, selected, reports, reportReader, diagnoses;
  const snapshots = new Map();
  const missingNative = new Set();
  const deadline = Date.now() + 20000;
  let requests = 0;
  const get = async path => {
    requireThat(++requests <= 160 && Date.now() < deadline, 'OBSERVATION_LIMIT');
    const value = await reader.get(path);
    requireThat(!snapshots.has(path) || digest(value) === snapshots.get(path),
      'OBSERVATION_CHANGED');
    snapshots.set(path, digest(value));
    return value;
  };
  const optionalNative = async path => {
    try { return await get(path); }
    catch (error) {
      if (error.status !== 404) throw error;
      missingNative.add(path);
      return null;
    }
  };
  try {
    host = await discover(subject);
    const route = host.routes.find(item => item.repository === request.repository);
    requireThat(route && host.errors.length === 0, 'DIAGNOSIS_ACCESS_DENIED');
    const repository = await get(repoPath(route.repository));
    requireThat(repository.id === route.repositoryId &&
      repository.full_name === route.repository && repository.private === false,
    'DIAGNOSIS_ACCESS_DENIED');
    const candidate = { ...route, number: request.issueNumber };
    const native = await get(issuePath(candidate));
    requireThat(native.number === candidate.number &&
      /^I_[A-Za-z0-9_-]+$/.test(native.node_id) && !native.pull_request &&
      native.url === `https://api.github.com${issuePath(candidate)}` &&
      native.assignees?.some(item => item.id === subject.id),
    'DIAGNOSIS_ACCESS_DENIED');
    issue = { ...candidate, id: native.node_id };
    reportReader = reportsFactory({ ...host, subjectId: subject.id });
    reports = await reportReader.reports(issue);
    selected = selectReports(reports, request.attempt);
    diagnoses = await reportReader.diagnoses?.(issue) ?? { status: 'unavailable' };
    if (!selected.length) return response('insufficient-evidence',
      'ATTEMPT_REPORT_UNAVAILABLE');
    // Historical identity is read from retained Core evidence, never from a path
    // or a caller-supplied execution repository/run/job tuple.
    for (const { report } of selected) {
      if (report.workflow) {
        const w = report.workflow;
        const base = repoPath(issue.repository);
        const run = await optionalNative(`${base}/actions/runs/${w.runId}`);
        const job = await optionalNative(`${base}/actions/jobs/${w.jobId}`);
        requireThat(!run || !job || run.repository?.id === issue.repositoryId &&
          run.head_sha === w.head && job.run_id === w.runId &&
          job.run_attempt === w.attempt && job.id === w.jobId &&
          job.conclusion === w.conclusion, 'DIAGNOSIS_ACCESS_DENIED');
      }
      const n = report.binding.native;
      if (!n.repository || !isId(n.jobId) || !isId(n.runId) || !isId(n.attempt))
        continue;
      const binding = host.bindings.find(item =>
        item.expected.repositoryId === n.repositoryId &&
        item.expected.repository === n.repository &&
        item.routes.some(route => route.repositoryId === issue.repositoryId));
      requireThat(binding, 'DIAGNOSIS_ACCESS_DENIED');
      const base = repoPath(n.repository);
      const run = await optionalNative(`${base}/actions/runs/${n.runId}`);
      const job = await optionalNative(`${base}/actions/jobs/${n.jobId}`);
      if (!run || !job) continue;
      requireThat(run.id === n.runId && run.repository?.id === n.repositoryId &&
        job.id === n.jobId && job.run_id === n.runId &&
        job.run_attempt === n.attempt && job.runner_id === n.runnerId &&
        run.repository.full_name === n.repository &&
        run.head_repository?.id === n.repositoryId &&
        run.head_repository.full_name === n.repository &&
        run.workflow_id === (n.workflowId ?? binding.expected.workflowId) &&
        run.path === (n.workflowPath ?? binding.expected.workflowPath) &&
        (!n.sourceCommit || run.head_sha === n.sourceCommit) &&
        job.head_sha === run.head_sha &&
        (!n.runnerName || job.runner_name === n.runnerName) &&
        run.actor?.id === subject.id && run.triggering_actor?.id === subject.id,
      'DIAGNOSIS_ACCESS_DENIED');
    }
    await host.confirm(); await reportReader.confirm();
    for (const [path, hash] of snapshots)
      requireThat(digest(await reader.get(path)) === hash, 'OBSERVATION_CHANGED');
    for (const path of missingNative) {
      let absent = false;
      try { await get(path); } catch (error) { absent = error.status === 404; }
      requireThat(absent, 'OBSERVATION_CHANGED');
    }
    requireThat(subjectIdentity(await reader.get('/user')).id === subject.id,
      'DIAGNOSIS_ACCESS_DENIED');
  } catch (error) {
    if (error.code === 'ENOENT')
      return response('insufficient-evidence', 'ATTEMPT_REPORT_UNAVAILABLE');
    return response('denied', error.code === 'OBSERVATION_CHANGED'
      ? 'OBSERVATION_CHANGED' : 'DIAGNOSIS_ACCESS_DENIED');
  }
  const history = reports.map(({ projected }) => ({
    ...projected, selected: projected.binding.admissionId === request.attempt.id,
    current: false,
    missing: [...projected.missing, ...(missingNative.size &&
      projected.binding.admissionId === request.attempt.id
      ? ['NATIVE_JOB_EVIDENCE_UNAVAILABLE'] : [])],
    newerAttempts: reports.filter(item =>
      item.report.binding.stage === projected.binding.stage &&
      item.report.binding.admissionId !== projected.binding.admissionId &&
      Date.parse(item.report.observedAt) > Date.parse(projected.observedAt))
      .map(item => item.report.binding.admissionId),
  }));
  if (!request.diagnose) {
    const result = { schemaVersion: 1, status: 'reported',
      reports: history, diagnoses, executionAuthority: false };
    return Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024
      ? result : response('insufficient-evidence', 'DIAGNOSIS_OUTPUT_LIMIT');
  }
  // Only sanitized bounded projections enter the second model invocation.
  const evidence = selected.map(item => ({ ...item.projected,
    missing: [...item.projected.missing, ...(missingNative.size
      ? ['NATIVE_JOB_EVIDENCE_UNAVAILABLE'] : [])],
  }));
  if (Buffer.byteLength(JSON.stringify(evidence)) > 32 * 1024)
    return response('insufficient-evidence', 'DIAGNOSIS_EVIDENCE_LIMIT');
  return coordinate({ host, subject, issue, attempt: request.attempt,
    evidence, evidenceId: digest({ reports: reportEvidenceIdentity(selected),
      missingNative: [...missingNative].sort() }) });
}

export async function requestLocalDiagnosis(request) {
  try {
    validateDiagnosisRequest(request);
    return await collectDiagnosis(request);
  } catch (error) {
    const invalid = error.code === 'INVALID_DIAGNOSIS_REQUEST';
    return { schemaVersion: 1, status: invalid ? 'denied' : 'unresolved-effect',
      code: invalid ? error.code : 'DIAGNOSIS_UNAVAILABLE',
      executionAuthority: false };
  }
}
