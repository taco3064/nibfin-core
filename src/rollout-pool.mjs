import { rolloutPeerTargets } from './rollout-peers.mjs';
import { verifyRolloutEnrollments } from './rollout-enrollments.mjs';
import { withRolloutGates, rolloutHasRelay } from './rollout-gates.mjs';
import { join } from 'node:path';
import { digest, isSha, requireThat } from './identity.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { sharedHostRegistrations, inspectSharedHost }
  from './shared-host-inspect.mjs';
import { managerHostRegistrations, inspectManagerHost }
  from './shared-host-inspect.mjs';
import { requireManagerContext } from './rollout-manager-context.mjs';
import { sharedRepository, sharedRunner, sharedDispatchWorkflow }
  from './shared-runner.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { assertNoCredentialConsumers, assertNoOtherCredentialConsumers }
  from './managed-credentials.mjs';
import { GitHubReader } from './github-read.mjs';
import { RelayJournal } from './relay-state.mjs';
import { relayStateRoot } from './relay-host.mjs';
import { requireNoRetirement, requirePoolConsumersSettled }
  from './retirement-admission.mjs';
import { readRetirementFile, writeRetirementFile, optionalStat }
  from './retirement-files.mjs';
import { managedSettlement } from './managed-credential-settlement.mjs';
import { inspectRetirementSessions } from './retirement-copies.mjs';
import { RetirementServices } from './retirement-services.mjs';
import { settlePoolWork, observeRetirementUnit, assertRetirementCgroups,
  observeRetirementRegistrations, slotUnit, disabledRetirementUnit,
} from './retirement-observe.mjs';
import { command } from './process.mjs';
import { rolloutPlanPath, rolloutClosurePath, rolloutMarker,
  requireRolloutClosure, publishRolloutClosure, removeRolloutClosure,
} from './rollout-admission.mjs';

const root = '/etc/nibfin';
export const rolloutHostNames = ['host.json', 'host.nibfin-act.json',
  'host.gh-nibfin.json', 'host.nibfin-e2e.json'];

async function readHost(path) {
  await rootOwnedPath(path);
  return JSON.parse(await boundedHostFile(path, 262144));
}

export async function bindRolloutPool(host, context,
  registration = verifySharedSlotIdentity) {
  const registrations = context ? managerHostRegistrations(host, context) :
    sharedHostRegistrations(host);
  const { schemaVersion: unused, ...pool } = registrations;
  void unused;
  const adoptions = [];
  const read = async path => {
    requireThat(path === root + '/host.json' ||
      /^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path),
      'ROLLOUT_PEER_PATH_CHANGED');
    await rootOwnedPath(path);
    const bytes = await boundedHostFile(path, 262144);
    adoptions.push({ path, bytes });
    return JSON.parse(bytes);
  };
  const repositories = [];
  for (const id of host.sharedRunner.repositories) {
    const peer = await sharedRepository(host, id, read);
    repositories.push({ repository: peer.repository.approval.repository,
      repositoryId: id });
  }
  requireThat(repositories.length === 4 && new Set(repositories.map(r =>
    r.repository)).size === 4 && ['nibfin-core', 'nibfin-act', 'gh-nibfin', 'nibfin-e2e']
    .every(name => repositories.some(r => r.repository === 'taco3064/' + name)),
  'ROLLOUT_ENROLLMENTS_CHANGED');
  // Include the primary even when sharedRepository returned it without a read.
  await read(join(root, rolloutHostNames[0]));
  for (const name of rolloutHostNames) {
    const view = await read(join(root, name));
    requireThat(Array.isArray(view.wakePeerFiles ?? []) &&
      (view.wakePeerFiles ?? []).length <= 10, 'INVALID_WAKE_PEERS');
    for (const path of view.wakePeerFiles ?? []) await read(path);
  }
  requireThat(adoptions.every(item => repositories.some(repository =>
    repository.repositoryId === JSON.parse(item.bytes).repository.approval.repositoryId)),
  'ROLLOUT_PEER_BINDING_CHANGED');
  const slots = [];
  for (const [index, runner] of pool.runners.entries()) {
    const slot = index + 1, path = `/var/lib/nibfin/runners/slot-${slot}`;
    await registration(path, runner, pool.repository);
    slots.push({ slot, path, runner, service: slotUnit(slot),
      uid: index ? host.sharedRunner.additionalRunner.uid : host.runnerUid });
  }
  return { pool, repositories, slots,
    adoptions: [...new Map(adoptions.map(item => [item.path, item])).values()] };
}

