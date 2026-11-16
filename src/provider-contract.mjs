import { isDigest, requireThat } from './identity.mjs';
import { skillIdentity } from './skills.mjs';

export const validProviderModel = value => typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);

// Only delivery writes the Candidate. Review roles may run bounded workspace
// checks using scratch storage; none receives host control or model credentials.
export function roleCapabilities(stage) {
  skillIdentity(stage);
  return Object.freeze({ workspace: stage === 'deliver' ? 'write' : 'read',
    scratch: 'write', verification: true, hostControl: false,
    modelCredentials: false, publish: false });
}

// A private plan belongs to the model-runner boundary, never the work-tool
// channel. Provider-specific args/settings remain private inside that plan.
export function privatePlanContract(stage, modelProfile) {
  requireThat(validProviderModel(modelProfile?.model),
    'INVALID_PROVIDER_MODEL_PROFILE');
  return { schemaVersion: 1, stage, skill: skillIdentity(stage),
    modelProfile: structuredClone(modelProfile), capabilities: roleCapabilities(stage),
    freshSession: true };
}

// Unknown termination is an error, leaving existing leases and Pending recovery
// intact. No workspace acceptance or credential cleanup is authorized by it.
export function requireModelTermination(result, executionId, policyHash) {
  requireThat(['completed', 'interrupted'].includes(result?.status) &&
    result.executionId === executionId && isDigest(result.terminationHash),
  'AGENT_ISOLATION_OR_TERMINATION_UNPROVEN');
  if (result.status === 'completed') requireThat(result.policyHash === policyHash &&
    isDigest(result.isolationHash) && isDigest(result.probeHash),
  'AGENT_ISOLATION_OR_TERMINATION_UNPROVEN');
  return result;
}
