import { readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat, digest } from './identity.mjs';
import { loadAdoptedHost } from './adopted-host.mjs';
import { inspectSharedHost } from './shared-host-inspect.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { withRetirementLock } from './retirement-lock.mjs';
import { withPoolGate, drainPath, requireNoRetirement }
  from './retirement-admission.mjs';
import { readRetirementFile, writeRetirementFile, optionalStat, resourceIdentity }
  from './retirement-files.mjs';
import { settlePoolWork, observeRetirementUnit, assertRetirementCgroups, slotUnit,
  observeRetirementRegistrations } from './retirement-observe.mjs';
import { RetirementServices } from './retirement-services.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { readInstalledRunnerIdentity } from './installed-runner-state.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { discoverRunnerRefresh, downloadRunnerRefresh }
  from './runner-refresh-discovery.mjs';
import { prepareRunnerSlot, resumeRunnerSlot, verifyRefreshedSlot, finalizeRunnerSlot }
  from './runner-refresh-slot.mjs';
import { refreshRunnerRuntime, continueRunnerRefresh, runnerRefreshObservation }
  from './runner-refresh.mjs';
import { completeInstalledLifecycle } from './installed-lifecycle.mjs';
import { command } from './process.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { createRefreshWorkspace, inspectRefreshWorkspace, cleanupRunnerRefresh,
  runnerRefreshMarker, recoverRunnerRefresh, slotWorkspace }
  from './runner-refresh-workspace.mjs';

const statePath = '/etc/nibfin/runner-refresh.json';
const preserved = ['.runner', '.credentials', '.credentials_rsaparams', '.env',
  '.path', '_work', '_diag'];
const marker = state => state.admission ?? runnerRefreshMarker(state);

async function externalInvocation() {
  await rootOwnedPath('/usr/bin/systemctl');
  requireExternalRunnerRefresh(await readFile('/proc/self/cgroup', 'utf8'),
    await Promise.all([1, 2].map(slot => observeRetirementUnit(slot, command,
      { allowActive: true }))), process.env.GITHUB_ACTIONS === 'true');
}

// Read the real Linux service boundary. A Job/hook cannot become an external
// administrator merely by changing environment variables or waiting for a PID.
export function requireExternalRunnerRefresh(cgroups, units, githubActions = false) {
  requireThat(typeof cgroups === 'string' && cgroups.trim() && !githubActions,
    'RUNNER_REFRESH_EXTERNAL_ADMIN_REQUIRED');
  const paths = cgroups.trim().split('\n').map(line => {
    const fields = line.split(':');
    requireThat(fields.length === 3 && fields[2].startsWith('/'),
      'RUNNER_REFRESH_INVOCATION_UNKNOWN');
    return fields[2];
  });
  requireThat(!paths.some(path => units.some(unit =>
    path.split('/').includes(unit.Id) || unit.ControlGroup &&
      (path === unit.ControlGroup || path.startsWith(unit.ControlGroup + '/')))),
  'RUNNER_REFRESH_EXTERNAL_ADMIN_REQUIRED');
}

async function bindingFor(context) {
  const { host } = context;
  const pool = await inspectSharedHost();
  const slots = [];
  for (const [index, runner] of pool.runners.entries()) {
    const slot = index + 1, path = `/var/lib/nibfin/runners/slot-${slot}`;
    await rootOwnedPath(path);
    await verifySharedSlotIdentity(path, runner, pool.repository);
    const settings = {};
    for (const name of preserved) {
      const stat = await optionalStat(join(path, name));
      settings[name] = stat ? { ...resourceIdentity(stat), uid: stat.uid,
        gid: stat.gid, mode: stat.mode } : null;
    }
    slots.push({ slot, path, runner, settings,
      uid: index === 0 ? host.runnerUid : host.sharedRunner.additionalRunner.uid });
  }
  return { pool, slots, repositories: context.configuration.origins.map(origin =>
    ({ repository: origin.repository, repositoryId: origin.repositoryId })) };
}

