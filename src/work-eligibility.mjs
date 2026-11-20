import { observePause } from './pause.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { readMemberPermission } from './github-approval.mjs';
import { readDependencies } from './dependencies.mjs';
import { selectAssignee } from './selection.mjs';
import { digest, requireThat } from './identity.mjs';

// Shared live eligibility observations; callers retain their own admission gates.
export async function observeWorkEligibility(reader, pinned, approval) {
  const record = approval.record;
  const nativePolicy = pinned.approval.kind === 'repository-admission-v1';
  const pauseEvidence = pinned.pauseJournalRoot
    ? await new OperationJournal(pinned.pauseJournalRoot, record.issue).pauseEvidence()
    : { decisions: [], pending: false };
  const pause = await observePause(reader, record.issue, pauseEvidence.decisions, {
    repository: approval.repository, issue: approval.issue,
    grouped: approval.dependencies !== undefined, propagateTransient: true,
  });
  if (pauseEvidence.pending) pause.status = 'pending';
  const observed = await readDependencies(reader, record.issue, record.prerequisites, {
    repository: approval.repository, issue: pause.current,
    dependencies: approval.dependencies,
  });
  requireThat(!nativePolicy || observed.issue.body === record.scope.body,
    'ISSUE_REQUIREMENTS_CHANGED_DURING_READ');
  requireThat(observed.ready, 'PREREQUISITES_NOT_READY');
  const route = await selectAssignee(observed.issue, async (user) => {
    if (user.id !== record.roles.writer) return false;
    if (nativePolicy) return true;
    try {
      await readMemberPermission(reader, record.issue.repository, {
        ...user,
        type: 'User',
      });
      return true;
    } catch (error) {
      if (error.code === 'MEMBER_PERMISSION_REVOKED') return false;
      throw error;
    }
  });
  requireThat(
    route && route.userId === pinned.runner.memberId,
    'ASSIGNEE_RUNNER_BINDING_CHANGED',
  );
  return { issue: observed.issue, route,
    pause: pause.current && digest(pause.current) === digest(observed.issue) ? pause
      : { status: 'pending', code: 'PAUSE_OBSERVATION_CHANGED' },
    dependencies: { ready: true, identities: record.prerequisites } };
}
