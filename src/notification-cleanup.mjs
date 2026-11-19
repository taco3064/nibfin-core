import { requireThat } from './identity.mjs';
import { safeRelayCode } from './notification-relay.mjs';

// Fixed administrator ports own observations and effects. Nothing serialized by
// CLI may supply a path, ownership assertion, readiness flag or service adapter.
export async function cleanupNotifications(ports) {
  const removed = [], retained = [];
  const result = (status, code = null) => ({ schemaVersion: 1, status, code,
    removed, retained, stageAdmitted: false });
  try {
    const consumers = await ports.consumers();
    requireThat(Array.isArray(consumers) && consumers.length > 0 &&
      consumers.every(item => ['native', 'artifact', 'retired'].includes(item.route)),
    'NOTIFICATION_CONSUMERS_UNKNOWN');
    const dependent = consumers.filter(item => item.route === 'artifact');
    if (dependent.length) {
      retained.push(...dependent.map(item => ({ repositoryId: item.repositoryId,
        purpose: 'active artifact notification consumer' })));
      return result('retained', 'NOTIFICATION_CONSUMERS_REMAIN');
    }
    await ports.inspectBindings();
    // Ownership is established before any systemd operation. Re-entry observes
    // each actual effect rather than trusting a local completion receipt.
    await ports.recheckConsumers(consumers);
    await ports.verifyOwnership(consumers);
    await ports.stopAndDisable();
    await ports.requireStopped();
    await ports.inspectBindings();
    await ports.recheckConsumers(consumers);
    await ports.reconcile?.();
    const resources = await ports.resources(consumers);
    for (const resource of resources) {
      if (resource.purpose) {
        retained.push({ path: resource.path, purpose: resource.purpose,
          ...(resource.unresolved ? { unresolved: true } : {}) });
        continue;
      }
      await ports.inspectBindings();
      await ports.requireStopped();
      await ports.remove(resource);
      requireThat(await ports.absent(resource), 'NOTIFICATION_REMOVAL_UNKNOWN');
      removed.push(resource.path);
    }
    await ports.reload();
    await ports.requireStopped();
    return result(retained.some(item => item.unresolved) ? 'incomplete' : 'cleaned',
      retained.some(item => item.unresolved) ? 'NOTIFICATION_EVIDENCE_RETAINED' : null);
  } catch (error) {
    return result('incomplete', safeRelayCode(error));
  }
}
