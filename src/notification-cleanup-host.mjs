import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { digest, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { inspectSharedHost } from './shared-host-inspect.mjs';
import { adoptionReader } from './shared-peer-adoption.mjs';
import { withReplacementAwareAdoptionLock } from './retirement-lock.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { observeLifecycleConsumers } from './lifecycle-route.mjs';
import { verifyLifecycleCleanupPool } from './notification-cleanup-pool.mjs';
import { withRelayGate, RelayJournal } from './relay-state.mjs';
import { reconcileLifecycleNotifications } from './lifecycle-settlement.mjs';
import { relayStateRoot, relayUnitDirectory } from './relay-host.mjs';
import { notificationUnitContents } from './relay-service.mjs';
import { optionalStat } from './retirement-files.mjs';
import { cleanupNotifications } from './notification-cleanup.mjs';
import { NotificationCleanupFiles } from './notification-cleanup-files.mjs';
import { NotificationCleanupServices } from './notification-cleanup-service.mjs';

export async function cleanupInstalledNotifications() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'NOTIFICATION_REQUIRES_INSTALLED_ADMINISTRATOR');
  return withManagedAdmission(() => withReplacementAwareAdoptionLock(async () => {
    const snapshots = new Map();
    const read = async path => {
      await rootOwnedPath(path);
      const bytes = await boundedHostFile(path, 262144);
      if (snapshots.has(path)) requireThat(snapshots.get(path) === bytes,
        'HOST_ADOPTION_CHANGED');
      snapshots.set(path, bytes);
      return JSON.parse(bytes);
    };
    const host = await read(hostFile);
    const source = await verifyInstalledSource(coreRoot, host.installation.pin);
    const pool = await inspectSharedHost();
    const reader = await adoptionReader(host);
    const services = new NotificationCleanupServices();
    const files = new NotificationCleanupFiles(await notificationUnitContents());
    let observed;
    const consumers = async () => {
      const retired = await verifyLifecycleCleanupPool(host, pool, reader, read);
      return retired ?? observeLifecycleConsumers(reader, host, source, read);
    };
    const inspect = async () => {
      for (const [path, bytes] of snapshots) {
        await rootOwnedPath(path);
        requireThat(await boundedHostFile(path, 262144) === bytes,
          'HOST_ADOPTION_CHANGED');
      }
      await verifyInstalledSource(coreRoot, host.installation.pin);
    };
    const run = () => cleanupNotifications({
      consumers: async () => {
        observed = await consumers();
        return observed;
      },
      inspectBindings: inspect,
      recheckConsumers: async previous => {
        requireThat(digest(await consumers()) === digest(previous),
          'NOTIFICATION_CONSUMERS_CHANGED');
      },
      verifyOwnership: async () => {
        await files.configuration(observed);
        const owned = await files.ownedUnits();
        for (const unit of await services.observe())
          requireThat(unit.LoadState === 'not-found' || owned.some(file =>
            file.path === `${relayUnitDirectory}/${unit.Id}`) ||
            unit.ActiveState === 'inactive' && unit.MainPID === '0' &&
            unit.ControlGroup === '' &&
            ['disabled', 'static'].includes(unit.UnitFileState),
          'NOTIFICATION_RESOURCE_CONFLICT');
      },
      stopAndDisable: () => services.stopAndDisable(),
      reconcile: async () => {
        if (!await optionalStat(relayStateRoot)) return;
        await reconcileLifecycleNotifications(new RelayJournal(relayStateRoot), reader);
      },
      resources: () => files.resources(observed),
      remove: file => files.remove(file),
      absent: file => files.absent(file),
      requireStopped: () => services.requireStopped(),
      reload: () => services.reload(),
    });
    // Never create obsolete state on a native-only installation. When present,
    // keep the stable lock inode and directory for in-flight and later readers.
    if (!await optionalStat(relayStateRoot)) return run();
    return withRelayGate(relayStateRoot, run);
  }));
}
