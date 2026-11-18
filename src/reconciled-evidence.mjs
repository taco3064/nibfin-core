import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { stages, executionIdentity } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { equivalentCandidate } from './candidate-evidence.mjs';
import { issuePath, repoPath } from './github-read.mjs';
import { readMergeIdentity } from './github-merge.mjs';

const proven = value => requireThat(value, 'RECONCILIATION_EVIDENCE_UNPROVEN');

// The store and its namespace are selected by Controller admission, never stdin.
export async function reconciledEvidence({
  store, binding, approval, runner, closeExecution, reader,
}) {
  const issue = approval.record.issue;
  proven((runner.target ?? runner).repositoryId === issue.repositoryId);
  const receipts = await store.load();
  for (const [stage, definition] of Object.entries(stages)) {
    const entry = receipts[stage];
    proven(entry?.schemaVersion === 1 && entry.stage === stage &&
      digest(entry.binding) === digest(binding) &&
      entry.outcome === stageSuccess[stage] &&
      Array.isArray(entry.findings) && entry.findings.length === 0 &&
      Array.isArray(entry.references) && entry.references.length > 0 &&
      entry.references.every(ref => typeof ref === 'string' && ref.trim()));
    executionIdentity(entry.execution, definition.role,
      approval.record.roles[definition.role]);
  }
  proven(receipts.shape.execution.id !== receipts['validate-shape'].execution.id &&
    receipts.shape.execution.sessionId !==
      receipts['validate-shape'].execution.sessionId);
  const close = receipts.close;
  proven(digest(close.execution) === digest(closeExecution));
  const artifacts = close.artifacts;
  proven(isDigest(artifacts.shapeHash) && isDigest(artifacts.candidateHash) &&
    isId(artifacts.prNumber) && typeof artifacts.prId === 'string' &&
    artifacts.prId.length > 0 && isSha(artifacts.head) && isSha(artifacts.base) &&
    isSha(artifacts.mergeCommit));
  const candidate = await store.get(artifacts.candidateHash);
  proven(candidate.repositoryId === issue.repositoryId &&
    candidate.repository === issue.repository && candidate.issueId === issue.id &&
    isSha(candidate.base) && isSha(candidate.tree));
  const shape = await store.get(artifacts.shapeHash);
  proven(typeof shape === 'string' && shape.trim());
  const reusable = ['pre-accept-hooks', 'accept', 'post-accept-hooks', 'review-pr'];
  for (const [stage, entry] of Object.entries(receipts)) {
    const current = entry.artifacts;
    proven(current?.shapeHash === artifacts.shapeHash);
    if (!['shape', 'validate-shape', 'publish-shape'].includes(stage)) {
      proven(current.candidateHash === artifacts.candidateHash ||
        reusable.includes(stage) &&
        await equivalentCandidate(store, candidate, current.candidateHash));
    }
  }
  const published = receipts['commit-pr'].artifacts;
  proven(published.prId === artifacts.prId &&
    published.prNumber === artifacts.prNumber && isSha(published.head) &&
    published.base === candidate.base);
  const review = receipts['review-pr'].artifacts;
  proven(review.prId === artifacts.prId && review.prNumber === artifacts.prNumber &&
    review.head === published.head);
  const merged = receipts.merge.artifacts;
  for (const field of ['shapeHash', 'candidateHash', 'prId', 'prNumber', 'head',
    'base', 'mergeCommit']) proven(merged[field] === artifacts[field]);
  let testMerge;
  for (const current of [merged, artifacts]) {
    const ci = await store.get(current.ciHash);
    proven(ci.prId === current.prId && ci.head === current.head &&
      ci.base === current.base && isSha(ci.testedSha) && isSha(ci.testMerge));
    if (testMerge) proven(ci.testMerge === testMerge);
    testMerge = ci.testMerge;
  }
  proven(receipts.deliver.execution.id !== receipts.accept.execution.id &&
    receipts.deliver.execution.sessionId !== receipts.accept.execution.sessionId &&
    receipts.deliver.execution.id !== receipts['review-pr'].execution.id &&
    receipts.deliver.execution.sessionId !== receipts['review-pr'].execution.sessionId);
  const live = await reader.issue(issue);
  proven(live.node_id === issue.id && live.number === issue.number &&
    live.url === `https://api.github.com${issuePath(issue)}` && !live.pull_request &&
    live.state === 'closed' &&
    live.labels?.some(label => label.name === 'delivered'));
  const pr = await reader.get(
    `${repoPath(issue.repository)}/pulls/${artifacts.prNumber}`);
  proven(pr.node_id === artifacts.prId && pr.number === artifacts.prNumber &&
    pr.base?.repo?.id === issue.repositoryId &&
    pr.head?.repo?.id === issue.repositoryId &&
    pr.state === 'closed' && pr.merged === true &&
    pr.head.sha === artifacts.head &&
    pr.merge_commit_sha === artifacts.mergeCommit);
  // A merged PR's live base can advance. Prove the original base from commits.
  await readMergeIdentity(reader, repoPath(issue.repository), {
    head: artifacts.head, base: artifacts.base, merge: artifacts.mergeCommit,
    testMerge,
  }, 'RECONCILIATION_EVIDENCE_UNPROVEN');
  const commit = await reader.get(
    `${repoPath(issue.repository)}/git/commits/${artifacts.head}`);
  proven(commit.sha === artifacts.head && commit.tree?.sha === candidate.tree &&
    commit.parents?.length === 1 && commit.parents[0].sha === candidate.base);
  return { schemaVersion: 1, status: 'completed', stage: 'continue',
    terminalStage: 'close', receiptHash: digest(close) };
}
