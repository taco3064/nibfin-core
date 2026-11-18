import { join } from 'node:path';
import { makeBlockerReport } from './blocker-report.mjs';
import { saveBlockerReport } from './blocker-report-store.mjs';

export async function retainHostOutcome(root, context, stage, outcome,
  agentStarted = false) {
  if (outcome?.status === 'completed') return outcome;
  const code = outcome?.code;
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,95}$/.test(code))
    return outcome;
  const report = makeBlockerReport(context, stage, {
    producer: 'core-native', code, agentStarted, workflow: outcome.failure,
  });
  try { await saveBlockerReport(join(root, 'receipts'), report); }
  catch {
    // Reporting never changes settlement, fences or the result of delivery work.
    return { ...outcome, reportStatus: 'unavailable' };
  }
  return { ...outcome, reportReference: `report:${report.id}` };
}
