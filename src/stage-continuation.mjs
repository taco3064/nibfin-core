import { stages } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { digest, requireThat } from './identity.mjs';
import { equivalentCandidate } from './candidate-evidence.mjs';
import { pendingCIObservation } from './github-ci.mjs';

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
        (!reusable.includes(stage) ||
          !await equivalentCandidate(store, snapshot, artifacts.candidateHash)))) break;
    if (entry) current[stage] = entry;
  }
  return current;
}

export async function continueStages({
  store,
  execute,
  refreshRequirements = async () => false,
  inspect,
  wait,
  clock = Date.now,
  ciTimeout = 600000,
}) {
  const previous = await store.load();
  const changed = await refreshRequirements(previous);
  const initial = changed ? {} : await currentReceipts(store, previous);
  let gap = false;
  for (const stage of Object.keys(stages)) {
    if (!initial[stage]) {
      gap = true;
      continue;
    }
    requireThat(!gap, 'NONCONTIGUOUS_STAGE_RECEIPTS');
    if (initial[stage].outcome !== stageSuccess[stage]) {
      return { schemaVersion: 1, status: 'denied',
        code: 'STAGE_REQUIRES_CORRECTION', stage };
    }
  }
  if (initial.close)
    return { schemaVersion: 1, status: 'denied', code: 'DELIVERY_ALREADY_RECORDED' };
  let result;
  for (const stage of Object.keys(stages)) {
    if (initial[stage]) continue;
    await inspect();
    const deadline = clock() + ciTimeout;
    for (;;) {
      result = await execute(stage);
      // Only explicit pre-effect CI observations can wait.
      // Unknown writes, failed reviews and arbitrary observation errors stop.
      if (!pendingCIObservation(result.code) || result.status !== 'pending') break;
      if (clock() >= deadline) return result;
      await inspect();
      await wait(5000);
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
