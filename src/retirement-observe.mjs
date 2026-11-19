import { RelayJournal } from './relay-state.mjs';
import { relayStateRoot } from './relay-host.mjs';
import { assertNoCredentialConsumers } from './managed-credentials.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { repoPath } from './github-read.mjs';
import { managedSettlement } from './managed-credential-settlement.mjs';
import { idleContainers } from './host-containers.mjs';
import { sharedSlotIsolation } from './shared-runner.mjs';
import { requirePoolConsumersSettled } from './retirement-admission.mjs';
import { optionalStat } from './retirement-files.mjs';

export const slotParent = '/var/lib/nibfin/runners';
export const serviceTemplate = '/etc/systemd/system/nibfin-shared-runner@.service';
export const slotUnit = slot => `nibfin-shared-runner@${slot}.service`;
const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 16384 };

export async function observeRetirementUnit(
  slot, run = command, { allowActive = false } = {},
) {
  const { stdout } = await run('/usr/bin/systemctl', ['show', slotUnit(slot),
    '--property=Id,LoadState,FragmentPath,DropInPaths,NeedDaemonReload',
    '--property=ActiveState,SubState,MainPID,ControlGroup,User,Group'], options);
  const unit = Object.fromEntries(stdout.toString().trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  requireThat(unit.Id === slotUnit(slot) && unit.LoadState === 'loaded' &&
    unit.FragmentPath === serviceTemplate && unit.DropInPaths === '' &&
    unit.NeedDaemonReload === 'no' && unit.User === `nibfin-runner-${slot}` &&
    unit.Group === unit.User, 'RETIREMENT_SERVICE_IDENTITY_CHANGED');
  const inactive = unit.ActiveState === 'inactive' && unit.SubState === 'dead' &&
    unit.MainPID === '0' && unit.ControlGroup === '';
  const active = allowActive && unit.ActiveState === 'active' &&
    unit.SubState === 'running' && /^[1-9][0-9]*$/.test(unit.MainPID);
  requireThat(inactive || active, 'RETIREMENT_SERVICE_PENDING');
  return unit;
}

// Search the actual cgroup hierarchy, including children of inactive services.
// A missing systemd MainPID or an offline registration is not process evidence.
export async function assertRetirementCgroups(
  root = '/sys/fs/cgroup', slots = [1, 2],
) {
  await readFile(join(root, 'cgroup.controllers'));
  let count = 0;
  const walk = async (directory, matched = false) => {
    requireThat(++count <= 16384, 'RETIREMENT_CGROUP_UNKNOWN');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      const selected = matched || slots.some(slot => entry.name === slotUnit(slot));
      if (selected) {
        const processes = await readFile(join(path, 'cgroup.procs'), 'utf8');
        requireThat(processes.trim() === '', 'RETIREMENT_CGROUP_PENDING');
      }
      await walk(path, selected);
    }
  };
  await walk(root);
}

export async function observeRetirementRegistrations(reader, pool, {
  allowOnline = false,
} = {}) {
  const repo = await reader.get(repoPath(pool.repository));
  requireThat(repo.id === pool.repositoryId && repo.full_name === pool.repository,
    'RETIREMENT_NATIVE_IDENTITY_CHANGED');
  const registrations = await reader.list(
    repoPath(pool.repository) + '/actions/runners', 'runners');
  return pool.runners.map(expected => {
    const matches = registrations.filter(runner => runner.id === expected.id ||
      runner.name === expected.name);
    if (!matches.length) return 'absent';
    requireThat(matches.length === 1 && matches[0].id === expected.id &&
      matches[0].name === expected.name && matches[0].os === 'Linux' &&
      matches[0].labels?.some(label => label.name === 'nibfin-shared') &&
      matches[0].labels.some(label => label.name === `nibfin-user-${pool.memberId}`),
    'RETIREMENT_NATIVE_IDENTITY_CHANGED');
    requireThat(matches[0].busy === false &&
      (matches[0].status === 'offline' || allowOnline && matches[0].status === 'online'),
      'RETIREMENT_NATIVE_BUSY');
    return 'present';
  });
}

export async function assertRetirementJobs(reader, repositories, pool) {
  for (const repository of repositories) {
    const path = repoPath(repository.repository);
    const native = await reader.get(path);
    requireThat(native.id === repository.repositoryId &&
      native.full_name === repository.repository, 'RETIREMENT_TARGET_CHANGED');
    const runs = await reader.list(path + '/actions/runs?status=in_progress',
      'workflow_runs');
    for (const run of runs) {
      const jobs = await reader.list(path + `/actions/runs/${run.id}/jobs`, 'jobs');
      requireThat(!jobs.some(job => job.status !== 'completed' &&
        pool.runners.some(runner => job.runner_id === runner.id ||
          job.runner_name === runner.name)), 'RETIREMENT_JOB_PENDING');
    }
  }
}

export async function settleRetirementWork(host, reader, binding, state) {
  await new RelayJournal(relayStateRoot).requireSettled();
  await settlePoolWork(host, reader, binding, state);
}

export async function settlePoolWork(host, reader, binding, state, options) {
  await requirePoolConsumersSettled(host);
  await assertNoCredentialConsumers(host);
  await managedSettlement(host, options);
  const uids = [host.runnerUid, host.sharedRunner.additionalRunner.uid];
  for (const [index, uid] of uids.entries()) {
    const allowMissingGateway = Boolean(state?.effects[`gateway-remove-${index + 1}`]);
    await idleContainers(sharedSlotIsolation(host, uid), undefined, command,
      { allowMissingGateway });
  }
  await assertRetirementJobs(reader, binding.repositories, binding.pool);
  await observeRetirementRegistrations(reader, binding.pool, { allowOnline: true });
}

export async function settleRetirement(host, reader, binding, state) {
  await settleRetirementWork(host, reader, binding, state);
  await observeRetirementRegistrations(reader, binding.pool);
  for (const slot of [1, 2]) await observeRetirementUnit(slot);
  await assertRetirementCgroups();
}

export async function assertNoSlotMounts(path) {
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const decode = value => value.replace(/\\([0-7]{3})/g,
    (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  requireThat(!mounts.trim().split('\n').some(line => {
    const mount = decode(line.split(' ')[4]);
    return mount === path || mount.startsWith(path + '/');
  }), 'RETIREMENT_RESOURCE_MOUNTED');
}

export async function disabledRetirementUnit(
  slot, run = command, inspect = rootOwnedPath,
) {
  await inspect('/usr/bin/systemctl');
  const { stdout } = await run('/usr/bin/systemctl',
    ['is-enabled', slotUnit(slot)], { ...options, allowedExitCodes: [0, 1, 4] });
  const value = stdout.toString().trim();
  requireThat(['enabled', 'disabled'].includes(value), 'RETIREMENT_SERVICE_UNKNOWN');
  return value === 'disabled';
}

export async function requireSlotParent() {
  await rootOwnedPath(slotParent);
  requireThat((await optionalStat(slotParent))?.isDirectory(),
    'RETIREMENT_LAYOUT_UNSUPPORTED');
}
