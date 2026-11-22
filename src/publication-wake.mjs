import { matchesActionsRun, matchesActionsJob } from './native-execution.mjs';
import { join } from 'node:path';
import { EvidenceStore } from './evidence-store.mjs';
import { issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { evidenceBinding, stages } from './stages.mjs';
import { digest, isId, isSha } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { issueBodyChange } from './issue-body-change.mjs';

// Read trusted evidence without preparing delivery state.
export async function readWakePublication(stateRoot, approval) {
  const root = issueStatePath(stateRoot, approval.record.issue);
  const receiptsRoot = join(root, 'receipts');
  const binding = evidenceBinding({ approval });
  try {
    for (const directory of [root, receiptsRoot,
      join(receiptsRoot, `evidence-${digest(binding)}`)])
      await privateHostDirectory(directory);
  } catch (error) {
    // Older installations need no correlation evidence to resume ordinary work.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const store = new EvidenceStore(receiptsRoot, binding, { readOnly: true });
  const receipts = await store.load();
  const receipt = receipts['publish-shape'];
  const hash = receipt?.artifacts.publicationHash;
  if (receipt?.outcome !== 'published' || !hash) return null;
  const publication = await store.get(hash);
  if (publication.shapeHash !== receipt.artifacts.shapeHash ||
    digest(publication.execution) !== digest(receipt.execution)) return null;
  const actorId = publication.execution.actorId;
  const remaining = Object.keys(stages).slice(Object.keys(stages).indexOf('deliver'));
  if (remaining.some(stage =>
    approval.record.roles[stages[stage].role] !== actorId ||
    !approval.record.operations.includes(stages[stage].operation))) return null;
  if (Object.values(receipts).some(entry =>
    entry.execution.runId === publication.execution.runId &&
    entry.execution.attempt === publication.execution.attempt &&
    ['blocked', 'changes_required'].includes(entry.outcome))) return null;
  return publication;
}

function matchesEvent(publication, issue, live, event, actorId) {
  const change = issueBodyChange(event);
  const { transition, execution, runner } = publication ?? {};
  return change && transition && runner &&
    digest(publication.issue) === digest(issue) &&
    change.before === transition.before && change.after === transition.after &&
    change.before !== change.after && publication.shapeHash === change.after &&
    digest(live.body) === change.after && live.node_id === issue.id &&
    live.updated_at === transition.updatedAt &&
    event.issue.updated_at === transition.updatedAt &&
    event.sender?.id === actorId && execution?.actorId === actorId &&
    runner.actorId === actorId && runner.memberId === actorId &&
    execution.runId === runner.runId && execution.attempt === runner.attempt &&
    execution.jobId === runner.jobId &&
    (runner.target ? runner.target.repositoryId === issue.repositoryId &&
      runner.target.repository === issue.repository :
      runner.repositoryId === issue.repositoryId &&
        runner.repository === issue.repository);
}

async function continuingRun(reader, runner) {
  if (![runner.repositoryId, runner.runId, runner.attempt, runner.jobId,
    runner.workflowId, runner.runnerId].every(isId) || !isSha(runner.sourceCommit) ||
    (runner.eventName ?? 'workflow_dispatch') !== 'workflow_dispatch') return false;
  const root = repoPath(runner.repository);
  const run = await reader.get(`${root}/actions/runs/${runner.runId}`);
  const job = await reader.get(`${root}/actions/jobs/${runner.jobId}`);
  const workflow = await reader.get(`${root}/actions/workflows/${runner.workflowId}`);
  const pins = [runner.reusable, runner.wakeWorkflow].filter(Boolean);
  const repository = await reader.repository(runner.repository);
  return repository.id === runner.repositoryId &&
    repository.full_name === runner.repository && repository.private === false &&
    repository.archived === false && repository.disabled === false &&
    matchesActionsRun(runner, run, repository, pins) &&
    pins.every(pin => run.referenced_workflows.some(ref =>
      ref.path === pin.ref && ref.sha === pin.commit)) &&
    matchesActionsJob(runner, job) &&
    workflow.id === runner.workflowId && workflow.path === runner.workflowPath &&
    workflow.state === 'active';
}

// Notification fields are untrusted context. Only admitted private provenance
// plus two current native observations may establish coverage of this event.
export async function publicationCovered({
  reader, issue, event, actorId, readPublication, inspect,
}) {
  if (!issueBodyChange(event) || !readPublication) return false;
  const publication = await readPublication();
  if (!publication) return false;
  const live = await reader.issue(issue);
  if (!matchesEvent(publication, issue, live, event, actorId) ||
    !await continuingRun(reader, publication.runner)) return false;
  await inspect();
  const current = await readPublication();
  if (digest(current) !== digest(publication)) return false;
  const fresh = await reader.issue(issue);
  return matchesEvent(publication, issue, fresh, event, actorId) &&
    await continuingRun(reader, publication.runner);
}
