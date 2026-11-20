import { repoPath } from './github-read.mjs';
import { isId, requireThat } from './identity.mjs';

export function abandonedPullRequest(pr) {
  return pr.state === 'closed' && pr.merged === false;
}

export async function readBoundPullRequest(reader, issue, number, id) {
  requireThat(isId(number) && typeof id === 'string' && id.length > 0,
    'INVALID_PR_RECEIPT');
  const pr = await reader.get(`${repoPath(issue.repository)}/pulls/${number}`);
  requireThat(pr?.node_id === id && pr.number === number &&
    pr.base?.repo?.id === issue.repositoryId &&
    (pr.state === 'open' && pr.merged === false ||
      pr.state === 'closed' && typeof pr.merged === 'boolean'),
  'PR_RECEIPT_IDENTITY_CHANGED');
  return pr;
}

const publicationStages = ['commit-pr', 'review-pr', 'merge', 'close'];
const candidateStages = ['deliver', 'pre-accept-hooks', 'accept',
  'post-accept-hooks'];

// Only the stable native PR locator is needed to recognize abandonment. Keep
// historical receipts on disk, but exclude them from active stage decisions.
export async function observePublication(reader, issue, receipts, handoff) {
  const saved = receipts['commit-pr']?.outcome === 'published'
    ? receipts['commit-pr'].artifacts : null;
  const observed = new Map();
  async function read(number, id) {
    const key = `${number}:${id}`;
    if (!observed.has(key))
      observed.set(key, await readBoundPullRequest(reader, issue, number, id));
    return observed.get(key);
  }
  const pr = saved ? await read(saved.prNumber, saved.prId) : null;
  const abandoned = pr && abandonedPullRequest(pr);
  if (handoff && (!saved || abandoned))
    requireThat(handoff.issueId === issue.id, 'INVALID_OPEN_PR_ADOPTION');
  const adopted = handoff && (!saved || abandoned)
    ? await read(handoff.number, handoff.id) : null;
  const abandonedHandoff = adopted && abandonedPullRequest(adopted);
  const delivery = receipts.deliver;
  const candidate = delivery?.artifacts?.candidateHash;
  const restartCandidate = Boolean(abandoned && candidate &&
    candidate === saved.candidateHash || abandonedHandoff &&
    (delivery?.outcome !== 'ready' || !candidate || candidate === handoff.candidateHash));
  if (!abandoned && !abandonedHandoff) return { receipts, saved, pr, handoff, adopted };
  const current = { ...receipts };
  for (const stage of publicationStages) delete current[stage];
  if (restartCandidate) for (const stage of candidateStages) delete current[stage];
  return { receipts: current, saved: null, pr: null, restartCandidate,
    handoff: abandonedHandoff ? null : handoff, adopted,
    abandonedId: abandoned ? pr.node_id : adopted.node_id };
}

export const publicationTargetAbandoned = 'PUBLICATION_TARGET_ABANDONED';

export class PublicationBeforeWrite extends Error {
  constructor() {
    super(publicationTargetAbandoned);
    this.code = publicationTargetAbandoned;
  }
}
