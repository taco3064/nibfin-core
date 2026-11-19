import { requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { readMemberPermission } from './github-approval.mjs';
import { readCallerContinuity, readCallerSource } from './caller-source.mjs';

// Reuse caller validation for both managed and legacy recipes. Enrollment is
// read from fixed host views, never from an Issue or a failed run's title.
export async function verifyRolloutEnrollments(reader, host, targets, pin) {
  const actor = await reader.get('/user');
  requireThat(actor.id === host.memberId && actor.type === 'User',
    'ROLLOUT_CONTROLLER_CHANGED');
  for (const target of targets) {
    const next = JSON.parse(target.next), approval = next.repository.approval;
    const root = repoPath(approval.repository);
    const native = await reader.repository(approval.repository);
    requireThat(native.id === approval.repositoryId &&
      native.full_name === approval.repository && native.private === false &&
      !native.archived && !native.disabled, 'ROLLOUT_ENROLLMENT_REVOKED');
    await readMemberPermission(reader, approval.repository, actor);
    const branchPath = root + '/branches/' + encodeURIComponent(native.default_branch);
    const branch = await reader.get(branchPath);
    const checked = new Set();
    const callers = [['eventRunner', 'issue-forwarded']];
    // Shared execution is verified through the adopted pool by the caller.
    // A retired legacy adapter is not an active route for an enrolled target.
    if (!host.sharedRunner?.repositories?.includes(approval.repositoryId))
      callers.push(['runner', 'action-wake']);
    for (const [name, kind] of callers) {
      const binding = next.repository[name];
      if (checked.has(binding.workflowPath)) continue;
      checked.add(binding.workflowPath);
      const workflow = { id: binding.workflowId, path: binding.workflowPath,
        commit: binding.sourceCommit, blob: binding.workflowBlob };
      const current = await reader.get(root + '/actions/workflows/' + workflow.id);
      requireThat(current.id === workflow.id && current.path === workflow.path &&
        current.state === 'active', 'ROLLOUT_WORKFLOW_REVOKED');
      await readCallerContinuity(reader, approval.repository, workflow,
        branch.commit.sha);
      await readCallerSource(reader, approval.repository, workflow, branch.commit.sha,
        { kind, coreCommit: pin.commit, actionCommit: binding.actionCommit,
          memberId: host.memberId });
    }
    requireThat((await reader.get(branchPath)).commit?.sha === branch.commit.sha,
      'ROLLOUT_ENROLLMENT_CHANGED');
  }
}
