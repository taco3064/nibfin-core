import { requestActionsIdentity } from './actions-identity.mjs';
import { coreMaintenanceContract } from './core-maintenance-contract.mjs';
import { listNativeAttemptJobs, jobCheckRunId } from './native-job-check.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { repoPath } from './github-read.mjs';
import { isId, requireThat } from './identity.mjs';

export function maintenanceInvoker(host, actualUid) {
  if (actualUid === host.runnerUid) return 0;
  if (actualUid === host.sharedRunner?.additionalRunner?.uid) return 1;
  requireThat(false, 'CORE_MAINTENANCE_INVOKER_CHANGED');
}

// Unverified claims may locate a native object. Only the later signed OIDC
// admission and provider readback can authorize the privileged operation.
export async function maintenanceRequest(context, host, supplied, actualUid, reader,
  requestIdentity = requestActionsIdentity) {
  const pool = managerHostRegistrations(host, context);
  const runner = pool.runners[maintenanceInvoker(host, actualUid)];
  requireThat(supplied.repository === pool.repository &&
    [supplied.runId, supplied.attempt, supplied.target?.runId,
      supplied.target?.artifactId].every(isId), 'CORE_MAINTENANCE_REQUEST_INVALID');
  const token = await requestIdentity({ requestUrl: supplied.requestUrl,
    requestToken: supplied.requestToken, audience: coreMaintenanceContract.audience });
  const parts = token.split('.');
  requireThat(parts.length === 3, 'CORE_MAINTENANCE_IDENTITY_REQUIRED');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const check = typeof claims.check_run_id === 'string' ?
    Number(claims.check_run_id) : claims.check_run_id;
  requireThat(isId(check), 'CORE_MAINTENANCE_CHECK_CHANGED');
  const jobs = await listNativeAttemptJobs(reader, repoPath(pool.repository),
    supplied.runId, supplied.attempt);
  const matches = jobs.filter(job => job.runner_id === runner.id &&
    job.runner_name === runner.name && job.name === coreMaintenanceContract.jobName &&
    job.status === 'in_progress' && jobCheckRunId(job, pool.repository) === check);
  requireThat(matches.length === 1 && isId(matches[0].id),
    'CORE_MAINTENANCE_JOB_UNTRUSTED');
  return { token, runId: supplied.runId, attempt: supplied.attempt,
    jobId: matches[0].id, runnerId: runner.id, target: supplied.target };
}
