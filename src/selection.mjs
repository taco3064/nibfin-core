// The callback is a trusted authorization adapter, not Issue/event input.
// Selection does not inspect Runner availability and does not grant execution.
export async function selectAssignee(issue, eligible) {
  if (!issue || !Array.isArray(issue.assignees) || typeof eligible !== 'function') {
    throw new Error('Fresh Issue assignees and an authorization reader are required');
  }
  const seen = new Set();
  for (const user of issue.assignees) {
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.type !== 'User' ||
        typeof user.login !== 'string' || !user.login || seen.has(user.id)) {
      throw new Error('Invalid or duplicate assignee identity');
    }
    seen.add(user.id);
  }
  for (const user of issue.assignees) {
    const allowed = await eligible({ id: user.id, login: user.login });
    if (typeof allowed !== 'boolean') throw new Error('Unknown assignee authorization');
    if (allowed) return { userId: user.id, login: user.login, label: `nibfin-user-${user.id}` };
  }
  return null;
}
