import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { stages } from './stages.mjs';

export const controllerResultStage = stage => Object.hasOwn(stages, stage);
const resultStatuses = new Set(['completed', 'denied', 'pending']);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);

export function controllerResponse(value) {
  if (!controllerResultStage(value?.stage) || !resultStatuses.has(value.status) ||
    !safeCode(value.code)) return null;
  const { stage, status, code } = value;
  const response = { stage, status, code };
  if (isDigest(value.receiptHash)) response.receiptHash = value.receiptHash;
  if (Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0)
    response.retryAfterMs = value.retryAfterMs;
  if (value.retrySettled === true) response.retrySettled = true;
  if (value.pressureConfirmed === true) response.pressureConfirmed = true;
  const { number, head, base, runId, attempt, jobId, logsUnavailable } =
    value.failure ?? {};
  if ([number, runId, attempt, jobId].every(isId) && isSha(head) && isSha(base))
    response.failure = { number, head, base, runId, attempt, jobId,
      ...(logsUnavailable === true ? { logsUnavailable } : {}) };
  return response;
}

export function controllerRequestIdentity(issue, runner, stage, execution) {
  return { issue, stage, execution, repositoryId: runner.repositoryId,
    runnerId: runner.runnerId, runId: runner.runId, attempt: runner.attempt,
    jobId: runner.jobId };
}

function localEvidence(entry) {
  return entry ? { stage: entry.stage, receiptHash: digest(entry) } : null;
}

export async function recordControllerResult({ store, binding, request, producer,
  result, observed }) {
  const response = controllerResponse(result);
  // Completed closure retains the dedicated delivery proof.
  if (!response || response.stage === 'close') return;
  const { stage } = response;
  const terminal = await store.loadStage(stage);
  const worker = producer?.stage === stage ? producer : null;
  const produced = response.receiptHash ? await store.get(response.receiptHash) : null;
  if (produced) requireThat(worker && terminal && produced.stage === stage &&
    digest(terminal) === response.receiptHash &&
    digest(produced.execution) === digest(worker.execution),
  'CONTROLLER_RESULT_PRODUCER_UNPROVEN');
  const artifacts = produced?.artifacts ?? terminal?.artifacts;
  const shape = stage === 'shape' ? null : localEvidence(await store.loadStage('shape'));
  const publishedShape = stage === 'shape' ? null :
    localEvidence(await store.loadStage('publish-shape'));
  const candidateHash = artifacts?.candidateHash ?? (worker && observed?.candidateHash);
  const publication = publicationEvidence(produced, worker && observed?.publication) ||
    (['review-pr', 'merge'].includes(stage) ?
      publicationEvidence(await store.loadStage('commit-pr')) : null);
  const evidence = { terminal: localEvidence(terminal), shape, publishedShape,
    ...(isDigest(candidateHash) ? { candidateHash } : {}),
    ...(publication ? { publication } : {}) };
  const record = { schemaVersion: 1, kind: 'controller-result',
    binding, request, producer: worker, response, evidence };
  const ref = await store.put(record);
  await store.replaceControllerResult(ref);
}

function publicationEvidence(produced, current) {
  const { prId: id, prNumber: number, head, candidateHash, mergeCommit } =
    produced?.artifacts ?? {};
  if (['published', 'merged'].includes(produced?.outcome) && isId(number) &&
    typeof id === 'string' && isSha(head) && isDigest(candidateHash))
    return { id, number, head, candidateHash,
      merged: produced.outcome === 'merged', ...(mergeCommit ? { mergeCommit } : {}) };
  return current;
}

// Project only facts used for a stage result, never the observed approval,
// native response, Issue text, credentials or CI logs.
export function resultObservation(observed) {
  const { pr, candidate } = observed;
  const candidateHash = candidate ? digest(candidate) : null;
  const publicationCandidate = observed.receipts?.['commit-pr']?.artifacts?.candidateHash
    ?? candidateHash;
  const publication = pr && isId(pr.number) && typeof pr.id === 'string' &&
    isSha(pr.head) && isDigest(publicationCandidate) ? {
      id: pr.id, number: pr.number, head: pr.head, merged: pr.merged === true,
      candidateHash: publicationCandidate,
      ...(pr.merged === true ? { mergeCommit: pr.mergeCommit } : {}),
    } : null;
  return { candidateHash, publication };
}
