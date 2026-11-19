import { premergeResult } from './premerge-result.mjs';
import { hostExecution } from './host-execution.mjs';
import { digest, isDigest, isSha, isId, requireThat } from './identity.mjs';
import { stages, executionIdentity } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { repoPath, issuePath } from './github-read.mjs';
import { ControllerResult, controllerRequest } from './controller-result.mjs';

const proven = value => requireThat(value, 'CONTROLLER_RESULT_UNPROVEN');

export async function reconciledResult(input) {
  const { root, store, binding, approval, runner, stage, execution, reader } = input;
  const request = controllerRequest({ approval, runner, stage, execution, binding });
  const evidence = new ControllerResult(root, request, store);
  const { record, hash } = await evidence.read();
  const result = record.result;
  const terminal = result.stage;
  proven(premergeResult(terminal, result.status));
  proven(stage === 'continue' || stage === terminal);
  proven(['completed', 'denied', 'pending'].includes(result.status) &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(result.code));
  const receipts = await store.load();
  proven(digest(Object.fromEntries(Object.entries(receipts)
    .map(([name, receipt]) => [name, digest(receipt)]))) === digest(record.receipts));
  const receipt = receipts[terminal];
  proven(Object.hasOwn(stages, record.executionStage) &&
    Number.isSafeInteger(record.iteration) && record.iteration >= 0 &&
    digest(record.execution) === digest(hostExecution(runner,
      record.executionStage, record.iteration)));
  if (result.receiptHash) {
    proven(isDigest(result.receiptHash) && receipt &&
      digest(receipt) === result.receiptHash &&
      digest(receipt.binding) === digest(binding) &&
      digest(receipt.execution) === digest(record.execution));
    proven((receipt.outcome === stageSuccess[terminal]) ===
      (result.status === 'completed'));
  } else proven(result.status !== 'completed');
  const role = stages[record.executionStage].role;
  executionIdentity(record.execution, role, approval.record.roles[role]);
  for (const key of ['runId', 'attempt', 'jobId'])
    proven(record.execution[key] === runner[key]);
  proven((runner.target ?? runner).repositoryId === approval.record.issue.repositoryId);
  const issue = approval.record.issue;
  const live = await reader.issue(issue);
  proven(live.node_id === issue.id && live.number === issue.number &&
    live.url === `https://api.github.com${issuePath(issue)}` && !live.pull_request &&
    live.state === 'open' && !live.labels?.some(label => label.name === 'delivered'));
  proven(!receipts.merge && !receipts.close);
  const published = receipts['commit-pr']?.artifacts;
  const artifacts = receipt?.artifacts;
  if (artifacts?.candidateHash) {
    const candidate = await store.get(artifacts.candidateHash);
    proven(candidate.repositoryId === issue.repositoryId &&
      candidate.repository === issue.repository && candidate.issueId === issue.id);
  }
  if (published) {
    proven(isId(published.prNumber) && isSha(published.head));
    if (result.receiptHash && ['commit-pr', 'review-pr'].includes(terminal)) {
      for (const key of ['prId', 'prNumber', 'head', 'candidateHash'])
        proven(artifacts[key] === published[key]);
    }
    const candidate = await store.get(published.candidateHash);
    proven(candidate.repositoryId === issue.repositoryId &&
      candidate.repository === issue.repository && candidate.issueId === issue.id &&
      isSha(candidate.tree) && candidate.base === published.base);
    const pr = await reader.get(
      `${repoPath(issue.repository)}/pulls/${published.prNumber}`);
    proven(pr.node_id === published.prId && pr.number === published.prNumber &&
      pr.state === 'open' && pr.merged === false &&
      pr.head?.repo?.id === issue.repositoryId &&
      pr.base?.repo?.id === issue.repositoryId && pr.head.sha === published.head);
    const commit = await reader.get(
      `${repoPath(issue.repository)}/git/commits/${published.head}`);
    proven(commit.sha === published.head && commit.tree?.sha === candidate.tree &&
      commit.parents?.length === 1 && commit.parents[0].sha === candidate.base);
  } else proven(!['commit-pr', 'review-pr', 'merge'].includes(terminal));
  return { ...result, stage, terminalStage: terminal,
    recoveredResult: true, resultHash: hash };
}
