import { requireNoRollout } from './rollout-admission.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { RetirementServices, retirementServiceEffects }
  from './retirement-services.mjs';
import { RetirementGateways, retirementGatewayEffects }
  from './retirement-gateways.mjs';
import {
  RetirementSlotResources, retirementSlotEffects,
} from './retirement-resources.mjs';
import {
  retirementCopies, observeRetirementCopies, removeRetirementCopies,
  inspectRetirementSessions,
} from './retirement-copies.mjs';
import { verifyManagedAuthority } from './managed-credential-authority.mjs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { installedProvider } from './provider-binding.mjs';
import { inspectSharedHost, sharedHostRegistrations } from './shared-host-inspect.mjs';
import { sharedRepository } from './shared-runner.mjs';
import { withRetirementLock } from './retirement-lock.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { GitHubReader } from './github-read.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { controlNotificationRelay } from './relay-service.mjs';
import { RelayJournal } from './relay-state.mjs';
import { relayStateRoot } from './relay-host.mjs';
import { observeNativeNotificationRoutes } from './native-notification-route.mjs';
import { retireManagedPool } from './managed-retirement.mjs';
import {
  drainPath, retirementPath, withPoolGate,
} from './retirement-admission.mjs';
import {
  readRetirementFile, writeRetirementFile, resourceIdentity,
  optionalStat,
} from './retirement-files.mjs';
import {
  slotParent, slotUnit, requireSlotParent, settleRetirement,
  settleRetirementWork,
  observeRetirementRegistrations,
} from './retirement-observe.mjs';

const same = isDeepStrictEqual;
const slotPath = slot => join(slotParent, `slot-${slot}`);

async function readAdoptions(host, bytes) {
  const snapshots = [{ path: hostFile, bytes }];
  const readPeer = async path => {
    await rootOwnedPath(path);
    const bytes = await boundedHostFile(path, 262144);
    snapshots.push({ path, bytes });
    return JSON.parse(bytes);
  };
  const repositories = [];
  for (const id of host.sharedRunner.repositories) {
    const peer = await sharedRepository(host, id, readPeer);
    const approval = peer.repository.approval;
    repositories.push({ repository: approval.repository, repositoryId: id });
  }
  // Store only adoption bytes and identities, never credential contents.
  return { adoptions: [...new Map(snapshots.map(s => [s.path, s])).values()],
    repositories };
}

async function inspectAdoptions(binding) {
  for (const snapshot of binding.adoptions) {
    await rootOwnedPath(snapshot.path);
    requireThat(await boundedHostFile(snapshot.path, 262144) === snapshot.bytes,
      'RETIREMENT_ADOPTION_CHANGED');
  }
}

async function retirementBinding(host, bytes, previous) {
  const pool = sharedHostRegistrations(host);
  const { schemaVersion: _schema, ...identity } = pool;
  const adoption = await readAdoptions(host, bytes);
  const provider = installedProvider(host).provider;
  await requireSlotParent();
  const slots = [];
  for (const [index, runner] of pool.runners.entries()) {
    const slot = index + 1;
    const path = slotPath(slot);
    if (previous) {
      slots.push(previous.binding.slots[index]);
      continue;
    }
    await rootOwnedPath(path);
    await verifySharedSlotIdentity(path, runner, pool.repository);
    const stat = await optionalStat(path);
    requireThat(stat?.isDirectory(), 'RETIREMENT_LAYOUT_UNSUPPORTED');
    slots.push({ slot, runner, path, service: slotUnit(slot),
      uid: index === 0 ? host.runnerUid : host.sharedRunner.additionalRunner.uid,
      identity: resourceIdentity(stat) });
  }
  return { pool: identity, provider, ...adoption, slots };
}

function marker(state) {
  return { schemaVersion: 1, retirementId: state.id, pool: state.binding.pool };
}

async function assertClosed(state, relayRequired = true) {
  requireThat(same(await readRetirementFile(drainPath), marker(state)),
    'RETIREMENT_ADMISSION_NOT_CLOSED');
  if (relayRequired)
    requireThat((await new RelayJournal(relayStateRoot).control()).paused === true,
      'RETIREMENT_RELAY_NOT_PAUSED');
}

