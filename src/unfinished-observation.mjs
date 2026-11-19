import { digest, requireThat } from './identity.mjs';
import { issuePath } from './github-read.mjs';
import { executionIdentity, stages } from './stages.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { reconciledEvidence } from './reconciled-evidence.mjs';
import { unfinishedObservation } from './reconciliation-result.mjs';

const proven = value => requireThat(value, 'RECONCILIATION_EVIDENCE_UNPROVEN');

// Successful absence is an observation of current work, never a failed proof.
export async function observeDelivery(input) {
  const { approval, runner, reader, store, binding, stage } = input;
  const issue = approval.record.issue;
  proven((runner.target ?? runner).repositoryId === issue.repositoryId);
  const receipts = await store.load();
  const live = await reader.issue(issue);
  proven(live?.node_id === issue.id && live.number === issue.number &&
    live.url === `https://api.github.com${issuePath(issue)}` && !live.pull_request &&
    ['open', 'closed'].includes(live.state) && Array.isArray(live.labels) &&
    live.labels.every(label => typeof label?.name === 'string'));
  if (live.state === 'closed') {
    const result = await reconciledEvidence(input);
    proven(stage === 'continue' || stage === 'close');
    return stage === 'continue' ? result : {
      schemaVersion: 1, stage, status: 'completed', code: 'STAGE_COMPLETED',
      receiptHash: result.receiptHash,
    };
  }
  proven(!live.labels.some(label => label.name === 'delivered') && !receipts.close);
  for (const [name, entry] of Object.entries(receipts)) {
    proven(Object.hasOwn(stages, name) && entry?.schemaVersion === 1 &&
      entry.stage === name && digest(entry.binding) === digest(binding) &&
      entry.artifacts && typeof entry.artifacts === 'object' &&
      !Array.isArray(entry.artifacts) && !Object.hasOwn(entry, 'authorized') &&
      [stageSuccess[name], 'blocked', 'changes_required'].includes(entry.outcome) &&
      Array.isArray(entry.findings) &&
      entry.findings.every(value => typeof value === 'string' && value.trim()) &&
      (entry.outcome === stageSuccess[name]
        ? entry.findings.length === 0 : entry.findings.length > 0) &&
      Array.isArray(entry.references) && entry.references.length > 0 &&
      entry.references.every(value => typeof value === 'string' && value.trim()));
    executionIdentity(entry.execution, stages[name].role,
      approval.record.roles[stages[name].role]);
  }
  return unfinishedObservation(stage);
}
