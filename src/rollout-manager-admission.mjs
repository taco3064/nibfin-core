import { withResourcePreparationLock } from './managed-resource-admission.mjs';
import { hasManagedHost, managerCredentialHost } from './managed-credential-host.mjs';
import { consumeManagedCredentials } from './managed-credentials.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';

// Same resource and credential admission as normal Core, without dynamically
// importing a different package in the middle of the replacement transaction.
export function withManagerAdmission(context, action) {
  requireManagerContext(context);
  return withResourcePreparationLock(async () => {
    if (!await hasManagedHost()) return action();
    const host = await managerCredentialHost(context);
    return consumeManagedCredentials(host, action);
  });
}
