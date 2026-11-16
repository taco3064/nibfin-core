import { withResourcePreparationLock } from './managed-resource-admission.mjs';
import { withInstalledPoolAdmission } from './retirement-admission.mjs';
import { coreRoot } from './host-adoption.mjs';
import { hasManagedHost, managedCredentialHost } from './managed-credential-host.mjs';
import { consumeManagedCredentials } from './managed-credentials.mjs';

// Called only after the existing Runner-to-Controller relay, or local admin check.
export async function withManagedAdmission(action, options = {}) {
  return withResourcePreparationLock(() => managedAdmission(action, options));
}

async function managedAdmission(action, options) {
  if (options.pool) return withInstalledPoolAdmission(() =>
    withManagedAdmission(action, { ...options, pool: false }));
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
