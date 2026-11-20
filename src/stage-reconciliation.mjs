import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './identity.mjs';
import {
  acquireHostFence, issueStatePath, privateHostDirectory,
} from './host-fence.mjs';
import { inspectHostAdoption } from './host-adoption.mjs';
import { idleContainers } from './host-containers.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { issueProgress } from './issue-progress.mjs';
import {
  githubApiWaiting, githubReadWaiting, githubReadWait, retryGitHubObservation,
} from './observation-failure.mjs';
import { assertHostSettlement } from './host-stage-settlement.mjs';
import { observeDelivery } from './unfinished-observation.mjs';
import { stages } from './stages.mjs';
import { reconciledResult } from './reconciled-result.mjs';
import { reconciliationReason } from './reconciliation-result.mjs';

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
  if (stage !== 'continue' && !Object.hasOwn(stages, stage)) return pending;
  let fence;
  try {
    if (!dependencies.acquire) {
      await privateHostDirectory(host.stateRoot);
      await mkdir(root, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    fence = await acquire(root, { execution, issueId: issue.id,
      host: digest(hostBytes) });
  } catch (error) { return { ...pending, reason: reconciliationReason(error) }; }
  const settled = async () => {
    await inspect(context);
    await fence.inspect();
    await assertHostSettlement(journal, () => containers(adopted.isolation, issue));
  };
  let result = pending;
  try {
    if (!dependencies.journal) {
      const receipts = join(root, 'receipts');
      await mkdir(receipts, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      await privateHostDirectory(receipts);
    }
    await settled();
    const selected = await progress(root, approval);
    const retry = dependencies.retryObservation ?? retryGitHubObservation;
    result = await retry(() => observeDelivery({
      ...selected, approval, runner, closeExecution, reader, stage,
      recoverResult: live => reconciledResult({
        ...selected, approval, runner, reader, stage, execution, live,
      }),
    }), { stage: true });
  } catch (error) {
    const waiting = githubReadWait(error, undefined, { stage: true });
    result = waiting ? { schemaVersion: 1, stage, ...waiting } :
      { ...pending, reason: reconciliationReason(error) };
  }
  try {
    // A failed proof may release only our own fence, after settlement is proven.
    await settled();
    await fence.release();
  } catch (error) { return { ...pending, reason: reconciliationReason(error) }; }
  return result.code === githubReadWaiting ||
    result.code === githubApiWaiting
    ? { ...result, retrySettled: true, ...(runner.target ? {
      retryRun: runner.runId, retryAttempt: runner.attempt,
    } : {}) } : result;
}
