import { continuationOutcome } from './continuation-state.mjs';
import { coreRoot } from './host-adoption.mjs';
import { requireThat } from './identity.mjs';
import { loadAdoptedHost } from './adopted-host.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { safeRelayCode } from './notification-relay.mjs';
import { pendingInstalledContinuation } from './rollout-resume.mjs';

// No caller-selected inputs: local admission failures use the denied convention.
// Remote observations and continuation failures remain retryable after admission.
export async function completeInstalledLifecycle() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'CONTINUATION_REQUIRES_INSTALLED_ADMINISTRATOR');
  try {
    const result = await withManagedAdmission(async () => {
      const context = await loadAdoptedHost({ verifyRemote: false });
      return pendingInstalledContinuation({ load: async () => context });
    }, { pool: true });
    return continuationOutcome(result);
  } catch (error) {
    // Failed observations cannot establish either admission or an empty scan.
    // Explicit trust/admission refusals still follow the denied-command path.
    if (error instanceof SyntaxError || ['ENOENT', 'EIO', 'ESTALE',
      'HOST_ADOPTION_CHANGED', 'MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE',
      'MANAGED_CREDENTIAL_CONSUMER_PENDING'].includes(error.code))
      return { status: 'pending', results: [], code: safeRelayCode(error) };
    throw error;
  }
}
