import { coreRoot } from './host-adoption.mjs';
import { hasManagedHost, managedCredentialHost } from './managed-credential-host.mjs';
import { consumeManagedCredentials } from './managed-credentials.mjs';

// Called only after the existing Runner-to-Controller relay, or local admin check.
export async function withManagedAdmission(action, options = {}) {
  if (!await hasManagedHost()) return action();
  // Verified recovery packages may run outside the live installation. Their
  // reconciliation still enters through the fixed, verified installed boundary.
  if (options.reconcile && coreRoot !== '/opt/nibfin/core') {
    const installed = await import(
      '/opt/nibfin/core/src/managed-credential-admission.mjs');
    return installed.withManagedAdmission(action, options);
  }
  const host = await managedCredentialHost(process.getuid() === 0);
  return consumeManagedCredentials(host, action, options);
}
