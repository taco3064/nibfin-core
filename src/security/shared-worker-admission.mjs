import { isId, isSha, requireThat } from '../identity.mjs';
import { repoPath } from '../github-read.mjs';
import { readCallerContinuity } from '../caller-source.mjs';
import { sharedWorkflowPath } from '../shared-runner.mjs';

export function sharedWorkerContext(message, binding, ref) {
  const entries = message?.contextData?.github?.d;
  requireThat(message?.contextData?.github?.t === 2 && Array.isArray(entries) &&
    entries.length <= 100 && entries.every(entry => typeof entry?.k === 'string'),
  'SHARED_WORKER_CONTEXT_INVALID');
  const github = new Map(entries.map(({ k, v }) => [k, v]));
  const number = key => {
    const value = github.get(key);
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  };
  const runId = number('run_id');
  const attempt = number('run_attempt');
  const commit = github.get('workflow_sha');
  requireThat(github.size === entries.length && isId(runId) && isId(attempt) &&
    isSha(commit) && github.get('sha') === commit &&
    github.get('event_name') === 'workflow_dispatch' &&
    github.get('repository') === binding.repository &&
    number('repository_id') === binding.repositoryId &&
    number('actor_id') === binding.memberId && github.get('ref') === ref &&
    github.get('workflow_ref') === `${binding.repository}/${sharedWorkflowPath}@${ref}` &&
    message.jobDisplayName === binding.jobName,
  'SHARED_WORKER_WORKFLOW_DENIED');
  return { runId, attempt, commit };
}

// Checks the Listener's message before launching the official Worker. Core
// still performs its OIDC, exact Job/Runner and target admission in the caller.
export async function admitSharedWorker(reader, message, binding, ref, ownerId,
  publicReader = reader) {
  const { runId, attempt, commit } = sharedWorkerContext(message, binding, ref);
  const root = repoPath(binding.repository);
  const [repository, run, workflow] = await Promise.all([
    reader.get(root),
    publicReader.get(`${root}/actions/runs/${runId}/attempts/${attempt}`),
    publicReader.get(`${root}/actions/workflows/${binding.workflowId}`),
  ]);
  const branch = repository.default_branch;
  requireThat(repository.id === binding.repositoryId &&
    isId(ownerId) && repository.owner?.id === ownerId &&
    repository.full_name === binding.repository && repository.private === false &&
    repository.archived === false && repository.disabled === false &&
    ref === `refs/heads/${branch}` &&
    run.id === runId && run.run_attempt === attempt && run.head_sha === commit &&
    run.event === 'workflow_dispatch' && run.head_branch === branch &&
    run.path === sharedWorkflowPath && run.workflow_id === binding.workflowId &&
    run.repository?.id === binding.repositoryId &&
    run.head_repository?.id === binding.repositoryId &&
    run.actor?.id === binding.memberId && run.triggering_actor?.id === binding.memberId &&
    workflow.id === binding.workflowId && workflow.state === 'active' &&
    workflow.path === sharedWorkflowPath,
  'SHARED_WORKER_PROVIDER_DENIED');
  const head = await reader.get(`${root}/branches/${encodeURIComponent(branch)}`);
  requireThat(head.protected === true && isSha(head.commit?.sha),
    'SHARED_WORKER_BRANCH_UNPROTECTED');
  const pin = {
    path: sharedWorkflowPath,
    commit: binding.sourceCommit,
    blob: binding.workflowBlob,
  };
  await readCallerContinuity(reader, binding.repository, pin, commit);
  if (head.commit.sha !== commit)
    await readCallerContinuity(reader, binding.repository, pin, head.commit.sha);
}
