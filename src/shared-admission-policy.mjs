import { isId, requireThat } from './identity.mjs';

export const managedSharedAdmission = 'repository-admission-v1';

// This record comes only from administrator-owned host adoption. Callers must
// never populate it from workflow inputs, event data, labels or Candidate data.
export function usesManagedSharedAdmission(runner) {
  const policy = runner.sharedAdmission;
  if (policy === undefined) return false;
  requireThat(policy?.kind === managedSharedAdmission &&
    policy.repository === runner.repository &&
    policy.repositoryId === runner.repositoryId &&
    policy.memberId === runner.memberId && isId(policy.ownerId),
  'SHARED_ADMISSION_POLICY_INVALID');
  return true;
}

export function requireSharedBranch(runner, protectedBranch, code) {
  requireThat(usesManagedSharedAdmission(runner) || protectedBranch === true, code);
}
