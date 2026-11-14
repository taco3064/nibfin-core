import { isId, requireThat } from './identity.mjs';
import { readCallerContinuity } from './caller-source.mjs';
import { repoPath } from './github-read.mjs';

export const sharedWorkflowPath = '.github/workflows/shared-runner.yml';

export function sharedRunner(host, target, runnerUid = host.runnerUid) {
  const config = host.sharedRunner;
  const { runner, caller } = config ?? {};
  requireThat(
    typeof runner?.repository === 'string' &&
      isId(runner.repositoryId) && isId(runner.workflowId) &&
      runner.workflowPath === sharedWorkflowPath &&
      runner.jobName === 'shared-stage' &&
      isId(runner.runnerId) &&
      runner.memberId === host.memberId &&
      !runner.actionCommit && !runner.reusable && !runner.wakeWorkflow &&
      caller?.repository === runner.repository &&
      caller.repositoryId === runner.repositoryId &&
      host.repository?.runner &&
      Array.isArray(config.repositories) &&
      config.repositories.includes(target.repositoryId),
    'SHARED_RUNNER_NOT_ADOPTED',
  );
  repoPath(runner.repository);
  const { repositoryId, runnerId } = host.repository.runner;
  let selected = runner;
  if (runnerUid !== host.runnerUid) {
    const additional = config.additionalRunner;
    requireThat(additional?.uid === runnerUid && isId(additional.id) &&
      additional.id !== runner.runnerId && typeof additional.name === 'string' &&
      additional.name && additional.name !== runner.runnerName,
    'SHARED_RUNNER_NOT_ADOPTED');
    selected = { ...runner, runnerId: additional.id, runnerName: additional.name };
  }
  return { runner: { ...selected, target, gateway: { repositoryId, runnerId } }, caller };
}

export async function sharedRepository(host, repositoryId, readPeer) {
  requireThat(isId(repositoryId), 'INVALID_SHARED_REPOSITORY');
  const paths = host.wakePeerFiles ?? [];
  requireThat(
    Array.isArray(paths) && paths.length <= 10 &&
      paths.every(path => /^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path)),
    'INVALID_WAKE_PEER_PATH',
  );
  if (host.repository?.approval.repositoryId === repositoryId) return host;
  const peers = await Promise.all(paths.map(readPeer));
  const matches = peers.filter(
    peer => peer.repository?.approval.repositoryId === repositoryId,
  );
  requireThat(matches.length === 1, 'SHARED_REPOSITORY_NOT_ADOPTED');
  return matches[0];
}

export async function sharedDispatchWorkflow(reader, runner) {
  const { repository, repositoryId, workflowId: id, workflowPath: path } = runner;
  const repo = await reader.repository(repository);
  requireThat(repo.id === repositoryId && repo.full_name === repository &&
    repo.private === false, 'SHARED_DISPATCH_REPOSITORY_CHANGED');
  const root = repoPath(repository);
  const [branch, workflow] = await Promise.all([
    reader.get(`${root}/branches/${encodeURIComponent(repo.default_branch)}`),
    reader.get(`${root}/actions/workflows/${id}`),
  ]);
  requireThat(workflow.id === id && workflow.path === path &&
    workflow.state === 'active', 'SHARED_DISPATCH_WORKFLOW_UNAVAILABLE');
  const pin = { path, commit: runner.sourceCommit, blob: runner.workflowBlob };
  const commit = await readCallerContinuity(reader, repository, pin, branch.commit?.sha);
  return { repository, repositoryId, id, path, commit, ref: repo.default_branch };
}
