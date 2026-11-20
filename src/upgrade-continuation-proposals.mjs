import { gitBlob, isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { upgradeContinuationContract as contract, upgradeRecipeVariants }
  from './upgrade-continuation-contract.mjs';

export async function upgradeRepository(reader, { repository, repositoryId }) {
  const root = repoPath(repository);
  const repo = await reader.get(root);
  requireThat(repo.id === repositoryId && repo.full_name === repository &&
    repo.private === false && repo.archived === false && repo.disabled === false &&
    isId(repo.owner?.id) && typeof repo.default_branch === 'string' &&
    repo.default_branch.length > 0, 'UPGRADE_REPOSITORY_CHANGED');
  const branch = await reader.get(
    `${root}/branches/${encodeURIComponent(repo.default_branch)}`,
  );
  requireThat(branch.name === repo.default_branch && isSha(branch.commit?.sha),
    'UPGRADE_DEFAULT_BRANCH_UNAVAILABLE');
  return { id: repo.id, name: repository, ownerId: repo.owner.id, root,
    ref: `refs/heads/${repo.default_branch}`, branch: repo.default_branch,
    head: branch.commit.sha, protected: branch.protected === true };
}

export async function upgradeWorkflowSource(reader, repository, commit, kind,
  memberId) {
  const path = contract.recipes[kind];
  requireThat(['notification', 'execution'].includes(kind) && isSha(commit),
    'UPGRADE_WORKFLOW_INVALID');
  const file = await reader.get(`${repository.root}/contents/${path}?ref=${commit}`);
  requireThat(file.type === 'file' && file.path === path && file.encoding === 'base64' &&
    typeof file.content === 'string', 'UPGRADE_WORKFLOW_INVALID');
  const bytes = Buffer.from(file.content, 'base64');
  const text = bytes.toString('utf8').replaceAll('\r\n', '\n');
  requireThat(file.sha === gitBlob(bytes) &&
    upgradeRecipeVariants(kind, memberId).includes(text),
  'UPGRADE_WORKFLOW_NOT_MAINTAINED');
  return file.sha;
}

export async function observeUpgradeWorkflow(reader, repository, kind, memberId) {
  const file = contract.recipes[kind].split('/').at(-1);
  const workflow = await reader.get(`${repository.root}/actions/workflows/${file}`);
  requireThat(workflow.path === contract.recipes[kind] && isId(workflow.id) &&
    workflow.state === 'active', 'UPGRADE_WORKFLOW_UNAVAILABLE');
  const blob = await upgradeWorkflowSource(reader, repository, repository.head,
    kind, memberId);
  return { id: workflow.id, path: workflow.path, blob };
}

export async function observeUpgradeProposal(reader, consumer, pullNumber, memberId) {
  const repo = await upgradeRepository(reader, consumer);
  const path = `${repo.root}/pulls/${pullNumber}`;
  const pull = await reader.get(path);
  requireThat(isId(pull.id) && pull.number === pullNumber &&
    typeof pull.node_id === 'string' && pull.node_id.length > 0 &&
    pull.user?.id === memberId && pull.user.type === 'User' &&
    pull.head?.repo?.id === repo.id && pull.head.ref === contract.proposalBranch &&
    pull.base?.repo?.id === repo.id && pull.base.ref === repo.branch &&
    (pull.state === 'open' || pull.state === 'closed') &&
    typeof pull.merged === 'boolean',
  'UPGRADE_PROPOSAL_NOT_AUTHORIZED');
  requireThat(pull.state === 'open' || pull.merged, 'UPGRADE_PROPOSAL_ABANDONED');
  if (pull.merged) {
    requireThat(pull.state === 'closed' && isSha(pull.merge_commit_sha),
      'UPGRADE_PROPOSAL_MERGE_UNKNOWN');
    const ancestry = await reader.get(
      `${repo.root}/compare/${pull.merge_commit_sha}...${repo.head}`,
    );
    requireThat(['identical', 'ahead'].includes(ancestry.status) &&
      ancestry.merge_base_commit?.sha === pull.merge_commit_sha,
    'UPGRADE_PROPOSAL_NOT_ON_CURRENT_SOURCE');
    await observeUpgradeWorkflow(reader, repo, 'notification', memberId);
  } else {
    await upgradeWorkflowSource(reader, repo, pull.head.sha, 'notification', memberId);
  }
  const current = await upgradeRepository(reader, consumer);
  requireThat(current.head === repo.head && current.ref === repo.ref,
    'UPGRADE_DEFAULT_BRANCH_CHANGED');
  return { repository: repo.name, repositoryId: repo.id,
    pullNumber: pull.number, pullId: pull.id, pullNodeId: pull.node_id,
    proposalUrl: `https://github.com/${repo.name}/pull/${pull.number}`,
    merged: pull.merged, defaultHead: repo.head };
}

// A previously bound PR can be abandoned without leaving its old branch or
// recipe accessible. Its stable native identity and current disposition suffice.
export async function observeUpgradeProposalDisposition(reader, consumer, previous) {
  const repo = await upgradeRepository(reader, consumer);
  const current = await reader.get(`${repo.root}/pulls/${previous.pullNumber}`);
  requireThat(current.id === previous.pullId && current.node_id === previous.pullNodeId &&
    current.number === previous.pullNumber && current.base?.repo?.id === repo.id &&
    ['open', 'closed'].includes(current.state) && typeof current.merged === 'boolean',
  'UPGRADE_PROPOSAL_CHANGED');
  return current.state === 'closed' && !current.merged ? 'abandoned' : 'current';
}

export async function verifyUpgradeNotificationRoute(reader, consumer, destination) {
  const repo = await upgradeRepository(reader, consumer);
  const variable = await reader.get(
    `${repo.root}/actions/variables/${contract.notification.destinationVariable}`,
  );
  const secret = await reader.get(
    `${repo.root}/actions/secrets/${contract.notification.dispatchSecret}`,
  );
  requireThat(variable.name === contract.notification.destinationVariable &&
    variable.value === destination.name &&
    secret.name === contract.notification.dispatchSecret,
  'UPGRADE_NOTIFICATION_ROUTE_UNAVAILABLE');
}
