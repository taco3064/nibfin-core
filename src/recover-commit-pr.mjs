import { open, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedHostFile, coreRoot, loadHostAdoption } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { hostExecution } from './host-launcher.mjs';
import { idleContainers } from './host-containers.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { issueProgress } from './issue-progress.mjs';
import { OperationJournal } from './operation-journal.mjs';
import {
  samePublishedRequirements, stageRequestHash,
} from './stages.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { targetContextKey } from './controller-contract.mjs';
import { linuxBootId, proveDifferentBoot } from './linux-boot.mjs';
import {
  exclusiveRecovery, recoveryFile, inspectRecoveryFile, syncRecoveryDirectory,
} from './recovery-lock.mjs';

// This entry is invoked locally as the administrator-owned controller, using a
// verified recovery package. The Runner's fixed sudo relay cannot invoke it.
export async function recoverCommitPr(issueNumber, expectedHead) {
  return recover(issueNumber, expectedHead, 'commit-pr');
}

export async function recoverReview(issueNumber, expectedHead) {
  return recover(issueNumber, expectedHead, 'review-pr');
}

async function recover(issueNumber, expectedHead, stage) {
  requireThat(process.getuid?.() > 0 && isSha(expectedHead), 'INVALID_RECOVERY_REQUEST');
  await rootOwnedPath(coreRoot);
  const installed = await import('/opt/nibfin/core/src/host-adoption.mjs');
  const load = coreRoot === '/opt/nibfin/core' ? loadHostAdoption :
    installed.loadHostAdoption;
  const target = process.env[targetContextKey];
  const context = await load(issueNumber, target);
  return recoverAdoptedOperation(context, expectedHead, stage);
}

// Private dependency seams for local fixtures; CLI always uses trusted defaults.
export async function recoverAdoptedOperation(context, expectedHead, stage, {
  observeBoot = linuxBootId, containers = idleContainers,
  approvalReader = readProtectedApproval,
} = {}) {
  requireThat(isSha(expectedHead) && ['commit-pr', 'review-pr'].includes(stage),
    'INVALID_RECOVERY_REQUEST');
  try {
    const issueRoot = issueStatePath(context.host.stateRoot,
      context.adopted.isolation.issue);
    await privateHostDirectory(issueRoot);
    return await exclusiveRecovery(issueRoot, () => reconcileOperation(context,
      expectedHead, stage, { observeBoot, containers, approvalReader }));
  } catch (error) {
    // Failure to settle this execution is unresolved recovery, never permission
    // to launch again. Expose only a bounded, credential-free diagnostic.
    const code = typeof error?.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code : 'RECOVERY_OBSERVATION_UNAVAILABLE';
    return { status: 'pending', code };
  }
}

