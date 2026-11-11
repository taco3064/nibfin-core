import { stages } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';
import { equivalentCandidate } from './candidate-evidence.mjs';
import { integrationRepairRequired, pendingCIObservation } from './github-ci.mjs';
import { codexIdle } from './codex-bootstrap.mjs';

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
async function currentReceipts(store, previous) {
  const shape = previous.shape?.artifacts?.shapeHash;
  const candidate = previous.deliver?.artifacts?.candidateHash;
  const snapshot = candidate ? await store.get(candidate) : null;
  const reusable = ['pre-accept-hooks', 'accept', 'post-accept-hooks'];
  const current = {};
  for (const stage of Object.keys(stages)) {
    const entry = previous[stage];
    const artifacts = entry?.artifacts;
    if ((artifacts?.shapeHash && artifacts.shapeHash !== shape) ||
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
    !delivered || review.artifacts.shapeHash !== delivered.shapeHash ||
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
  const changed = await refreshRequirements(previous);
  const initial = changed ? {} : await currentReceipts(store, previous);
  const repairCandidate = async (rejected) => {
    await inspect();
    const repaired = await execute('deliver');
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
    await inspect();
    const deadline = clock() + ciTimeout;
    let retriedIdle = false;
    for (;;) {
      result = await execute(stage);
      if (stage === 'accept' && !retriedIdle && result.status === 'denied' &&
        result.code === codexIdle.code) {
        const receipt = await reportedReceipt(store, stage, result);
        if (receipt && await stoppedAgentCanRestart(store, stage, receipt)) {
          retriedIdle = true;
          await inspect();
          continue;
        }
      }
      // Only explicit pre-effect CI observations can wait.
      // Unknown writes and arbitrary observation errors stop.
      if (!pendingCIObservation(result.code) || result.status !== 'pending') break;
      if (clock() >= deadline) return result;
      await inspect();
      await wait(5000);
    }
    if (['review-pr', 'merge'].includes(stage) && repairIntegration &&
      integrationRepairRequired(result.code)) {
      await inspect();
      const repaired = await execute('deliver');
      if (repaired.status !== 'completed') return repaired;
      return continueStages({
        store, execute, refreshRequirements, inspect, wait, clock, ciTimeout,
        repairIntegration: false,
        correctionRepairs,
      });
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
    await inspect();
  }
  return result;
}
