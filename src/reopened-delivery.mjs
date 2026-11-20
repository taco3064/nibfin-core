import { repoPath } from './github-read.mjs';
import { isId, isSha, requireThat } from './identity.mjs';

// A native open Issue after our confirmed close is a new owner continuation.
// Reuse a merge still on main; after a rollback, re-enter current requirements.
// Failed reads never prove either case. No receipt or provider write occurs here.
export async function readReopenedDelivery({ reader, issue, live, receipts,
  observeMain }) {
  if (live.state !== 'open' || receipts.close?.outcome !== 'closed' &&
    receipts.merge?.outcome !== 'merged')
    return { changed: false, close: false };
  requireThat(live.node_id === issue.id && live.number === issue.number,
    'REPOSITORY_ISSUE_IDENTITY_CHANGED');
  const reference = [receipts.close, receipts.merge, receipts['commit-pr']]
    .map(entry => entry?.artifacts).find(value => isId(value?.prNumber));
  if (!reference) return { changed: true, close: false };
  const pr = await reader.get(`${repoPath(issue.repository)}/pulls/` +
    reference.prNumber);
  requireThat(pr.number === reference.prNumber &&
    (!reference.prId || pr.node_id === reference.prId) &&
    pr.base?.repo?.id === issue.repositoryId &&
    pr.head?.repo?.id === issue.repositoryId, 'PR_RECEIPT_IDENTITY_CHANGED');
  if (pr.merged !== true) return { changed: true, close: false };
  const merge = pr.merge_commit_sha;
  requireThat(pr.state === 'closed' && isSha(merge), 'MERGE_READBACK_REQUIRED');
  const { head } = await observeMain();
  requireThat(isSha(head), 'CURRENT_MAIN_UNAVAILABLE');
  const comparison = await reader.get(
    `${repoPath(issue.repository)}/compare/${merge}...${head}`);
  requireThat(['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status)
    && isSha(comparison.merge_base_commit?.sha), 'CURRENT_MAIN_UNAVAILABLE');
  const retained = ['ahead', 'identical'].includes(comparison.status);
  if (retained) requireThat(comparison.merge_base_commit.sha === merge,
    'CURRENT_MAIN_UNAVAILABLE');
  if (!retained) return { changed: true, close: false };
  if (receipts.merge?.outcome !== 'merged') {
    // Native work exists. Do not call it absent or fabricate an old execution;
    // the existing observational reconciliation owns incomplete local proofs.
    return { changed: false, close: false, reconcile: true };
  }
  return { changed: false, close: receipts.close?.outcome === 'closed', ...(!isSha(
    receipts.merge.artifacts?.mergeCommit) ? {
      recoveredMerge: { ...receipts.merge,
        artifacts: { ...receipts.merge.artifacts, mergeCommit: merge } },
    } : {}) };
}
