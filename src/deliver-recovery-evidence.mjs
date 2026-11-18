import { join } from 'node:path';
import { hostExecution } from './host-launcher.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { evidenceBinding, executionIdentity, samePublishedRequirements,
  stageAdmissionFields, stages } from './stages.mjs';
import { issueProgress } from './issue-progress.mjs';
import { RecoveryEvidenceSnapshot } from './recovery-evidence-snapshot.mjs';

const sameNative = (left, right) => ['runId', 'jobId', 'attempt', 'actorId']
  .every(key => left?.[key] === right?.[key]);

function retainedNative(execution, prior) {
  const matches = sameNative(execution, prior);
  requireThat(execution?.jobId !== prior.jobId || matches,
    'RECOVERY_EXECUTION_MISMATCH');
  return matches;
}

// Inputs from correction attempts have distinct deterministic identities. Bound
// the search like the retained scan; exceeding it is Pending, never permission
// to discard an attempt. A missing invocation supplies no stage or iteration.
function requireRetainedExecution(execution, native, stage) {
  const candidates = stage ? [stage] : Object.keys(stages).filter(name =>
    stages[name].role === execution.role);
  const expected = digest(execution);
  for (let iteration = 0; iteration < 4096; iteration++) {
    if (candidates.some(name => digest(hostExecution(native, name, iteration)) ===
      expected)) return;
  }
  requireThat(false, 'RECOVERY_EXECUTION_MISMATCH');
}

// A stage input proves entry, never the end of a shared continuation. Settlement
// covers every maintained stage and every correction iteration under this Job.
export async function deliverExecutionEvidence(context, fence, run, approval, store) {
  const { host, adopted } = context;
  const subject = adopted.isolation.issue;
  const issueRoot = join(host.stateRoot,
    `issue-${subject.repositoryId}-${subject.number}`);
  const root = join(issueRoot, 'agent');
  const snapshots = new RecoveryEvidenceSnapshot();
  const names = await snapshots.directory(root);
  const retained = [], localDeliverDecisions = [];
  const native = { ...adopted.runner, sourceCommit: run.head_sha,
    ...fence.binding.execution };
  const outer = ['shape', 'deliver'].some(stage =>
    digest(hostExecution(native, stage)) === digest(fence.binding.execution));
  requireThat(outer, 'RECOVERY_EXECUTION_MISMATCH');
  for (const name of names.filter(value => /^execution-[a-f0-9-]{36}$/.test(value))) {
    const executionRoot = join(root, name);
    await snapshots.directory(executionRoot);
    const directory = join(executionRoot, 'input');
    await snapshots.directory(directory, 'input-directory');
    const value = await snapshots.json(join(directory, 'context.json'));
    const invocation = await snapshots.json(join(directory, 'invocation.json'));
    if (!value) {
      // An orphan invocation cannot supply its missing native/Issue binding.
      requireThat(invocation === null, 'RECOVERY_CONTEXT_UNAVAILABLE');
      retained.push({ classification: 'absent-context', directory: name });
      continue;
    }
    requireThat(value.execution && value.runner, 'RECOVERY_EVIDENCE_INVALID');
    requireThat(name === `execution-${value.execution.id}` &&
      digest(value.approval?.record?.issue) === digest(approval.record.issue) &&
      sameNative({ ...value.runner, actorId: value.runner.memberId },
        value.execution), 'RECOVERY_EXECUTION_MISMATCH');
    const stage = invocation?.plan?.contract?.stage;
    if (invocation !== null) {
      requireThat(Object.hasOwn(stages, stage), 'RECOVERY_EVIDENCE_INVALID');
      executionIdentity(value.execution, stages[stage].role, value.runner.memberId);
    } else {
      // Context precedes invocation. Its identity is retained, but no stage or
      // correction iteration is inferred from the missing input.
      requireThat(Object.values(stages).some(definition =>
        definition.role === value.execution.role), 'RECOVERY_EXECUTION_MISMATCH');
      executionIdentity(value.execution, value.execution.role, value.runner.memberId);
    }
    if (!retainedNative(value.execution, fence.binding.execution)) continue;
    requireThat(
      value.runner.runnerId === adopted.runner.runnerId &&
      value.runner.repositoryId === adopted.runner.repositoryId &&
      value.runner.sourceCommit === run.head_sha &&
      value.isolation?.profile === adopted.isolation.kind,
    'RECOVERY_EXECUTION_MISMATCH');
    requireRetainedExecution(value.execution, native, stage);
    if ((!stage || stage === 'deliver') && value.execution.role === 'writer' &&
      value.shape?.hash && Array.isArray(value.issue?.labels)) {
      // Use exactly the old admission fields, even if current main has moved.
      const requestHash = digest(stageAdmissionFields(value, { stage: 'deliver',
        binding: evidenceBinding(value), artifacts: { shapeHash: value.shape.hash } }));
      localDeliverDecisions.push(digest({ operation: 'deliver',
        bindingHash: requestHash }));
    }
    retained.push({ classification: invocation === null ? 'incomplete-input' :
      'complete-stage', execution: value.execution, ...(stage ? { stage } : {}) });
  }
  const reportRoot = join(issueRoot, 'receipts', 'reports');
  const reports = await snapshots.directory(reportRoot);
  for (const name of reports) {
    requireThat(/^[a-f0-9]{64}\.json$/.test(name), 'RECOVERY_REPORT_INVALID');
    const value = await snapshots.json(join(reportRoot, name), 2 * 1024 * 1024);
    requireThat(value !== null, 'RECOVERY_EVIDENCE_CHANGED');
    const { id, ...report } = value;
    requireThat(digest(report) === id && name === `${id}.json`,
      'RECOVERY_REPORT_INVALID');
    const binding = report.binding;
    requireThat(report.schemaVersion === 1 && report.kind === 'blocker-report' &&
      digest(binding?.issue) === digest(subject) &&
      isId(binding?.subjectId) && isId(binding?.native?.runId) &&
      isId(binding.native.jobId) && isId(binding.native.attempt),
    'RECOVERY_REPORT_INVALID');
    if (!retainedNative({ ...binding?.native, actorId: binding?.subjectId },
      fence.binding.execution)) continue;
    requireThat(digest(binding.issue) === digest(subject) &&
      binding.native.runnerId === adopted.runner.runnerId &&
      binding.native.repositoryId === adopted.runner.repositoryId &&
      binding.native.sourceCommit === run.head_sha &&
      (Object.hasOwn(stages, binding.stage) || binding.stage === 'continue'),
    'RECOVERY_EXECUTION_MISMATCH');
    retained.push({ classification: 'native-report', stage: binding.stage,
      admissionId: binding.admissionId });
  }
  const receipts = await store.load();
  for (const [stage, receipt] of Object.entries(receipts)) {
    if (!retainedNative(receipt.execution, fence.binding.execution)) continue;
    executionIdentity(receipt.execution, stages[stage].role, native.memberId);
    requireRetainedExecution(receipt.execution, native, stage);
    const input = retained.find(entry => entry.execution?.id === receipt.execution.id);
    requireThat(!input?.stage || input.stage === stage, 'RECOVERY_EXECUTION_MISMATCH');
  }
  requireThat(receipts['publish-shape']?.outcome === 'published',
    'RECOVERY_RECEIPTS_MISSING');
  const shape = await store.get(receipts['publish-shape'].artifacts.shapeHash);
  const progress = await issueProgress(issueRoot, approval);
  const selection = digest({ binding: progress.binding,
    workspaceRoot: progress.workspaceRoot });
  const coverage = { kind: 'native-continuation', native: {
    repositoryId: native.repositoryId, runnerId: native.runnerId,
    runId: native.runId, attempt: native.attempt, jobId: native.jobId,
    actorId: native.actorId, sourceCommit: run.head_sha,
  }, stages: Object.keys(stages), iterations: 'all', retained };
  const confirm = async () => {
    await snapshots.confirm();
    const selected = await issueProgress(issueRoot, approval);
    requireThat(digest({ binding: selected.binding,
      workspaceRoot: selected.workspaceRoot }) === selection &&
      digest(await selected.store.load()) === digest(receipts),
    'RECOVERY_PROGRESS_CHANGED');
    const issue = await context.reader.issue(subject);
    requireThat(issue.node_id === subject.id && issue.state === 'open' &&
      issue.labels?.some(label => label.name === 'scope') &&
      issue.labels.some(label => label.name === 'shaped') &&
      !issue.labels.some(label => label.name === 'pause') &&
      samePublishedRequirements(issue.body, shape), 'RECOVERY_ISSUE_CHANGED');
  };
  await confirm();
  // Preserve the complete Deliver route's recorded identity where it is proven.
  // Otherwise retain the original outer identity, never mint a Deliver entry.
  const delivery = retained.find(entry => entry.stage === 'deliver' &&
    entry.execution && digest(entry.execution) === digest(hostExecution(native,
      'deliver')));
  return { execution: delivery?.execution ?? fence.binding.execution, coverage,
    confirm, localDeliverDecisions,
    hash: digest({ snapshots: snapshots.hash, receipts, selection, coverage }) };
}

