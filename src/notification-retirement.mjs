import { safeRelayCode } from './notification-relay.mjs';
import { requireThat } from './identity.mjs';

// Fixed installed ports own all paths and observations. No journal of new
// cleanup intents is needed: systemd and the owned files provide readback.
export async function retireNotificationResources(ports) {
  const removed = [];
  try {
    await ports.inspect();
    await ports.consumers();
    await ports.resources();
    for (const unit of ports.units) {
      await ports.inspect();
      await ports.consumers();
      await ports.resources();
      if (!await ports.stopped(unit)) {
        try { await ports.stop(unit); }
        catch { /* Re-read the native result after a lost command response. */ }
        requireThat(await ports.stopped(unit), 'NOTIFICATION_STOP_UNCONFIRMED');
      }
    }
    await ports.inspect();
    await ports.consumers();
    await ports.resources();
    for (const unit of ports.units)
      requireThat(await ports.stopped(unit), 'NOTIFICATION_STOP_UNCONFIRMED');
    for (const resource of await ports.removable()) {
      await ports.inspect();
      await ports.remove(resource);
      removed.push(resource);
    }
    await ports.reload();
    const retained = await ports.pruneJournal();
    return { schemaVersion: 1, status: 'retired', removed, retained };
  } catch (error) {
    return { schemaVersion: 1, status: 'pending', code: safeRelayCode(error), removed };
  }
}