async function inspectBinding(plan) {
  for (const item of plan.binding.adoptions) {
    await rootOwnedPath(item.path);
    requireThat(await boundedHostFile(item.path, 262144) === item.bytes,
      'ROLLOUT_ADOPTION_CHANGED');
  }
}

// Same settlement rules as retirement, with its destructive relay-pause
// prerequisite replaced by the independent rollout closure. No retirement effects.
export async function settleRolloutWork(host, reader, binding, {
  relayGateHeld = false, legacyReplacement, credentialScope,
} = {}) {
  const wakeRoot = join(host.stateRoot, 'wake');
  if (await optionalStat(wakeRoot)) {
    const { requireLegacyReplacementsSettled } =
      await import('./rollout-legacy-wake.mjs');
    const { requireWakeEffectsSettled } = await import('./operation-journal.mjs');
    await requireWakeEffectsSettled(wakeRoot, host.uid);
    await requireLegacyReplacementsSettled(wakeRoot, legacyReplacement, host.uid);
  }
  if (await rolloutHasRelay()) {
    const journal = new RelayJournal(relayStateRoot);
    // Legacy recovery holds both gates across settlement and replacement POST.
    if (relayGateHeld) await journal.requireEffectsSettledUnderGate();
    else await journal.requireEffectsSettled();
  }
  await inspectRetirementSessions(host);
  await settlePoolWork(host, reader, binding, undefined,
    { legacyReplacement, credentialScope });
}

