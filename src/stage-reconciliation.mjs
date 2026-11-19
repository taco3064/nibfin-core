import { reconciledResult } from './reconciled-result.mjs';
import { join } from 'node:path';
import { digest } from './identity.mjs';
import { acquireHostFence, issueStatePath } from './host-fence.mjs';
import { inspectHostAdoption } from './host-adoption.mjs';
import { idleContainers } from './host-containers.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { issueProgress } from './issue-progress.mjs';
import { retryGitHubObservation } from './observation-failure.mjs';
import { assertHostSettlement } from './host-stage-settlement.mjs';
import { reconciledEvidence } from './reconciled-evidence.mjs';

// Reuse the launcher's admission before entering this observational path.
// No stage composer, Writer, mutation handler or retained-fence recovery runs here.
export async function reconcileDelivery(input, dependencies = {}) {
  const { context, runner, approval, stage, execution, closeExecution } = input;
  const { host, hostBytes, adopted, reader } = context;
  const issue = approval.record.issue;
  const root = issueStatePath(host.stateRoot, issue);
  const acquire = dependencies.acquire ?? acquireHostFence;
  const inspect = dependencies.inspect ?? inspectHostAdoption;
  const containers = dependencies.containers ?? idleContainers;
  const progress = dependencies.progress ?? issueProgress;
  const journal = dependencies.journal ??
    new OperationJournal(join(root, 'receipts'), issue);
  const pending = { schemaVersion: 1, stage, status: 'pending',
    code: 'CONTROLLER_RECONCILIATION_UNPROVEN' };
  let fence;
  try {
    fence = await acquire(root, { execution, issueId: issue.id,
      host: digest(hostBytes) });
  } catch { return pending; }
  const settled = async () => {
    await inspect(context);
    await fence.inspect();
    await assertHostSettlement(journal, () => containers(adopted.isolation, issue));
  };
  let result = pending;
  try {
    await settled();
    const selected = await progress(root, approval);
    const receipts = await selected.store.load();
    // Completed delivery keeps its independent proof path. Never downgrade a
    // failed delivery proof into a pre-merge interpretation.
    if (receipts.merge || receipts.close) {
      if (stage === 'continue') result = await retryGitHubObservation(() =>
        reconciledEvidence({ ...selected, approval, runner, closeExecution, reader }));
    } else {
      result = await retryGitHubObservation(() => reconciledResult({
        ...selected, root, approval, runner, stage, execution, reader,
      }));
    }
  } catch { result = pending; }
  try {
    // A failed proof may release only our own fence, after settlement is proven.
    await settled();
    await fence.release();
  } catch { return pending; }
  return result;
}
