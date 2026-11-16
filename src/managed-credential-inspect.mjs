import { lifecycleState, managedPaths, sameResource } from
  './managed-credential-files.mjs';
import { managedCredentialHost } from './managed-credential-host.mjs';
import { verifyManagedAuthority } from './managed-credential-authority.mjs';
import { requireThat } from './identity.mjs';

export async function inspectManagedAccess(host, token, reconciling = false) {
  if (host.tokenFile !== managedPaths.tokenFile) return;
  const state = await lifecycleState(host);
  if (!state) return;
  requireThat(state.phase === 'active' ||
    reconciling && state.phase === 'disconnecting',
  'MANAGED_CREDENTIAL_ADMISSION_DENIED');
  await sameResource(host.tokenFile, host, state.files?.[0]);
  if (!reconciling) {
    const trusted = await managedCredentialHost();
    await verifyManagedAuthority(trusted, token);
  }
}
