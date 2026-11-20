import { repoPath } from './github-read.mjs';
import { isDigest, isId, isSha, requireThat } from './identity.mjs';

// The pin comes only from the root-owned host adoption. This establishes a
// publication target. New Core still obtains its own Shape, Accept and Review.
export async function readAdoptedOpenPr(reader, issue, pin, actorId,
  { ignoreAbandoned = false } = {}) {
  requireThat(pin.issueId === issue.id && isId(pin.number) &&
    typeof pin.id === 'string' && isSha(pin.head) && isSha(pin.tree) &&
    isSha(pin.parent) && isDigest(pin.candidateHash), 'INVALID_OPEN_PR_ADOPTION');
  const root = repoPath(issue.repository);
  const pr = await reader.get(`${root}/pulls/${pin.number}`);
  requireThat(
    pr.node_id === pin.id && pr.number === pin.number && pr.user?.id === actorId &&
      pr.base?.repo?.id === issue.repositoryId && pr.base.ref === 'main',
    'OPEN_PR_ADOPTION_CHANGED',
  );
  if (ignoreAbandoned && pr.state === 'closed' && pr.merged === false) return null;
  const commit = await reader.get(`${root}/git/commits/${pin.head}`);
  const branch = pr.head?.ref;
  requireThat(
      pr.state === 'open' && pr.draft === false && pr.merged === false &&
      pr.head?.sha === pin.head && pr.head.repo?.id === issue.repositoryId &&
      typeof branch === 'string' &&
      new RegExp(`^nibfin/issue-${issue.number}-[a-f0-9]{12}$`).test(branch) &&
      commit.sha === pin.head && commit.tree?.sha === pin.tree &&
      commit.parents?.length === 1 && commit.parents[0].sha === pin.parent &&
      typeof commit.message === 'string' &&
      commit.message.trim().endsWith(`Candidate: ${pin.candidateHash}`),
    'OPEN_PR_ADOPTION_CHANGED',
  );
  const ref = await reader.get(`${root}/git/ref/heads/${branch}`);
  requireThat(ref.object?.sha === pin.head, 'OPEN_PR_ADOPTION_CHANGED');
  return { id: pin.id, number: pin.number, repositoryId: issue.repositoryId,
    head: pin.head, headBranch: branch, state: 'open' };
}