export async function advanceRolloutPool(operation, context, credentialScope) {
  if (context !== undefined) requireManagerContext(context);
  requireThat(process.platform === 'linux' && process.getuid() === 0,
    'ROLLOUT_REQUIRES_HOST_ADMINISTRATOR');
  if (operation === 'recover-wakes') {
    const { recoverInstalledLegacyWakes } = await import('./rollout-legacy-wake.mjs');
    return recoverInstalledLegacyWakes();
  }
  const operations = ['legacy', 'prepare', 'close', 'stop', 'verify', 'release',
    ...(context ? ['restore'] : [])];
  requireThat(operations.includes(operation),
    'INVALID_ROLLOUT_OPERATION');
  await rootOwnedPath(root);
  let plan = await readRetirementFile(rolloutPlanPath);
  requireThat(plan && isSha(plan.pin?.commit) && isSha(plan.actionCommit) &&
    plan.pin.repository === 'taco3064/nibfin-core', 'INVALID_ROLLOUT_PLAN');
  const host = await readHost(join(root, rolloutHostNames[0]));
  await requireNoRetirement({ rollout: true });
  if (operation === 'legacy') {
    requireThat(plan.schemaVersion !== 2, 'ROLLOUT_PHASE_CHANGED');
    const { schemaVersion: unused, ...pool } = sharedHostRegistrations(host);
    void unused;
    return withRolloutGates(host, async () => {
      await requireNoRetirement({ rollout: true });
      const marker = { schemaVersion: 1, legacy: true, pin: plan.pin, pool };
      const previous = await readRetirementFile(rolloutClosurePath);
      requireThat(!previous || digest(previous) === digest(marker),
        'ROLLOUT_CLOSURE_CHANGED');
      await writeRetirementFile(rolloutClosurePath, marker);
      return { status: 'closed' };
    });
  }
  requireThat(plan.schemaVersion === 2, 'INVALID_ROLLOUT_PLAN');
  const save = async changes => {
    plan = { ...plan, ...changes };
    await writeRetirementFile(rolloutPlanPath, plan);
  };
  if (operation === 'prepare') {
    requireThat(plan.phase === 'prepared', 'ROLLOUT_PHASE_CHANGED');
    if (context) await inspectManagerHost(context);
    else await inspectSharedHost();
    const reader = new GitHubReader(
      (await readPrivate(host.tokenFile, host, 16384)).trim());
    const actor = await reader.get('/user');
    requireThat(actor.id === host.memberId && actor.type === 'User',
      'ROLLOUT_CONTROLLER_CHANGED');
    const binding = await bindRolloutPool(host, context);
    requireThat(!plan.binding || digest(plan.binding) === digest(binding),
      'ROLLOUT_ADOPTION_CHANGED');
    const source = await verifyInstalledSource(
      `/opt/nibfin/core-staged-${plan.pin.commit}`, plan.pin);
    const { validateRolloutHosts, validateRolloutHost,
      validateE2eRollout, validateRolloutIsolation } =
      await import('./host-rollout.mjs');
    const hosts = [];
    for (const name of rolloutHostNames.slice(0, 3)) {
      const current = await readHost(join(root, name));
      const next = await readHost(join(root, 'rollout', name));
      hosts.push({ repository: current.repository.approval.repository.split('/')[1],
        current, next });
      const account = await command('/usr/bin/getent', ['passwd', String(current.uid)]);
      const user = account.stdout.toString().split(':')[0];
      requireThat(/^[a-z_][a-z0-9_-]*$/.test(user), 'ROLLOUT_ACCOUNT_UNKNOWN');
      await command('/usr/sbin/runuser', ['-u', user, '--', '/usr/bin/test',
        '-r', join(root, name)]);
    }
    validateRolloutHosts(hosts, plan.pin, source, plan.actionCommit);
    validateRolloutIsolation(hosts);
    validateE2eRollout(await readHost(join(root, 'rollout', rolloutHostNames[3])),
      hosts[0].next, source);
    const { prepareRolloutRelay } = await import('./rollout-relay.mjs');
    const provisional = [];
    for (const name of rolloutHostNames) provisional.push({
      path: join(root, name), current: await boundedHostFile(join(root, name), 262144),
      next: await boundedHostFile(join(root, 'rollout', name), 262144),
    });
    const extras = await rolloutPeerTargets(binding, provisional, validateRolloutHost,
      plan.pin, source, plan.actionCommit);
    const resources = await prepareRolloutRelay(provisional);
    const originalServices = plan.originalServices ?? [];
    for (const slot of [1, 2]) {
      if (!context)
        requireThat(!await disabledRetirementUnit(slot), 'ROLLOUT_SERVICE_DISABLED');
      const unit = await observeRetirementUnit(slot, command, { allowActive: true });
      if (!plan.originalServices)
        originalServices.push({ slot, running: unit.ActiveState === 'active' });
    }
    await save({ binding, pending: null,
      ...(context ? { originalServices } : {}) });
    const closure = await readRetirementFile(rolloutClosurePath);
    if (closure?.legacy) {
      requireThat(digest(closure.pin) === digest(plan.pin) &&
        digest(closure.pool) === digest(binding.pool), 'ROLLOUT_CLOSURE_CHANGED');
      const converted = await withRolloutGates(host, async () => {
        requireThat(digest(await readRetirementFile(rolloutClosurePath)) ===
          digest(closure), 'ROLLOUT_CLOSURE_CHANGED');
        await writeRetirementFile(rolloutClosurePath, rolloutMarker(plan));
        return { status: 'converted' };
      });
      if (converted.status === 'pending') return converted;
    }
    if (digest(host.installation.pin) === digest(plan.pin)) {
      // A legacy target already on disk still needs exact binding, relay,
      // source and listener readback. Never infer completion from its commit.
      const targets = [];
      for (const target of [...provisional, ...extras]) {
        const path = target.path, bytes = target.current;
        const next = JSON.parse(target.next);
        requireThat(digest(JSON.parse(bytes)) === digest(next),
          'ROLLOUT_LEGACY_BINDINGS_UNRESOLVED');
        targets.push({ path, current: bytes, next: bytes });
      }
      for (const item of resources) {
        requireThat(digest(JSON.parse(item.current)) === digest(JSON.parse(item.next)),
          'ROLLOUT_LEGACY_BINDINGS_UNRESOLVED');
        item.next = item.current;
      }
      await save({ phase: 'verifying', apply: { oldPin: plan.pin, source,
        completed: true, targets, resources }, pending: 'ROLLOUT_RESTART_REQUIRED' });
    }
    return { status: 'prepared' };
  }
  requireThat(plan.binding?.slots?.length === 2, 'INVALID_ROLLOUT_BINDING');
  if (operation === 'close') {
    await inspectBinding(plan);
    // Relay holds its gate around admission and POST. Acquire in this order:
    // relay then pool. A busy gate returns pending without publishing closure.
    return withRolloutGates(host, async () => {
      await requireNoRetirement({ rollout: true });
      await inspectBinding(plan);
      await publishRolloutClosure(plan);
      await save({ phase: 'draining', pending: 'ROLLOUT_SETTLEMENT_REQUIRED' });
      return { status: 'closed' };
    });
  }
  if (plan.phase === 'complete' && operation === 'release') {
    if (!await readRetirementFile(rolloutClosurePath)) return { status: 'complete' };
    plan = { ...plan, phase: 'verifying' };
  }
  await requireRolloutClosure(plan);
  if (operation === 'stop') {
    await inspectBinding(plan);
    const reader = new GitHubReader((await readPrivate(host.tokenFile, host, 16384))
      .trim());
    const services = new RetirementServices();
    for (const slot of [1, 2]) {
      await settleRolloutWork(host, reader, plan.binding, { credentialScope });
      await inspectBinding(plan);
      const name = `service-stop-${slot}`;
      if (await services.observe(name, plan) !== 'done') {
        if (context && !(plan.stoppedServices ?? []).includes(slot))
          await save({ stoppedServices: [...(plan.stoppedServices ?? []), slot] });
        await services.perform(name, plan);
      }
      requireThat(await services.observe(name, plan) === 'done',
        'ROLLOUT_SERVICE_STOP_PENDING');
    }
    await settleRolloutWork(host, reader, plan.binding, { credentialScope });
    for (const slot of [1, 2]) await observeRetirementUnit(slot);
    await assertRetirementCgroups();
    await save({ phase: 'applying', pending: 'ROLLOUT_APPLY_REQUIRED' });
    return { status: 'stopped' };
  }
  requireThat(plan.phase === 'verifying' && plan.apply?.completed,
    'ROLLOUT_APPLY_PENDING');
  if (operation === 'restore') {
    requireThat(plan.originalServices?.length === 2,
      'ROLLOUT_ORIGINAL_SERVICE_STATE_MISSING');
    await verifyInstalledSource('/opt/nibfin/core', plan.pin);
    for (const target of [...plan.apply.targets, ...(plan.apply.resources ?? [])])
      requireThat(await boundedHostFile(target.path, 262144) === target.next,
        'ROLLOUT_HOST_READBACK_MISMATCH');
    for (const state of plan.originalServices) {
      requireThat([1, 2].includes(state.slot) && typeof state.running === 'boolean',
        'ROLLOUT_ORIGINAL_SERVICE_STATE_MISSING');
      const unit = await observeRetirementUnit(state.slot, command,
        { allowActive: true });
      if (state.running && plan.stoppedServices?.includes(state.slot) &&
        unit.ActiveState === 'inactive') {
        await rootOwnedPath('/usr/bin/systemctl');
        await command('/usr/bin/systemctl', ['start', slotUnit(state.slot)],
          { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
      }
    }
    return { status: 'restored' };
  }
  if (operation === 'release') return withRolloutGates(host, async () => {
      await requireNoRetirement({ rollout: true });
      await requireRolloutClosure(plan);
      await verifyInstalledRollout(plan, host, context, credentialScope);
      await save({ phase: 'complete', pending: null });
      await removeRolloutClosure(plan);
      return { status: 'complete' };
    });
  await verifyInstalledRollout(plan, host, context, credentialScope);
  return { status: 'verified' };
}

async function readInstalledFacts(plan, host, context, {
  reader: createReader = token => new GitHubReader(token),
  enrollments = verifyRolloutEnrollments, workflow = sharedDispatchWorkflow,
  registrations: readRegistrations = observeRetirementRegistrations,
  unit: readUnit = observeRetirementUnit, identity = verifySharedSlotIdentity,
} = {}, allowBusy = false) {
  await verifyInstalledSource('/opt/nibfin/core', plan.pin);
  for (const target of [...plan.apply.targets, ...(plan.apply.resources ?? [])]) {
    await rootOwnedPath(target.path);
    requireThat(await boundedHostFile(target.path, 262144) === target.next,
      'ROLLOUT_HOST_READBACK_MISMATCH');
  }
  const observed = context ? await inspectManagerHost(context) :
    await inspectSharedHost();
  requireThat(digest([...observed.adoptedRepositoryIds].sort()) ===
    digest(plan.binding.repositories.map(r => r.repositoryId).sort()),
  'ROLLOUT_ENROLLMENTS_CHANGED');
  const reader = createReader((await readPrivate(host.tokenFile, host, 16384)).trim());
  await enrollments(reader, host, plan.apply.targets, plan.pin);
  const shared = sharedRunner(host,
    { repositoryId: host.repository.approval.repositoryId });
  await workflow(reader, shared.runner);
  const registrations = await readRegistrations(reader,
    plan.binding.pool, { allowOnline: true, allowBusy });
  requireThat(registrations.every(value => value === 'present'),
    'ROLLOUT_REGISTRATION_MISSING');
  const native = await reader.list('/repos/' + plan.binding.pool.repository +
    '/actions/runners', 'runners');
  const running = slot => !context || plan.originalServices?.some(value =>
    value.slot === slot && value.running);
  requireThat(!context || plan.originalServices?.length === 2,
    'ROLLOUT_ORIGINAL_SERVICE_STATE_MISSING');
  requireThat(plan.binding.pool.runners.every((expected, index) => native.some(r =>
    r.id === expected.id && r.name === expected.name &&
      r.status === (running(index + 1) ? 'online' : 'offline'))),
  'ROLLOUT_REGISTRATION_OFFLINE');
  const units = [];
  for (const slot of [1, 2]) {
    const unit = await readUnit(slot, command, { allowActive: true });
    requireThat(unit.ActiveState === (running(slot) ? 'active' : 'inactive'),
      'ROLLOUT_LISTENER_PENDING');
    const binding = plan.binding.slots[slot - 1];
    await identity(binding.path, binding.runner,
      plan.binding.pool.repository);
    units.push({ slot, unit, running: running(slot) });
  }
  return units;
}

// Transaction verification adds settlement to shared installed facts. Ordinary
// work must never be treated as an installation-observation failure.
export async function verifyInstalledRollout(plan, host, context, credentialScope,
  ports = {}) {
  const units = await readInstalledFacts(plan, host, context, ports);
  const supervisors = ports.supervisors ?? ((slot, plan, unit) =>
    new RetirementServices().supervisors(slot, plan, unit));
  const cgroups = ports.cgroups ?? assertRetirementCgroups;
  for (const { slot, unit, running } of units) {
    if (running) await supervisors(slot, plan, unit);
    else await cgroups('/sys/fs/cgroup', [slot]);
  }
  await requirePoolConsumersSettled(host);
  if (credentialScope) await assertNoOtherCredentialConsumers(host, credentialScope);
  else await assertNoCredentialConsumers(host);
  await managedSettlement(host);
  if (await (ports.relay ?? rolloutHasRelay)()) {
    const journal = new RelayJournal(relayStateRoot);
    await journal.requireReplacementEffectsSettled();
    requireThat((await journal.records()).every(record => record.status !== 'pending'),
      'RELAY_EFFECT_UNKNOWN');
  }
}

// No target, paths, service assertions or restoration instructions are accepted
// by the administrator entry. Snapshot current authoritative state read-only.
export async function observeInstalledManager(context, credentialScope, ports = {}) {
  requireManagerContext(context);
  requireThat(!await optionalStat(rolloutPlanPath), 'ROLLOUT_OPERATION_ACTIVE');
  requireThat(!await optionalStat(rolloutClosurePath), 'ROLLOUT_CLOSURE_CHANGED');
  await requireNoRetirement({ rollout: true });
  const host = await readHost(join(root, rolloutHostNames[0]));
  const binding = await bindRolloutPool(host, context, ports.identity);
  const originalServices = [];
  const readUnit = ports.unit ?? observeRetirementUnit;
  for (const slot of [1, 2]) {
    const unit = await readUnit(slot, command, { allowActive: true });
    originalServices.push({ slot, running: unit.ActiveState === 'active' });
  }
  const plan = { pin: host.installation.pin, binding, originalServices,
    apply: { targets: binding.adoptions.map(item => ({ path: item.path,
      current: item.bytes, next: item.bytes })) } };
  await readInstalledFacts(plan, host, context, ports, true);
  requireThat(!await optionalStat(rolloutPlanPath), 'ROLLOUT_OPERATION_ACTIVE');
  requireThat(!await optionalStat(rolloutClosurePath), 'ROLLOUT_CLOSURE_CHANGED');
  await requireNoRetirement({ rollout: true });
  return { status: 'observed', pin: host.installation.pin };
}

export async function requirePromotionSettlement(plan, credentialScope, {
  closure = requireRolloutClosure,
  reader = token => new GitHubReader(token),
  settle = settleRolloutWork, unit = observeRetirementUnit,
  cgroups = assertRetirementCgroups,
} = {}) {
  await closure(plan);
  const primary = plan.binding.adoptions.find(item => item.path === root + '/host.json');
  requireThat(primary, 'ROLLOUT_ADOPTION_CHANGED');
  const host = JSON.parse(primary.bytes);
  const provider = reader((await readPrivate(host.tokenFile, host, 16384)).trim());
  await settle(host, provider, plan.binding, { credentialScope });
  for (const slot of [1, 2]) await unit(slot);
  await cgroups();
}
