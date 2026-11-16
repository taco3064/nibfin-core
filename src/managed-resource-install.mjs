import { withResourcePreparationLock } from './managed-resource-admission.mjs';
import { engineAdmission } from './engine-host.mjs';
import { engine } from './engine-contract.mjs';
import { exclusiveRecovery } from './recovery-lock.mjs';
import { withSharedAdoptionLock } from './shared-peer-adoption.mjs';
import { managedResources } from './managed-resource-contract.mjs';
import { managedResourceHost } from './managed-resource-host.mjs';
import { deliverManagedResources } from './managed-resource-prepare.mjs';

// Consent is the entire interface. All inputs and effects are verified Core code.
export async function prepareManagedSharedHost(consent) {
  const confirmSource = await engineAdmission(consent);
  const io = managedResourceHost(confirmSource);
  const result = await withResourcePreparationLock(async () => {
    await io.verifyEngine();
    await io.initialize();
    return withSharedAdoptionLock(() => exclusiveRecovery(engine.state, () =>
      exclusiveRecovery(managedResources.state, async () => {
        await confirmSource();
        return deliverManagedResources(io);
      })));
  }, { preparing: true });
  return { ...result, adoption: false, servicesReady: false };
}