async function reconcileOperation({ host, hostBytes, adopted, reader },
  expectedHead, stage, { observeBoot, containers, approvalReader }) {
  const subject = adopted.isolation.issue;
  const issueRoot = issueStatePath(host.stateRoot, subject);
  const scopedFence = join(issueRoot, 'stage.lock');
  let fencePath = scopedFence;
  const fenceBytes = await boundedHostFile(fencePath, 16384, true).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    fencePath = join(host.stateRoot, 'stage.lock');
    return boundedHostFile(fencePath, 16384, true);
  });
  const fenceSnapshot = await recoveryFile(fencePath);
  requireThat(fenceSnapshot.bytes === fenceBytes, 'HOST_FENCE_CHANGED');
  const fence = JSON.parse(fenceBytes);
  const priorJob = fence.binding?.execution;
  requireThat(fence.binding?.host === digest(hostBytes) &&
    fence.binding.issueId === subject.id &&
    isId(fence.pid) && isId(priorJob?.runId) && isId(priorJob.jobId) &&
    isId(priorJob.attempt), 'INVALID_RECOVERY_FENCE');
  const runner = adopted.runner;
  const root = repoPath(subject.repository);
  const executionRoot = repoPath(runner.repository);
  const checkQuiescence = async () => {
    await privateHostDirectory(host.stateRoot);
    await privateHostDirectory(issueRoot);
    await privateHostDirectory(dirname(fencePath));
    await proveDifferentBoot(fence.bootId, observeBoot);
    const runners = await reader.list(executionRoot + '/actions/runners', 'runners');
    const label = 'nibfin-user-' + host.memberId;
    const routes = runners.filter(r =>
      (!runner.target || r.id === runner.runnerId) &&
      r.labels?.some(l => l.name === label));
    requireThat(routes.length === 1 && routes[0].id === runner.runnerId &&
      routes[0].status === 'offline' && !routes[0].busy, 'RECOVERY_RUNNER_NOT_OFFLINE');
    await containers(adopted.isolation, subject);
    await inspectRecoveryFile(fencePath, fenceSnapshot);
  };
  await checkQuiescence();
  const [approval, run, job, actor] = await Promise.all([
    approvalReader(reader, adopted.approval),
    reader.get(executionRoot + '/actions/runs/' + priorJob.runId),
    reader.get(executionRoot + '/actions/jobs/' + priorJob.jobId),
    reader.get('/user'),
  ]);
  const record = approval.record;
  requireThat(record.operations.includes(stage) &&
    actor.id === record.roles.publisher && actor.id === priorJob.actorId &&
    run.actor?.id === actor.id && run.triggering_actor?.id === actor.id &&
    run.run_attempt === priorJob.attempt &&
    run.workflow_id === adopted.runner.workflowId &&
    run.id === priorJob.runId && run.event === 'workflow_dispatch' &&
    run.status === 'completed' && job.id === priorJob.jobId &&
    job.status === 'completed' && job.run_id === run.id &&
    job.name === runner.jobName && job.runner_id === runner.runnerId,
  'RECOVERY_EXECUTION_MISMATCH');
  requireThat(record.issue.id === subject.id, 'RECOVERY_ISSUE_CHANGED');
  const receiptsRoot = join(issueRoot, 'receipts');
  const { binding, store } = await issueProgress(issueRoot, approval);
  const receipts = await store.load();
  const prior = receipts['commit-pr'], deliver = receipts.deliver;
  requireThat(prior?.outcome === 'published' && deliver?.outcome === 'ready' &&
    receipts.accept?.outcome === 'accepted' &&
    receipts['post-accept-hooks']?.outcome === 'passed', 'RECOVERY_RECEIPTS_MISSING');
  const artifacts = { shapeHash: deliver.artifacts.shapeHash,
    candidateHash: deliver.artifacts.candidateHash };
  const candidate = await store.get(artifacts.candidateHash);
  const shape = await store.get(artifacts.shapeHash);
  if (stage === 'review-pr') {
    requireThat(prior.artifacts.head === expectedHead &&
      prior.artifacts.candidateHash === artifacts.candidateHash &&
      !receipts.merge && !receipts.close &&
      actor.id === record.roles.author, 'RECOVERY_REVIEW_NOT_ELIGIBLE');
  }
  const readBack = async () => {
    const [pr, commit, issue] = await Promise.all([
      reader.get(root + '/pulls/' + prior.artifacts.prNumber),
      reader.get(root + '/git/commits/' + expectedHead),
      reader.issue(record.issue),
    ]);
    requireThat(issue.node_id === record.issue.id && issue.state === 'open' &&
      issue.labels.some(l => l.name === 'shaped') &&
      samePublishedRequirements(issue.body, shape), 'RECOVERY_ISSUE_CHANGED');
    requireThat(pr.node_id === prior.artifacts.prId && pr.state === 'open' &&
      pr.head.sha === expectedHead && pr.head.repo.id === record.issue.repositoryId &&
      pr.base.repo.id === record.issue.repositoryId && pr.base.ref === 'main' &&
      commit.sha === expectedHead && commit.tree.sha === candidate.tree &&
      commit.parents.length === 1 && commit.parents[0].sha === candidate.base &&
      commit.message.trim().endsWith('Candidate: ' + artifacts.candidateHash),
    'RECOVERY_CANDIDATE_MISMATCH');
    const ref = await reader.get(root + '/git/ref/heads/' + pr.head.ref);
    requireThat(ref.object.sha === expectedHead, 'RECOVERY_HEAD_CHANGED');
    return { pr, issue };
  };
  const { issue } = await readBack();
  const journal = new OperationJournal(receiptsRoot, record.issue);
  let result;
  for (const sourceCommit of new Set([run.head_sha, adopted.runner.sourceCommit])) {
    const execution = hostExecution({ ...adopted.runner, sourceCommit,
      runId: priorJob.runId, jobId: priorJob.jobId, attempt: priorJob.attempt },
    stage);
    const review = stage === 'review-pr';
    const requestArtifacts = review
      ? { ...artifacts, prId: prior.artifacts.prId, prNumber: prior.artifacts.prNumber,
        head: expectedHead } : artifacts;
    const requestHash = stageRequestHash({ stage, binding, artifacts: requestArtifacts,
      execution, runner: runner.runnerId, isolation: adopted.isolation.kind,
      body: issue.body, shaped: true });
    const decision = digest({ operation: stage, bindingHash: requestHash });
    try {
      const confirm = async () => {
        const { pr } = await readBack();
        await checkQuiescence();
        if (review) {
          const previous = (await store.load())['review-pr'];
          requireThat(previous?.outcome === 'approved' &&
            previous.execution.id === execution.id &&
            previous.artifacts.prId === pr.node_id &&
            previous.artifacts.head !== expectedHead, 'RECOVERY_REVIEW_NOT_REPEATED');
          const session = digest({
            ...binding, memberId: execution.actorId, role: execution.role,
            executionId: execution.id, sessionId: execution.sessionId,
          });
          const directory = join(issueRoot, 'agent', `session-${session}`);
          await privateHostDirectory(directory);
          requireThat((await readdir(directory)).length === 0,
            'RECOVERY_REVIEW_SESSION_NOT_CLOSED');
          return store.put({ stage, decision, previous: digest(previous),
            head: expectedHead, executionId: execution.id });
        }
        return store.append({
          schemaVersion: 1, stage: 'commit-pr', binding, execution,
          artifacts: { ...artifacts, prId: pr.node_id, prNumber: pr.number,
            head: expectedHead, base: candidate.base },
          outcome: 'published', findings: [], references: [pr.html_url],
        });
      };
      result = review ? await journal.recoverReview(requestHash, confirm,
        { pid: fence.pid, prove: checkQuiescence })
        : await journal.recoverCommitPr(decision, confirm,
          { pid: fence.pid, prove: checkQuiescence });
      break;
    } catch (error) {
      if (error.code !== 'RECOVERY_DECISION_MISMATCH') throw error;
    }
  }
  requireThat(result, 'RECOVERY_DECISION_MISMATCH');
  if (result.status !== 'completed') return result;
  await checkQuiescence();
  const archive = join(host.stateRoot,
    `reconciled-${stage}-${priorJob.runId}-${priorJob.attempt}.json`);
  const file = await open(archive, 'wx', 0o600).catch(error => {
    if (error.code !== 'EEXIST') throw error;
    return null;
  });
  if (file) {
    try { await file.writeFile(fenceBytes); await file.sync(); }
    finally { await file.close(); }
  }
  requireThat(await boundedHostFile(archive, 16384, true) === fenceBytes,
    'RECOVERY_ARCHIVE_CHANGED');
  await syncRecoveryDirectory(host.stateRoot);
  await checkQuiescence();
  await unlink(fencePath);
  await syncRecoveryDirectory(dirname(fencePath));
  return result;
}
