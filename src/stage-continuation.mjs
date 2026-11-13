import { stages, samePublishedRequirements } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';
import { enforcementPaths, equivalentCandidate } from './candidate-evidence.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { codexIdle } from './codex-bootstrap.mjs';
import { requiredCheckFailed } from './ci-recovery.mjs';
import {
  githubReadDelay, githubReadWaiting, retryGitHubObservation,
} from './observation-failure.mjs';

const agentStages = new Set(['shape', 'validate-shape', 'deliver', 'accept']);
const correctionStages = new Set(['accept', 'review-pr']);

async function stoppedAgentCanRestart(store, stage, receipt) {
  if (!agentStages.has(stage) || receipt.outcome !== 'blocked' ||
    typeof receipt.execution?.id !== 'string' || receipt.references?.length !== 1)
    return false;
  const reference = receipt.references[0];
  if (!/^evidence:[a-f0-9]{64}$/.test(reference)) return false;
  const proof = await store.get(reference.slice('evidence:'.length)).catch(() => null);
  return proof?.executionId === receipt.execution.id &&
    isDigest(proof.terminationHash) && proof.code === codexIdle.code;
}

async function reportedReceipt(store, stage, result) {
  if (result.stage !== stage || !result.receiptHash) return null;
  const receipt = (await store.load())[stage];
  return receipt?.stage === stage && digest(receipt) === result.receiptHash
    ? receipt : null;
}

// This only drives the existing ordered stage contract. There is no second
// lifecycle store: every next operation still enters StageRuntime admission.
// The installed launcher holds its host fence across this entire call.
async function sameShape(store, left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const [first, second] = await Promise.all([store.get(left), store.get(right)]);
  return samePublishedRequirements(first, second);
}

async function currentReceipts(store, previous, repairDelivery) {
  const shape = previous.shape?.artifacts?.shapeHash;
  const candidate = previous.deliver?.artifacts?.candidateHash;
  const snapshot = candidate ? await store.get(candidate) : null;
  const reusable = ['pre-accept-hooks', 'accept', 'post-accept-hooks'];
  const current = {};
  for (const stage of Object.keys(stages)) {
    const entry = previous[stage];
    if (stage === 'deliver' && repairDelivery &&
      (entry?.outcome === 'changes_required' ||
        (snapshot?.paths && enforcementPaths(snapshot.paths).length))) break;
    const artifacts = entry?.artifacts;
    if ((artifacts?.shapeHash && !await sameShape(store, artifacts.shapeHash, shape)) ||
      (artifacts?.candidateHash && artifacts.candidateHash !== candidate &&
        (!reusable.includes(stage) || entry.outcome !== stageSuccess[stage] ||
          !await equivalentCandidate(store, snapshot, artifacts.candidateHash)))) break;
    if (entry) current[stage] = entry;
  }
  return current;
}

async function canReuseReview(store) {
  const receipts = await store.load();
  const review = receipts['review-pr'];
  const published = receipts['commit-pr'];
  const delivered = receipts.deliver?.artifacts;
  if (review?.outcome !== 'approved' || published?.outcome !== 'published' ||
    !delivered || !await sameShape(store, review.artifacts.shapeHash,
      delivered.shapeHash) ||
    review.artifacts.prId !== published.artifacts.prId ||
    review.artifacts.prNumber !== published.artifacts.prNumber) return false;
  return equivalentCandidate(store, await store.get(delivered.candidateHash),
    review.artifacts.candidateHash);
}

