import { repoPath } from './github-read.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { requirementsText, samePublishedRequirements } from './stages.mjs';

export const missingMergedClosure = 'MERGED_DELIVERY_CLOSURE_EVIDENCE_MISSING';

export function deliveryBranch(issue) {
  return `nibfin/deliver-${issue.number}`;
}

export function publishedDeliveryBranch(issue, head) {
  return `nibfin/issue-${issue.number}-${head.slice(0, 12)}`;
}

export async function readDeliveryPublication(reader, issue, head) {
  const root = repoPath(issue.repository);
  const owner = issue.repository.split('/')[0];
  const branch = publishedDeliveryBranch(issue, head);
  const related = await reader.list(`${root}/pulls?state=all&head=` +
    encodeURIComponent(`${owner}:${branch}`));
  const matching = related.filter(pr => pr.head?.sha === head &&
    pr.head.repo?.id === issue.repositoryId && pr.base?.repo?.id === issue.repositoryId &&
    pr.head.ref === branch && pr.base.ref === 'main');
  const merged = matching.find(pr => pr.state === 'closed' &&
    Number.isFinite(Date.parse(pr.merged_at)) && isSha(pr.merge_commit_sha));
  if (merged) {
    requireThat(isId(merged.number) && typeof merged.node_id === 'string',
      'DELIVER_BRANCH_UNAVAILABLE');
    return { mergedPublication: { id: merged.node_id, number: merged.number,
      mergeCommit: merged.merge_commit_sha } };
  }
  if (matching.some(pr => pr.state === 'closed' && pr.merged_at === null))
    return { retired: true };
  const existing = matching.filter(pr => pr.state === 'open' && pr.draft === false);
  requireThat(existing.length <= 1, 'DELIVER_BRANCH_UNAVAILABLE');
  const pr = existing[0];
  return pr ? { publication: { id: pr.node_id, number: pr.number, actorId: pr.user?.id,
    baseBranch: pr.base.ref, title: pr.title, body: pr.body } } : {};
}

export function deliveryLifecycle(context) {
  const reopened = context.pause.events?.filter(event => event.event === 'reopened')
    ?? [];
  requireThat(reopened.every(event => isId(event.id)), 'DELIVER_LIFECYCLE_UNAVAILABLE');
  return Math.max(0, ...reopened.map(event => event.id));
}

export function checkpointMessage(
  issue, { shape, lifecycle, mode = 'completed' }, candidate,
) {
  return [`Deliver #${issue.number}`, '', `Issue: ${issue.id}`,
    `Reopened: ${lifecycle}`, `Shape: ${JSON.stringify(requirementsText(shape))}`,
    `Status: ${mode}`, `Candidate: ${digest(candidate)}`, ''].join('\n');
}

export async function readDeliveryCheckpoint(reader, issue, { shape, lifecycle }) {
  const root = repoPath(issue.repository);
  const branch = deliveryBranch(issue);
  const record = await reader.get(`${root}/branches/${encodeURIComponent(branch)}`)
    .catch(error => {
      if (error.status === 404 && error.githubApiRead === true) return null;
      throw error;
    });
  if (!record) return { branch, head: null };
  const head = record.commit?.sha;
  requireThat(record.name === branch && isSha(head), 'DELIVER_BRANCH_UNAVAILABLE');
  const commit = await reader.get(`${root}/git/commits/${head}`);
  const [title, space, binding, reopened, requirements] =
    String(commit.message ?? '').trimEnd().split('\n');
  const owned = title === `Deliver #${issue.number}` && space === '' &&
    binding === `Issue: ${issue.id}` && /^Reopened: \d+$/.test(reopened ?? '') &&
    requirements?.startsWith('Shape: ');
  if (!owned) return { branch, head };
  const priorRequirements = requirements.slice('Shape: '.length);
  let previous;
  try { previous = JSON.parse(priorRequirements); }
  catch { return { branch, head }; }
  if (reopened !== `Reopened: ${lifecycle}` || typeof previous !== 'string' ||
      !samePublishedRequirements(previous, shape))
    return { branch, head, owned };
  requireThat(commit.sha === head && isSha(commit.tree?.sha) &&
    commit.parents?.length === 1 && isSha(commit.parents[0].sha),
  'DELIVER_BRANCH_UNAVAILABLE');
  const status = /^Status: (.+)$/m.exec(commit.message)?.[1];
  if (status && !['progress', 'completed'].includes(status))
    return { branch, head, owned };
  const mode = status ?? 'completed';
  const publication = mode === 'completed'
    ? await readDeliveryPublication(reader, issue, head) : {};
  if (publication.retired) return { branch, head, owned };
  return { branch, head, owned, mode, tree: commit.tree.sha,
    parent: commit.parents[0].sha,
    originalCandidate: /^Candidate: ([a-f0-9]{64})$/m.exec(commit.message)?.[1] ?? null,
    ...publication };
}

export function matchesDeliveryCheckpoint(checkpoint, candidate, mode = 'completed') {
  return (checkpoint?.mode ?? 'completed') === mode &&
    checkpoint?.tree === candidate.tree && checkpoint.parent === candidate.base;
}
