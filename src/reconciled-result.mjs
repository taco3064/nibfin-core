import { digest, isDigest, isSha, requireThat } from './identity.mjs';
import { controllerRequestIdentity, controllerResponse }
  from './controller-result.mjs';
import { hostExecution } from './host-execution.mjs';
import { repoPath } from './github-read.mjs';
import { issueRequirementsChanged, stages } from './stages.mjs';
import { githubApiWaiting, githubReadWaiting } from './observation-failure.mjs';
import { stageSuccess } from './stage-runtime.mjs';

const proves = (value, code = 'CONTROLLER_RESULT_CONTRADICTORY') =>
  requireThat(value, code);

async function evidenceObject(store, ref) {
  try { return await store.get(ref); }
  catch (error) {
    if (error.code === 'ENOENT') proves(false, 'CONTROLLER_RESULT_EVIDENCE_MISSING');
    throw error;
  }
}

async function activeReceipt(store, reference, binding) {
  if (reference === null) return null;
  proves(reference && Object.hasOwn(stages, reference.stage) &&
    isDigest(reference.receiptHash));
  const receipt = await store.loadStage(reference.stage).catch(error => {
    if (error.code === 'ENOENT') proves(false, 'CONTROLLER_RESULT_EVIDENCE_MISSING');
    throw error;
  });
  proves(receipt && receipt.stage === reference.stage &&
    digest(receipt) === reference.receiptHash &&
    digest(receipt.binding) === digest(binding), 'CONTROLLER_RESULT_EVIDENCE_CHANGED');
  return receipt;
}

async function verifyCandidate(store, issue, ref) {
  proves(isDigest(ref));
  const candidate = await evidenceObject(store, ref);
  proves(candidate.repository === issue.repository &&
    candidate.repositoryId === issue.repositoryId && candidate.issueId === issue.id &&
    isSha(candidate.tree) && isSha(candidate.base));
  return candidate;
}

async function verifyPublication(reader, store, issue, publication) {
  const { number, id, head, candidateHash, merged, mergeCommit } = publication;
  proves(Number.isSafeInteger(number) && number > 0 && typeof id === 'string' &&
    isSha(head) && typeof merged === 'boolean' && (!merged || isSha(mergeCommit)));
  const root = repoPath(issue.repository);
  const pr = await reader.get(`${root}/pulls/${number}`);
  proves(pr.number === number && pr.node_id === id &&
    pr.base?.repo?.id === issue.repositoryId &&
    pr.head?.repo?.id === issue.repositoryId && pr.head.sha === head &&
    pr.state === (merged ? 'closed' : 'open') && pr.merged === merged &&
    (!merged || pr.merge_commit_sha === mergeCommit),
  'CONTROLLER_RESULT_PUBLICATION_CHANGED');
  const candidate = await verifyCandidate(store, issue, candidateHash);
  const commit = await reader.get(`${root}/git/commits/${head}`);
  proves(commit.sha === head && commit.tree?.sha === candidate.tree &&
    commit.parents?.length === 1 && commit.parents[0].sha === candidate.base,
  'CONTROLLER_RESULT_PUBLICATION_CHANGED');
}

// Read-only and invoked under the reconciliation invocation's own fence.
export async function reconciledResult({ store, binding, approval, runner, reader,
  stage, execution, live }) {
  if (!store.readControllerResult) return null;
  let ref, record;
  try {
    ref = await store.readControllerResult();
    if (!ref) return null;
    record = await evidenceObject(store, ref);
  } catch (error) {
    if (error.code === 'CONTROLLER_RESULT_EVIDENCE_MISSING') throw error;
    proves(false, 'CONTROLLER_RESULT_CORRUPT');
  }
  const issue = approval.record.issue;
  const request = controllerRequestIdentity(issue, runner, stage, execution);
  proves(record?.schemaVersion === 1 && record.kind === 'controller-result' &&
    digest(record) === ref && digest(record.binding) === digest(binding));
  // The pointer can refer to a different valid request or attempt. It is never
  // proof of our response. Continue with the existing unfinished observation.
  if (digest(record.request) !== digest(request)) return null;
  const response = controllerResponse(record.response);
  proves(response && digest(response) === digest(record.response) &&
    response.stage !== 'close' && (stage === 'continue' || response.stage === stage));
  const { producer, evidence } = record;
  if (producer !== null) {
    proves(producer?.stage === response.stage &&
      Number.isSafeInteger(producer.iteration) && producer.iteration >= 0);
    const expected = hostExecution(runner, producer.stage, producer.iteration);
    proves(digest(producer.execution) === digest(expected) &&
      expected.actorId === approval.record.roles[expected.role]);
  }
  proves(evidence && Object.hasOwn(evidence, 'terminal') &&
    Object.hasOwn(evidence, 'shape') && Object.hasOwn(evidence, 'publishedShape'));
  const terminal = await activeReceipt(store, evidence.terminal, binding);
  if (response.receiptHash) proves(producer && terminal &&
    evidence.terminal.receiptHash === response.receiptHash &&
    digest(terminal.execution) === digest(producer.execution) &&
    (terminal.outcome === stageSuccess[response.stage]) ===
      (response.status === 'completed'));
  const shape = response.stage === 'shape' ? terminal :
    await activeReceipt(store, evidence.shape, binding);
  const publishedShape = await activeReceipt(store, evidence.publishedShape, binding);
  if (shape) {
    const receipts = { shape, 'publish-shape': publishedShape };
    proves(!await issueRequirementsChanged(live, receipts,
      hash => evidenceObject(store, hash)), 'CONTROLLER_RESULT_REQUIREMENTS_CHANGED');
  }
  if (evidence.candidateHash) await verifyCandidate(store, issue, evidence.candidateHash);
  if (evidence.publication) {
    if (response.failure) {
      const { number, head } = evidence.publication;
      proves(response.failure.number === number && response.failure.head === head);
    }
    await verifyPublication(reader, store, issue, evidence.publication);
  } else {
    const readWait = response.status === 'pending' &&
      [githubReadWaiting, githubApiWaiting].includes(response.code);
    proves(readWait || !['review-pr', 'merge'].includes(response.stage) &&
      !(response.stage === 'commit-pr' && response.status === 'completed'),
    'CONTROLLER_RESULT_PUBLICATION_UNPROVEN');
  }
  const { stage: terminalStage, ...outcome } = response;
  return { schemaVersion: 1, stage, terminalStage, ...outcome,
    disposition: 'recovered-result', resultReference: ref,
    ...(response.retrySettled && runner.target ? {
      retryRun: runner.runId, retryAttempt: runner.attempt,
    } : {}) };
}