// This command has no path, adapter, token, removal assertion or provider input.
// Candidate tests never invoke it against an installed host.
export async function retireSharedHost() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'RETIREMENT_REQUIRES_LOCAL_ADMIN');
  await rootOwnedPath(coreRoot);
  return withRetirementLock(async () => {
    await requireNoRollout();
    await rootOwnedPath(hostFile);
    const bytes = await boundedHostFile(hostFile, 262144);
    const host = JSON.parse(bytes);
    await verifyInstalledSource(coreRoot, host.installation.pin);
    await inspectSharedHost();
    let previous = await readRetirementFile(retirementPath);
    const archive = previous?.replacement?.phase === 'released' ? previous : null;
    if (archive) {
      requireThat(await readRetirementFile(drainPath) === null,
        'RETIREMENT_RELEASE_PENDING');
      requireThat(/^[a-f0-9-]{36}$/.test(archive.id), 'RETIREMENT_STATE_INVALID');
      const pool = sharedHostRegistrations(host);
      const { schemaVersion: _schema, ...identity } = pool;
      requireThat(same(identity, archive.replacement.pool),
        'RETIREMENT_IDENTITY_CHANGED');
      await writeRetirementFile(join('/etc/nibfin',
        `retirement-history-${archive.id}.json`), archive);
      previous = null;
    }
    const binding = await retirementBinding(host, bytes, previous);
    let reader;
    const nativeReader = async () => reader ??= new GitHubReader(
      (await readPrivate(host.tokenFile, host, 16384)).trim());
    const readPeer = async path => {
      await rootOwnedPath(path);
      return JSON.parse(await boundedHostFile(path, 262144));
    };
    let relayRequired = false;
    try {
      await observeNativeNotificationRoutes(host, await nativeReader(), readPeer);
    } catch (error) {
      if (error.code !== 'NOTIFICATION_ARTIFACT_CONSUMER_ACTIVE') throw error;
      relayRequired = true;
    }
    const settlement = { relayRequired };
    const closed = async state => {
      await assertClosed(state, relayRequired);
      if (!relayRequired)
        await observeNativeNotificationRoutes(host, await nativeReader(), readPeer);
    };
    const resources = new RetirementSlotResources();
    const gateways = new RetirementGateways();
    const services = new RetirementServices();
    const ports = {
      read: () => archive ? null : readRetirementFile(retirementPath),
      write: state => writeRetirementFile(retirementPath, state),
      inspectBinding: () => inspectAdoptions(binding),
      drainEffects: relayRequired ? ['close-admission', 'relay-pause'] :
        ['close-admission'],
      assertClosed: closed,
      settleWork: async state => {
        await verifyManagedAuthority({ ...host,
          credentialRepositories: binding.repositories }, '', await nativeReader());
        await inspectRetirementSessions(host);
        await settleRetirementWork(host, await nativeReader(), binding, state,
          settlement);
      },
      settlementEffects: retirementServiceEffects,
      settle: async state => {
        await verifyManagedAuthority({ ...host,
          credentialRepositories: binding.repositories }, '', await nativeReader());
        await inspectRetirementSessions(host);
        await settleRetirement(host, await nativeReader(), binding, state, settlement);
      },
      registrations: async () =>
        observeRetirementRegistrations(await nativeReader(), binding.pool),
      prepareCleanup: async () => ({ copies: await retirementCopies(host),
        gateways: await gateways.bind(host) }),
      cleanupEffects: [...retirementSlotEffects, 'provider-copies',
        ...retirementGatewayEffects],
      retryableEffects: ['relay-pause', 'close-admission', ...retirementSlotEffects,
        'provider-copies', ...retirementGatewayEffects, ...retirementServiceEffects],
      observeEffect: async (name, state) => {
        if (name === 'relay-pause') return (await new RelayJournal(relayStateRoot)
          .control()).paused ? 'done' : 'absent';
        if (name === 'close-admission') {
          const current = await readRetirementFile(drainPath);
          if (!current) return 'absent';
          requireThat(same(current, marker(state)), 'RETIREMENT_DRAIN_CHANGED');
          return 'done';
        }
        if (retirementServiceEffects.includes(name)) return services.observe(name, state);
        if (retirementGatewayEffects.includes(name)) return gateways.observe(name, state);
        if (name === 'provider-copies') return observeRetirementCopies(state.copies);
        return resources.observe(name, state);
      },
      performEffect: async (name, state) => {
        if (name === 'relay-pause') return controlNotificationRelay(true);
        if (name === 'close-admission') {
          const result = await withPoolGate(host, async () => {
            await requireNoRollout();
            await writeRetirementFile(drainPath, marker(state));
          });
          requireThat(result?.status !== 'pending', 'RETIREMENT_ADMISSION_BUSY');
          return;
        }
        await closed(state);
        await inspectAdoptions(binding);
        await inspectRetirementSessions(host);
        if (retirementServiceEffects.includes(name)) {
          await settleRetirementWork(host, await nativeReader(), binding, state,
            settlement);
          return services.perform(name, state);
        }
        await settleRetirement(host, await nativeReader(), binding, state, settlement);
        const registrations = await observeRetirementRegistrations(
          await nativeReader(), binding.pool);
        requireThat(registrations.every(value => value === 'absent'),
          'RETIREMENT_NATIVE_UNKNOWN');
        if (retirementGatewayEffects.includes(name)) return gateways.perform(name, state);
        if (name === 'provider-copies') return removeRetirementCopies(state.copies);
        await inspectAdoptions(binding);
        return resources.perform(name, state);
      },
    };
    return retireManagedPool(binding, ports);
  });
}
