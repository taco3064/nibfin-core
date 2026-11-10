import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedHostFile, coreRoot, loadHostAdoption } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { hostExecution, idleContainers } from './host-launcher.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { OperationJournal } from './operation-journal.mjs';
import {
  evidenceBinding, samePublishedRequirements, stageRequestHash,
} from './stages.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { privateHostDirectory } from './host-fence.mjs';

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
  const { host, hostBytes, adopted, reader } = coreRoot === '/opt/nibfin/core'
    ? await loadHostAdoption(issueNumber) : await installed.loadHostAdoption(issueNumber);
  const fencePath = join(host.stateRoot, 'stage.lock');
  const fenceBytes = await boundedHostFile(fencePath, 16384, true);
  const fence = JSON.parse(fenceBytes);
  const priorJob = fence.binding?.execution;
  requireThat(fence.binding?.host === digest(hostBytes) &&
    isId(fence.pid) && isId(priorJob?.runId) && isId(priorJob.jobId) &&
    isId(priorJob.attempt), 'INVALID_RECOVERY_FENCE');
  const root = repoPath(adopted.runner.repository);
  const checkQuiescence = async () => {
    try { process.kill(fence.pid, 0); }
    catch (error) {
      requireThat(error.code === 'ESRCH', 'WRITER_NOT_PROVEN_TERMINATED');
      const runners = await reader.list(root + '/actions/runners', 'runners');
      const routes = runners.filter(r => r.labels?.some(
        l => l.name === 'nibfin-user-' + host.memberId,
      ));
      requireThat(routes.length === 1 && routes[0].id === host.runnerId &&
        routes[0].status === 'offline' && !routes[0].busy, 'RECOVERY_RUNNER_NOT_OFFLINE');
      await idleContainers(adopted.isolation);
      requireThat(await boundedHostFile(fencePath, 16384, true) === fenceBytes,
        'HOST_FENCE_CHANGED');
      return;
    }
    requireThat(false, 'WRITER_NOT_PROVEN_TERMINATED');
  };
  await checkQuiescence();
  const [approval, run, job, actor] = await Promise.all([
    readProtectedApproval(reader, adopted.approval),
    reader.get(root + '/actions/runs/' + priorJob.runId),
    reader.get(root + '/actions/jobs/' + priorJob.jobId),
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
    job.name === adopted.runner.jobName && job.runner_id === host.runnerId,
  'RECOVERY_EXECUTION_MISMATCH');
  const binding = evidenceBinding({ approval });
  const issueRoot = join(host.stateRoot,
    `issue-${record.issue.repositoryId}-${record.issue.number}`);
  const receiptsRoot = join(issueRoot, 'receipts');
  const store = new EvidenceStore(receiptsRoot, binding);
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
      execution, runner: host.runnerId, isolation: adopted.isolation.kind,
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
      result = review ? await journal.recoverReview(requestHash, confirm)
        : await journal.recoverCommitPr(decision, confirm);
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
  await unlink(fencePath);
  const directory = await open(host.stateRoot, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return result;
}
