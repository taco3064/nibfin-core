import { repoPath } from './github-read.mjs';
import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';

export function deliveryBranch(issue) {
  return `nibfin/deliver-${issue.number}`;
}

export function deliveryLifecycle(context) {
  const reopened = context.pause.events?.filter(event => event.event === 'reopened')
    ?? [];
  requireThat(reopened.every(event => isId(event.id)), 'DELIVER_LIFECYCLE_UNAVAILABLE');
  return Math.max(0, ...reopened.map(event => event.id));
}

export function checkpointMessage(issue, { shape, lifecycle }, candidate) {
  return [`Deliver #${issue.number}`, '', `Issue: ${issue.id}`,
    `Reopened: ${lifecycle}`, `Shape: ${shape}`,
    `Candidate: ${digest(candidate)}`, ''].join('\n');
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
  const [title, space, binding, reopened, requirements, candidate] =
    String(commit.message ?? '').trimEnd().split('\n');
  const owned = title === `Deliver #${issue.number}` && space === '' &&
    binding === `Issue: ${issue.id}` && /^Reopened: \d+$/.test(reopened ?? '') &&
    requirements?.startsWith('Shape: ') && isDigest(requirements.slice(7)) &&
    candidate?.startsWith('Candidate: ') && isDigest(candidate.slice(11));
  if (!owned) return { branch, head };
  if (reopened !== `Reopened: ${lifecycle}` || requirements !== `Shape: ${shape}`)
    return { branch, head, owned };
  requireThat(commit.sha === head && isSha(commit.tree?.sha) &&
    commit.parents?.length === 1 && isSha(commit.parents[0].sha),
  'DELIVER_BRANCH_UNAVAILABLE');
  const related = await reader.list(`${root}/commits/${head}/pulls`);
  if (related.some(pr => pr.head?.sha === head &&
      pr.head.repo?.id === issue.repositoryId &&
      pr.state === 'closed' && pr.merged_at === null)) return { branch, head, owned };
  const existing = related.filter(pr => pr.head?.sha === head &&
    pr.head.repo?.id === issue.repositoryId && pr.base?.repo?.id === issue.repositoryId &&
    pr.head.ref === `nibfin/issue-${issue.number}-${head.slice(0, 12)}` &&
    pr.state === 'open' && pr.draft === false);
  requireThat(existing.length <= 1, 'DELIVER_BRANCH_UNAVAILABLE');
  const pr = existing[0];
  return { branch, head, owned, tree: commit.tree.sha, parent: commit.parents[0].sha,
    candidateHash: candidate.slice('Candidate: '.length), ...(pr ? {
      publication: { id: pr.node_id, number: pr.number, actorId: pr.user?.id,
        baseBranch: pr.base.ref, title: pr.title, body: pr.body },
    } : {}) };
}

export function matchesDeliveryCheckpoint(checkpoint, candidate) {
  return checkpoint?.tree === candidate.tree && checkpoint.parent === candidate.base &&
    checkpoint.candidateHash === digest(candidate);
}
