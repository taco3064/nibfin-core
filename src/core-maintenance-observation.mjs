import { isId, isSha, isDigest } from './identity.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { rolloutPlanPath } from './rollout-admission.mjs';

export async function observeMaintenanceOperation(read = readRetirementFile) {
  try { return maintenanceOperationObservation(await read(rolloutPlanPath)); }
  catch (error) {
    const code = /^[A-Z][A-Z0-9_]*$/.test(error?.code ?? '') ? error.code :
      'CORE_MAINTENANCE_TARGET_UNAVAILABLE';
    return { operation: { status: 'pending', code } };
  }
}

// Optional readback locates an existing normal operation. This is not a grant
// and cannot replace that operation's native target, source or mutation checks.
export function maintenanceOperationObservation(plan) {
  if (!plan) return {};
  const target = plan.administratorTarget;
  if (plan.schemaVersion !== 2 || !isId(target?.runId) || !isId(target?.artifactId))
    return { operation: { status: 'pending',
      code: 'CORE_MAINTENANCE_TARGET_UNAVAILABLE' } };
  const result = { operationTarget: { runId: target.runId,
    artifactId: target.artifactId } };
  const pin = plan.pin;
  if (pin?.repository !== 'taco3064/nibfin-core' || !isSha(pin.commit) ||
    !isDigest(pin.manifestHash) || !isSha(plan.actionCommit)) return result;
  const core = { repository: pin.repository, commit: pin.commit,
    manifestHash: pin.manifestHash };
  if (isDigest(pin.archiveHash)) core.archiveHash = pin.archiveHash;
  if (typeof pin.releaseVersion === 'string' &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(pin.releaseVersion))
    core.releaseVersion = pin.releaseVersion;
  return { ...result, operationSources: { core,
    action: { repository: 'taco3064/nibfin-act', commit: plan.actionCommit } } };
}
