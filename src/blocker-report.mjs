import { workflowObservation } from './blocker-workflow.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { localInterruptionSummary, projectLocalInterruption }
  from './local-deliver-interruption.mjs';

const classes = ['none', 'implementation_defect', 'shape_defect',
  'authority_gap', 'external_failure'];
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9-]{36}$/.test(value);
const scalarId = value => isId(value) ? value : null;
const text = value => typeof value === 'string' ? value : null;

// Public text is deliberately not copied from private exceptions, logs or contexts.
// Agent prose remains private evidence; public summaries identify its attribution.
export function reportReferences(values, binding) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => {
    if (typeof value !== 'string' || value.length > 512) return false;
    // Unqualified opaque locators from an Agent cannot prove ownership.
    // The projection supplies the report's own Controller-bound reference.
    const repositories = [binding.issue.repository, binding.native.repository]
      .filter(Boolean);
    return repositories.some(repository => {
      const prefix = `https://github.com/${repository}/`;
      if (!value.startsWith(prefix)) return false;
      const path = value.slice(prefix.length);
      if (/^(?:issues|pull)\/[1-9]\d*$/.test(path)) return true;
      const native = binding.native;
      return repository === native.repository &&
        [`actions/runs/${native.runId}`,
          `actions/runs/${native.runId}/job/${native.jobId}`].includes(path);
    });
  }))].slice(0, 16);
}

export function reportBinding(context, stage, { agentStarted = true } = {}) {
  const issue = context.approval.record.issue;
  requireThat(isId(issue.repositoryId) && isId(issue.number) &&
    typeof issue.id === 'string' && /^I_[A-Za-z0-9_-]+$/.test(issue.id) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(issue.repository),
  'INVALID_REPORT_SUBJECT');
  const runner = context.runner ?? {};
  const execution = context.execution ?? {};
  const repository = runner.repository;
  const nativeRepository = typeof repository === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    repository.length <= 201 ? repository : null;
  return { issue: { repository: issue.repository, repositoryId: issue.repositoryId,
    number: issue.number, id: issue.id }, stage,
  subjectId: scalarId(execution.actorId ?? runner.memberId),
  executionId: agentStarted && uuid(execution.id) ? execution.id : null,
  sessionId: agentStarted && uuid(execution.sessionId) ? execution.sessionId : null,
  native: { repository: nativeRepository,
  repositoryId: scalarId(runner.repositoryId), runId: scalarId(runner.runId),
  attempt: scalarId(runner.attempt), jobId: scalarId(runner.jobId),
  runnerId: scalarId(runner.runnerId),
  runnerName: typeof runner.runnerName === 'string' &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(runner.runnerName) ? runner.runnerName : null,
  sourceCommit: isSha(runner.sourceCommit) ? runner.sourceCommit : null,
  workflowId: scalarId(runner.workflowId),
  workflowPath: typeof runner.workflowPath === 'string' &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(runner.workflowPath)
    ? runner.workflowPath : null },
  admissionId: uuid(execution.id) ? execution.id : null };
}

export function terminationObservation(container, executionId, at) {
  const state = container?.State;
  requireThat(uuid(executionId) && /^[a-f0-9]{64}$/.test(container?.Id) &&
    typeof state?.Running === 'boolean' &&
    typeof at === 'string' && at.length <= 64 && Number.isFinite(Date.parse(at)),
  'INVALID_TERMINATION_OBSERVATION');
  return { owner: 'docker-inspect', executionId, containerId: container.Id,
    observedAt: at, running: state.Running,
    exitCode: Number.isInteger(state.ExitCode) &&
      state.ExitCode >= -1 && state.ExitCode <= 255 ? state.ExitCode : null,
    oomKilled: typeof state.OOMKilled === 'boolean' ? state.OOMKilled : null };
}

