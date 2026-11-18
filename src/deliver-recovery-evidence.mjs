import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostExecution } from './host-launcher.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { readObservationFile, safePath } from './local-work-files.mjs';
import { digest, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { samePublishedRequirements } from './stages.mjs';

const sameNative = (left, right) => ['runId', 'jobId', 'attempt', 'actorId']
  .every(key => left?.[key] === right?.[key]);

// Retained inputs are written by Core outside every Writer mount. Neither an
// Agent result nor an Issue's requested stage is proof of the abandoned role.
export async function deliverExecutionEvidence(context, fence, run, approval, store) {
  const { host, adopted } = context;
  const subject = adopted.isolation.issue;
  const root = join(host.stateRoot, `issue-${subject.repositoryId}-${subject.number}`,
    'agent');
  const names = await privateEntries(root);
  requireThat(names.length <= 4096, 'RECOVERY_EVIDENCE_LIMIT');
  const snapshots = [];
  let bytes = 0;
  const deadline = Date.now() + 15000;
  const read = async (path, limit) => {
    requireThat(Date.now() < deadline, 'RECOVERY_EVIDENCE_LIMIT');
    const file = await readObservationFile(path, process.getuid(), limit);
    bytes += Buffer.byteLength(file.bytes);
    requireThat(bytes <= 64 * 1024 * 1024, 'RECOVERY_EVIDENCE_LIMIT');
    return file;
  };
  const matches = [];
  const native = { ...adopted.runner, sourceCommit: run.head_sha,
    ...fence.binding.execution };
  // The launcher initially binds continuation to its Shape execution. Prove
  // Deliver was actually entered using the corresponding Core invocation.
  const outer = ['shape', 'deliver'].some(stage =>
    digest(hostExecution(native, stage)) === digest(fence.binding.execution));
  requireThat(outer, 'RECOVERY_EXECUTION_MISMATCH');
  for (const name of names.filter(value => /^execution-[a-f0-9-]{36}$/.test(value))) {
    const directory = join(root, name, 'input');
    await privateHostDirectory(join(root, name));
    await safePath(directory, process.getuid());
    const path = join(directory, 'context.json');
    const snapshot = await read(path, 8 * 1024 * 1024);
    const value = JSON.parse(snapshot.bytes);
    if (!sameNative(value.execution, fence.binding.execution)) continue;
    snapshots.push({ path, snapshot });
    const invocationPath = join(directory, 'invocation.json');
    const invocation = await read(invocationPath, 8 * 1024 * 1024);
    snapshots.push({ path: invocationPath, snapshot: invocation });
    const stage = JSON.parse(invocation.bytes).plan?.contract?.stage;
    requireThat(['shape', 'validate-shape', 'deliver'].includes(stage),
      'RECOVERY_NOT_ABANDONED_DELIVER');
    if (stage !== 'deliver') continue;
    requireThat(name === `execution-${value.execution.id}` &&
      digest(value.execution) === digest(hostExecution(native, 'deliver')) &&
      digest(value.approval?.record?.issue) === digest(approval.record.issue) &&
      value.runner?.runnerId === adopted.runner.runnerId &&
      value.runner.repositoryId === adopted.runner.repositoryId &&
      value.runner.sourceCommit === run.head_sha &&
      value.isolation?.profile === adopted.isolation.kind,
    'RECOVERY_EXECUTION_MISMATCH');
    matches.push(value.execution);
  }
  const reportRoot = join(host.stateRoot,
    `issue-${subject.repositoryId}-${subject.number}`, 'receipts', 'reports');
  const reports = await privateEntries(reportRoot);
  requireThat(reports.length <= 4096, 'RECOVERY_EVIDENCE_LIMIT');
  let reported = false;
  for (const name of reports) {
    requireThat(/^[a-f0-9]{64}\.json$/.test(name), 'RECOVERY_REPORT_INVALID');
    const path = join(reportRoot, name);
    const snapshot = await read(path, 2 * 1024 * 1024);
    const { id, ...report } = JSON.parse(snapshot.bytes);
    requireThat(digest(report) === id && name === `${id}.json`,
      'RECOVERY_REPORT_INVALID');
    const binding = report.binding;
    if (!sameNative({ ...binding?.native, actorId: binding?.subjectId },
      fence.binding.execution)) continue;
    snapshots.push({ path, snapshot });
    requireThat(digest(binding.issue) === digest(subject) &&
      binding.native.runnerId === adopted.runner.runnerId &&
      binding.native.repositoryId === adopted.runner.repositoryId &&
      binding.native.sourceCommit === run.head_sha, 'RECOVERY_EXECUTION_MISMATCH');
    requireThat(['shape', 'validate-shape', 'deliver'].includes(binding.stage),
      'RECOVERY_NOT_ABANDONED_DELIVER');
    if (binding.stage === 'deliver' && report.producer === 'core-native' &&
        binding.admissionId === hostExecution(native, 'deliver').id) reported = true;
  }
  // A direct launch's private fence already binds its actual Deliver execution.
  // Continuation's Shape fence needs independent evidence that Deliver started.
  requireThat(matches.length <= 1 && (matches.length === 1 || reported ||
    digest(hostExecution(native, 'deliver')) === digest(fence.binding.execution)),
  'RECOVERY_DELIVER_EVIDENCE_UNAVAILABLE');
  const receipts = await store.load();
  const afterDeliver = ['pre-accept-hooks', 'accept', 'post-accept-hooks',
    'commit-pr', 'review-pr', 'merge', 'close'];
  requireThat(!afterDeliver.some(stage => sameNative(receipts[stage]?.execution,
    fence.binding.execution)), 'RECOVERY_NOT_ABANDONED_DELIVER');
  requireThat(receipts['publish-shape']?.outcome === 'published',
    'RECOVERY_RECEIPTS_MISSING');
  const shape = await store.get(receipts['publish-shape'].artifacts.shapeHash);
  const confirm = async () => {
    requireThat(Date.now() < deadline, 'RECOVERY_EVIDENCE_LIMIT');
    for (const { path, snapshot } of snapshots) {
      const current = await readObservationFile(path, process.getuid(),
        8 * 1024 * 1024);
      requireThat(digest(current) === digest(snapshot), 'RECOVERY_EVIDENCE_CHANGED');
    }
    requireThat(digest(await store.load()) === digest(receipts),
      'RECOVERY_PROGRESS_CHANGED');
    const issue = await context.reader.issue(subject);
    requireThat(issue.node_id === subject.id && issue.state === 'open' &&
      issue.labels?.some(label => label.name === 'scope') &&
      issue.labels.some(label => label.name === 'shaped') &&
      !issue.labels.some(label => label.name === 'pause') &&
      samePublishedRequirements(issue.body, shape), 'RECOVERY_ISSUE_CHANGED');
  };
  await confirm();
  return { execution: matches[0] ?? hostExecution(native, 'deliver'),
    confirm, hash: digest(snapshots) };
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

async function privateEntries(directory) {
  try {
    await privateHostDirectory(directory);
    return await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