export async function continueStages({
  store,
  execute,
  refreshRequirements = async () => false,
  inspect,
  wait,
  clock = Date.now,
  ciTimeout = 600000,
  repairIntegration = true,
  correctionRepairs = 2,
}) {
  const previous = await store.load();
  const inspectCurrent = () => retryGitHubObservation(inspect,
    { wait, clock, timeout: ciTimeout });
  const changed = await retryGitHubObservation(() => refreshRequirements(previous),
    { wait, clock, timeout: ciTimeout });
  const initial = changed ? {} :
    await currentReceipts(store, previous, correctionRepairs > 0);
  const repairCandidate = async (rejected, ciFailure) => {
    await inspectCurrent();
    const repaired = await execute('deliver', ciFailure);
    if (repaired.status !== 'completed') return repaired;
    const delivery = await store.get(repaired.receiptHash);
    const candidate = await store.get(delivery.artifacts.candidateHash);
    if (await equivalentCandidate(store, candidate, rejected.artifacts.candidateHash)) {
      return { schemaVersion: 1, stage: 'deliver', status: 'denied',
        code: 'CORRECTION_DID_NOT_CHANGE_CANDIDATE' };
    }
    return continueStages({
      store, execute, refreshRequirements, inspect, wait, clock, ciTimeout,
      repairIntegration, correctionRepairs: correctionRepairs - 1,
    });
  };
  let gap = false;
  for (const stage of Object.keys(stages)) {
    if (!initial[stage]) {
      gap = true;
      continue;
    }
    requireThat(!gap, 'NONCONTIGUOUS_STAGE_RECEIPTS');
    if (initial[stage].outcome !== stageSuccess[stage]) {
      if (correctionStages.has(stage) && initial[stage].outcome === 'changes_required' &&
        correctionRepairs > 0) return repairCandidate(initial[stage]);
      if (await stoppedAgentCanRestart(store, stage, initial[stage])) {
        delete initial[stage];
        gap = true;
        continue;
      }
      return { schemaVersion: 1, status: 'denied',
        code: 'STAGE_REQUIRES_CORRECTION', stage };
    }
  }
  if (initial.close)
    return { schemaVersion: 1, status: 'denied', code: 'DELIVERY_ALREADY_RECORDED' };
  let result;
  for (const stage of Object.keys(stages)) {
    if (initial[stage] || stage === 'review-pr' && await canReuseReview(store))
      continue;
    await inspectCurrent();
    const deadline = clock() + ciTimeout;
    let retriedIdle = false;
    let readRetries = 0;
    let ciPolls = 0;
    for (;;) {
      result = await execute(stage);
      if (stage === 'deliver' && correctionRepairs > 0 &&
        result.code === 'STAGE_REQUIRES_CORRECTION' &&
        (await reportedReceipt(store, stage, result))?.outcome === 'changes_required') {
        correctionRepairs--;
        await inspectCurrent();
        continue;
      }
      if (stage === 'accept' && !retriedIdle && result.status === 'denied' &&
        result.code === codexIdle.code) {
        const receipt = await reportedReceipt(store, stage, result);
        if (receipt && await stoppedAgentCanRestart(store, stage, receipt)) {
          retriedIdle = true;
          await inspectCurrent();
          continue;
        }
      }
      // Only recognized pre-effect waits can re-enter the same stage.
      const readWaiting = result.code === githubReadWaiting;
      if (result.status !== 'pending' ||
        !(pendingCIObservation(result.code) || readWaiting)) break;
      const delay = readWaiting
        ? githubReadDelay(result.retryAfterMs, readRetries++)
        : Math.min(60000, 15000 * 2 ** ciPolls++);
      if (clock() + delay > deadline) return result;
      await wait(delay);
      if (!readWaiting) await inspectCurrent();
    }
    if (['review-pr', 'merge'].includes(stage) && repairIntegration &&
      integrationRepairRequired(result.code)) {
      await inspectCurrent();
      const repaired = await execute('deliver');
      if (repaired.status !== 'completed') return repaired;
      return continueStages({
        store, execute, refreshRequirements, inspect, wait, clock, ciTimeout,
        repairIntegration: false,
        correctionRepairs,
      });
    }
    if (['review-pr', 'merge'].includes(stage) && result.status === 'denied' &&
      result.code === requiredCheckFailed && result.failure && correctionRepairs > 0) {
      const published = (await store.load())['commit-pr'];
      if (published?.outcome === 'published')
        return repairCandidate(published, result.failure);
    }
    if (correctionStages.has(stage) && result.status === 'denied' &&
      correctionRepairs > 0 && result.code === 'STAGE_REQUIRES_CORRECTION' &&
      result.receiptHash) {
      const rejected = await reportedReceipt(store, stage, result);
      if (rejected?.outcome === 'changes_required') {
        return repairCandidate(rejected);
      }
    }
    if (result.status !== 'completed') return result;
    const receipt = await store.get(result.receiptHash);
    const current = await store.load();
    requireThat(
      result.stage === stage &&
        receipt.stage === stage &&
        receipt.outcome === stageSuccess[stage] &&
        digest(current[stage]) === result.receiptHash,
      'CONTINUATION_RECEIPT_CHANGED',
    );
    await inspectCurrent();
  }
  return result;
}