export function makeBlockerReport(context, stage, {
  result, termination = null, code = null, producer = 'agent', agentStarted = true,
  at = new Date().toISOString(), workflow = context.ciFailure, localInterruption,
}) {
  const binding = reportBinding(context, stage, { agentStarted });
  requireThat(['agent', 'core-native', 'diagnosis'].includes(producer) &&
    (!code || /^[A-Z][A-Z0-9_]{0,95}$/.test(code)) &&
    typeof at === 'string' && at.length <= 64 && Number.isFinite(Date.parse(at)),
  'INVALID_REPORT_PRODUCER');
  const local = producer === 'core-native' && stage === 'deliver' &&
    code === 'LOCAL_DELIVER_INTERRUPTED'
    ? projectLocalInterruption(localInterruption) : null;
  const report = { schemaVersion: 1, kind: 'blocker-report', binding, producer,
    observedAt: at, executionAuthority: false,
    rootCause: local ? localInterruptionSummary(local) : text(result?.rootCause),
    failureClass: classes.includes(result?.failureClass) ? result.failureClass : null,
    findings: (result?.blockingFindings ?? []).map(text).filter(Boolean),
    agentEvidenceReferences: result?.evidenceReferences ?? [],
    references: reportReferences(result?.evidenceReferences, binding),
    confirmed: [], hypotheses: [], missing: [], code };
  if (producer === 'core-native' && code)
    report.confirmed.push('CORE_ADMISSION_OR_SETTLEMENT_CODE');
  if (local) {
    report.localInterruption = local;
    report.confirmed.push('LOCAL_OPERATION_PHASE');
    if (local.cause) report.confirmed.push('LOCAL_OPERATION_CAUSE_CODE');
    else report.missing.push('LOCAL_OPERATION_CAUSE_UNAVAILABLE');
  }
  if (producer === 'agent') {
    report.hypotheses = report.rootCause ? ['AGENT_ATTRIBUTED_EXPLANATION'] : [];
    report.missing.push('INDEPENDENT_CAUSE_CONFIRMATION_UNAVAILABLE');
  }
  if (termination) {
    // The adapter owns and validates this observation before container removal.
    if (termination.owner === 'docker-inspect') {
      requireThat(termination.executionId === binding.admissionId,
        'REPORT_EXECUTION_MISMATCH');
      report.termination = terminationObservation({ Id: termination.containerId,
        State: { Running: termination.running, ExitCode: termination.exitCode,
          OOMKilled: termination.oomKilled } }, binding.admissionId,
      termination.observedAt);
      report.confirmed.push(termination.oomKilled === true
        ? 'EXACT_CONTAINER_OOM' : 'EXACT_CONTAINER_STATE');
      report.missing.push('GUEST_AND_HOST_MEMORY_CAUSE_UNAVAILABLE');
      if (termination.running || termination.exitCode === null)
        report.missing.push('FINAL_EXIT_STATE_UNAVAILABLE');
    } else if (termination.owner === 'vm-adapter' &&
        termination.executionId === binding.admissionId &&
        /^[A-Z][A-Z0-9_]{0,95}$/.test(termination.code)) {
      report.termination = { owner: 'vm-adapter',
        executionId: termination.executionId, code: termination.code };
      report.confirmed.push('VM_ADAPTER_CODE');
    }
  }
  report.workflow = workflowObservation(workflow, binding.issue);
  if (report.workflow) {
    report.confirmed.push('AUTHORITATIVE_WORKFLOW_RESULT');
    if (report.workflow.logsUnavailable) report.missing.push('WORKFLOW_LOG_UNAVAILABLE');
  }
  if (!report.termination) report.missing.push('TERMINATION_TELEMETRY_UNAVAILABLE');
  if (!binding.native.sourceCommit) report.missing.push('NATIVE_SOURCE_UNAVAILABLE');
  report.id = digest(report);
  return report;
}

export function projectBlockerReport(report, expected) {
  requireThat(report?.kind === 'blocker-report' && report.schemaVersion === 1 &&
    report.id === digest(Object.fromEntries(Object.entries(report)
      .filter(([key]) => key !== 'id'))) &&
    digest(report.binding.issue) === digest(expected.issue) &&
    report.binding.subjectId === expected.subjectId, 'UNTRUSTED_REPORT');
  return { reference: `report:${report.id}`, binding: report.binding,
    producer: report.producer, observedAt: report.observedAt,
    failureClass: classes.includes(report.failureClass) ? report.failureClass : null,
    confidence: report.producer === 'agent' ? 'attributed' : 'observed',
    summary: report.producer === 'agent' ? 'Agent reported a blocker.'
      : 'Core retained a bounded native observation.',
    rootCause: safeReportText(report.rootCause),
    findings: report.findings.map(safeReportText).filter(Boolean).slice(0, 16),
    code: report.code, confirmed: report.confirmed,
    missing: [...report.missing, ...(report.rootCause &&
      safeReportText(report.rootCause) === null
      ? ['PUBLIC_CAUSE_TEXT_UNAVAILABLE'] : [])],
    termination: report.termination ?? null,
    workflow: workflowObservation(report.workflow, report.binding.issue),
    references: reportReferences(report.references, report.binding),
    ...(report.producer === 'core-native' && report.binding.stage === 'deliver' &&
      report.code === 'LOCAL_DELIVER_INTERRUPTED' ? {
        localInterruption: projectLocalInterruption(report.localInterruption),
      } : {}),
    executionAuthority: false };
}

// Free-form private evidence is retained for attribution, not returned verbatim.
// A public prose field excludes paths, URLs, JSON, shell snippets and token forms.
export function safeReportText(value) {
  if (typeof value !== 'string' || value.length > 2048 ||
      !/^[A-Za-z0-9 .,;:!?()'"\n_-]+$/.test(value) ||
      /[A-Za-z0-9_-]{40,}/.test(value) ||
      /\b(?:token|password|secret|credential|bearer)\s*:/i.test(value)) return null;
  return value;
}