async function installedPorts(context, credentialScope) {
  const { host, reader } = context;
  const target = await installedSharedRuntime();
  const binding = await bindingFor(context);
  const services = new RetirementServices();
  const observe = slot => observeRetirementUnit(slot, command, { allowActive: true });
  const identity = async slot => {
    const local = await verifySharedSlotIdentity(slot.path, slot.runner,
      binding.pool.repository);
    return readInstalledRunnerIdentity(slot.path, local, target);
  };
  const closed = async state => requireThat(
    digest(await readRetirementFile(drainPath)) === digest(marker(state)),
    'RUNNER_REFRESH_ADMISSION_CHANGED');
  const verify = async state => {
    await context.inspect();
    requireThat(digest(await bindingFor(context)) === digest(binding),
      'RUNNER_REFRESH_BINDING_CHANGED');
    for (const slot of binding.slots) await verifyRefreshedSlot(slot.path,
      state.slots[slot.slot], slot.runner, binding.pool.repository, target);
    const registrations = await observeRetirementRegistrations(reader, binding.pool,
      { allowOnline: true, allowBusy: true });
    requireThat(registrations.every(value => value === 'present'),
      'RUNNER_REFRESH_REGISTRATION_CHANGED');
  };
  const workspace = async state => {
    if (!await optionalStat(state.workspace.path)) {
      state.workspace = await createRefreshWorkspace();
      for (const intent of Object.values(state.slots)) intent.staged = null;
      await writeRetirementFile(statePath, state);
    }
    await inspectRefreshWorkspace(state.workspace);
  };
  return {
    inspect: context.inspect,
    external: externalInvocation,
    binding: async () => binding,
    read: async () => {
      const state = await readRetirementFile(statePath);
      const admission = await readRetirementFile(drainPath);
      const recovered = await recoverRunnerRefresh(admission, binding);
      if (!state) return recovered;
      if (recovered) {
        requireThat(digest(marker(state)) === digest(admission),
          'RUNNER_REFRESH_ADMISSION_CHANGED');
        return { ...state, phase: state.phase === 'complete' ? 'restoring' : state.phase,
          admission };
      }
      return state;
    },
    write: state => writeRetirementFile(statePath, state),
    workspace: createRefreshWorkspace,
    discover: () => discoverRunnerRefresh(reader, binding.pool.repository, target.arch),
    current: async selected => {
      try {
        const identities = await Promise.all(binding.slots.map(identity));
        return identities.every(value => digest(value.artifact) ===
          digest(selected.artifact));
      } catch (error) {
        // Reconstruct through the authenticated package installation, never by
        // enrolling the observed executable hashes. Failed reads still retry.
        if (error instanceof SyntaxError || ['ENOENT',
          'INVALID_INSTALLED_RUNNER_IDENTITY', 'INVALID_RUNNER_RELEASE',
          'SHARED_ARTIFACT_DIGEST_MISMATCH', 'SHARED_PLATFORM_MISMATCH']
          .includes(error.code)) return false;
        throw error;
      }
    },
    running: async () => Promise.all([1, 2].map(async slot =>
      (await observe(slot)).ActiveState === 'active')),
    settle: () => settlePoolWork(host, reader, binding, undefined, { credentialScope }),
    prepare: async state => {
      await workspace(state);
      const archive = await downloadRunnerRefresh(state.selected,
        join(state.workspace.path, 'runner.tar.gz'));
      for (const slot of binding.slots) {
        if (state.slots[slot.slot]) continue;
        state.slots[slot.slot] = await prepareRunnerSlot(slot.path,
          slotWorkspace(state, slot.slot), archive, state.selected,
          slot.runner, binding.pool.repository, target);
        await writeRetirementFile(statePath, state);
      }
    },
    close: state => withPoolGate(host, async () => {
      const previous = await readRetirementFile(drainPath);
      if (previous) return closed(state);
      await requireNoRetirement();
      await context.inspect();
      state.running = await Promise.all([1, 2].map(async slot =>
        (await observe(slot)).ActiveState === 'active'));
      await writeRetirementFile(statePath, state);
      state.admission = runnerRefreshMarker(state);
      await writeRetirementFile(drainPath, state.admission);
      await writeRetirementFile(statePath, state);
    }),
    closed,
    stopped: async slot => {
      const unit = await observe(slot);
      if (unit.ActiveState !== 'inactive') return false;
      await assertRetirementCgroups('/sys/fs/cgroup', [slot]);
      return true;
    },
    stop: (slot, state) => services.perform(`service-stop-${slot}`, state),
    install: async (slot, state) => {
      const bindingSlot = binding.slots[slot - 1];
      if (await finalizeRunnerSlot(bindingSlot.path, state.slots[slot],
        bindingSlot.runner, binding.pool.repository, target)) return;
      await workspace(state);
      const archive = await downloadRunnerRefresh(state.selected,
        join(state.workspace.path, 'runner.tar.gz'));
      await resumeRunnerSlot(bindingSlot.path, slotWorkspace(state, slot),
        archive, state.selected, state.slots[slot], bindingSlot.runner,
        binding.pool.repository, target);
      await writeRetirementFile(statePath, state);
    },
    verify,
    release: state => withPoolGate(host, async () => {
      if (!await readRetirementFile(drainPath)) return;
      await closed(state);
      await verify(state);
      await unlink(drainPath);
      await syncRecoveryDirectory(dirname(drainPath));
    }),
    started: async slot => (await observe(slot)).ActiveState === 'active',
    start: slot => command('/usr/bin/systemctl', ['start', slotUnit(slot)],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' } }),
    cleanup: async state => {
      return cleanupRunnerRefresh(state);
    },
  };
}

export async function refreshInstalledRunnerRuntime(mode) {
  requireThat(['preview', 'apply', 'resume'].includes(mode), 'INVALID_RUNNER_REFRESH');
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'RUNNER_REFRESH_REQUIRES_INSTALLED_ADMIN');
  await externalInvocation();
  return runnerRefreshObservation(() => continueRunnerRefresh(() =>
    withManagedAdmission(credentialScope =>
      withRetirementLock(async () => {
        const context = await loadAdoptedHost({ verifyRemote: false });
        return refreshRunnerRuntime(mode,
          await installedPorts(context, credentialScope));
      })), completeInstalledLifecycle));
}
