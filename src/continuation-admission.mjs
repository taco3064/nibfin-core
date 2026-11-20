import { join } from 'node:path';
import { readProtectedApproval } from './github-approval.mjs';
import { inspectHostAdoption, loadHostAdoption } from './host-adoption.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { requireUnpaused } from './pause.mjs';
import { observeWorkEligibility } from './work-eligibility.mjs';
import { requireActiveIssue } from './issue-eligibility.mjs';
import { digest, requireThat } from './identity.mjs';
import { selectRecoverySlot } from './recovery-slot.mjs';
import { recoverAdoptedDeliverFence } from './recover-deliver-fence.mjs';
import { observeRecoveryInvocation } from './recovery-invocation.mjs';

// This preflight grants no stage execution. Later ordinary admission remains
// authoritative and checks the actual stage, receipts, isolation and caller.
export async function continuationEligibility(context, runner, approval, {
  inspectAdoption = inspectHostAdoption, approvalReader = readProtectedApproval,
} = {}) {
  await inspectAdoption(context);
  const fresh = await approvalReader(context.reader, context.adopted.approval);
  requireThat(digest(fresh.record) === digest(approval.record),
    'HOST_APPROVAL_MISMATCH');
  const eligibility = await observeWorkEligibility(context.reader, {
    approval: context.adopted.approval, runner,
    pauseJournalRoot: join(context.host.stateRoot, 'wake'),
  }, fresh);
  const labels = requireActiveIssue(eligibility.issue, fresh.record.issue);
  requireUnpaused(eligibility.pause, fresh.record.issue);
  requireThat(fresh.record.operations.includes('deliver') &&
    fresh.record.operations.includes(labels.has('shaped') ? 'deliver' : 'shape') &&
    fresh.record.roles.writer === runner.memberId,
  'OPERATION_NOT_APPROVED');
  return readRunnerBinding(context.reader, runner);
}

// Dependency seams stay in trusted module composition, as in manual recovery.
export async function recoverContinuationFence(context, runner, {
  loadSlot = (number, target, uid) => loadHostAdoption(number, target, uid, true),
  observeInvocation = observeRecoveryInvocation, recoveryOptions,
} = {}) {
  const issue = context.adopted.isolation.issue;
  const target = runner.target ? String(runner.target.repositoryId) : undefined;
  const selected = await selectRecoverySlot(context, uid =>
    loadSlot(String(issue.number), target, uid));
  requireThat(selected.expectedFence, 'RECOVERY_FENCE_MISSING');
  const currentInvocation = await observeInvocation(
    context.host.installation.directory, issue.number);
  return recoverAdoptedDeliverFence(selected.context, {
    ...recoveryOptions, expectedFence: selected.expectedFence, currentInvocation,
  });
}

// Private composition seam for fixtures, never selected by Runner input.
export async function admitContinuationFence({ acquire, authorize, recover }) {
  try { return { fence: await acquire() }; }
  catch (error) {
    if (error.code !== 'HOST_EXECUTION_UNRESOLVED') throw error;
  }
  await authorize();
  const result = await recover();
  if (result.status !== 'completed') return { pending: result };
  await authorize();
  // Exclusive acquisition respects a replacement installed by another caller.
  return { fence: await acquire() };
}
