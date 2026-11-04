import { stages } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { digest, requireThat } from './identity.mjs';

// This only drives the existing ordered stage contract. There is no second
// lifecycle store: every next operation still enters StageRuntime admission.
// The installed launcher holds its host fence across this entire call.
export async function continueStages({ store, execute, inspect, wait,
  clock = Date.now, ciTimeout = 600000 }) {
  const initial = await store.load();
  let gap = false;
  for (const stage of Object.keys(stages)) {
    if (!initial[stage]) { gap = true; continue; }
    requireThat(!gap, 'NONCONTIGUOUS_STAGE_RECEIPTS');
    requireThat(initial[stage].outcome === stageSuccess[stage], 'STAGE_REQUIRES_CORRECTION');
  }
  if (initial.close) return { schemaVersion: 1, status: 'denied', code: 'DELIVERY_ALREADY_RECORDED' };
  let result;
  for (const stage of Object.keys(stages)) {
    if (initial[stage]) continue;
    await inspect();
    const deadline = clock() + ciTimeout;
    for (;;) {
      result = await execute(stage);
      // Only an explicit pre-effect observation of nonterminal CI can wait.
      // Unknown writes, failed reviews and arbitrary observation errors stop.
      if (result.code !== 'CI_WAITING' || result.status !== 'pending') break;
      if (clock() >= deadline) return result;
      await inspect();
      await wait(5000);
    }
    if (result.status !== 'completed') return result;
    const receipt = await store.get(result.receiptHash);
    const current = await store.load();
    requireThat(receipt.stage === stage && receipt.outcome === stageSuccess[stage] &&
      digest(current[stage]) === result.receiptHash, 'CONTINUATION_RECEIPT_CHANGED');
    await inspect();
  }
  return result;
}