export async function terminalDeliverJob(context, fence, approval) {
  const { adopted, reader, host } = context;
  const runner = adopted.runner, prior = fence.binding.execution;
  const root = repoPath(runner.repository);
  const [run, job, actor, repository] = await Promise.all([
    reader.get(`${root}/actions/runs/${prior.runId}/attempts/${prior.attempt}`),
    reader.get(`${root}/actions/jobs/${prior.jobId}`), reader.get('/user'),
    reader.get(repoPath(adopted.isolation.issue.repository)),
  ]);
  const terminal = ['success', 'failure', 'cancelled', 'timed_out', 'skipped',
    'neutral', 'action_required', 'stale', 'startup_failure'];
  requireThat(isSha(run.head_sha) &&
    repository.id === adopted.isolation.issue.repositoryId &&
    repository.full_name === adopted.isolation.issue.repository &&
    repository.private === false && approval.record.operations.includes('deliver') &&
    digest(approval.record.issue) === digest(adopted.isolation.issue) &&
    prior.actorId === host.memberId && actor.id === prior.actorId &&
    approval.record.roles.writer === actor.id &&
    run.actor?.id === actor.id && run.triggering_actor?.id === actor.id &&
    run.id === prior.runId && run.run_attempt === prior.attempt &&
    run.workflow_id === runner.workflowId &&
    ['workflow_dispatch', 'issues'].includes(run.event) &&
    run.status === 'completed' && terminal.includes(run.conclusion) &&
    job.id === prior.jobId && job.run_id === prior.runId &&
    job.run_attempt === prior.attempt && job.status === 'completed' &&
    terminal.includes(job.conclusion) && job.runner_id === runner.runnerId &&
    job.runner_name === runner.runnerName && job.name === runner.jobName,
  'RECOVERY_EXECUTION_MISMATCH');
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
  // Freeze settlement facts, not unrelated repository counters or API metadata.
  return { run, hash: digest({ actor: actor.id,
    run: pick(run, ['id', 'run_attempt', 'workflow_id', 'head_sha', 'event',
      'status', 'conclusion']),
    job: pick(job, ['id', 'run_id', 'run_attempt', 'status', 'conclusion',
      'runner_id', 'runner_name', 'name']),
    repository: pick(repository, ['id', 'full_name', 'private']) }) };

}
