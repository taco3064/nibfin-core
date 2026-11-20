import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { recoveryFile, inspectRecoveryFile } from './recovery-lock.mjs';
import { digest, isId, requireThat } from './identity.mjs';

// Deliberately stricter than the activity observer: unreadable is never absent.
async function kernelFile(pid, name) {
  const file = await open(`/proc/${pid}/${name}`, constants.O_RDONLY |
    constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireThat(bytesRead < buffer.length, 'RECOVERY_PROCESS_LIMIT');
    return buffer.subarray(0, bytesRead).toString();
  } finally { await file.close(); }
}

export function parseRecoveryProcess(pid, text) {
  const end = text.lastIndexOf(')');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  requireThat(isId(pid) && text.startsWith(`${pid} (`) && end > 0 &&
    /^[1-9][0-9]*$/.test(fields[19]) && /^\d+$/.test(fields[1]),
  'RECOVERY_PROCESS_IDENTITY_UNAVAILABLE');
  return { pid, parent: Number(fields[1]), startTicks: fields[19],
    state: fields[0] };
}

// All Controller-UID processes are included, including reparented helpers and
// Firecracker/MCP consumers. Container consumers are independently checked via
// the adopted daemon. No environments, signals or private argv enter diagnostics.
export async function recoveryProcessCensus(controllerPid) {
  requireThat(process.platform === 'linux', 'RECOVERY_PROCESS_UNAVAILABLE');
  const mounts = (await kernelFile(process.pid, 'mountinfo')).split('\n');
  const proc = mounts.filter(line => line.split(' ')[4] === '/proc');
  requireThat(proc.length > 0 && proc.every(line => line.includes(' - proc ') &&
    !/(?:^|[ ,])hidepid=(?!0(?:,| |$))/.test(line)),
  'RECOVERY_PROCESS_VIEW_UNAVAILABLE');
  const names = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name));
  requireThat(names.length <= 32768, 'RECOVERY_PROCESS_LIMIT');
  const result = [];
  for (const name of names) {
    const pid = Number(name);
    try {
      const owner = await stat(`/proc/${pid}`);
      if (owner.uid !== process.getuid() && pid !== controllerPid) continue;
      const before = parseRecoveryProcess(pid, await kernelFile(pid, 'stat'));
      // Zombies cannot execute or own descriptors; a live reused PID is handled
      // separately and never establishes legacy Controller termination.
      if (['Z', 'X'].includes(before.state)) {
        result.push(before);
        continue;
      }
      const command = (await kernelFile(pid, 'cmdline')).split('\0');
      if (command.at(-1) === '') command.pop();
      const after = parseRecoveryProcess(pid, await kernelFile(pid, 'stat'));
      requireThat(before.startTicks === after.startTicks,
        'RECOVERY_PROCESS_CHANGED');
      result.push({ ...after, command });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // ENOENT on cmdline alone is insufficient: confirm the PID disappeared.
        try { await stat(`/proc/${pid}`); }
        catch (gone) { if (gone.code === 'ENOENT') continue; throw gone; }
      }
      throw Object.assign(new Error('RECOVERY_PROCESS_UNAVAILABLE'),
        { code: 'RECOVERY_PROCESS_UNAVAILABLE' });
    }
  }
  return result;
}

export async function proveDeliverProcesses(fence, { census = recoveryProcessCensus,
  installation, subject, stateRoot } = {}) {
  const processes = await census(fence.pid);
  requireThat(Array.isArray(processes), 'RECOVERY_PROCESS_UNAVAILABLE');
  const owner = processes.find(item => item.pid === fence.pid);
  requireThat(!owner || ['Z', 'X'].includes(owner.state),
    owner && fence.startTicks && owner.startTicks !== fence.startTicks
      ? 'RECOVERY_PID_REUSED' : 'RECOVERY_CONTROLLER_UNRESOLVED');
  const live = processes.filter(item => !['Z', 'X'].includes(item.state) &&
    item.pid !== process.pid);
  // A separate trusted Controller tree for another Issue can remain active.
  // Reparented/unattributable helpers are never exempted by a dead parent.
  const cli = item => installation && item.command?.[1] ===
    `${installation}/bin/nibfin-core.mjs`;
  const unrelated = await unrelatedControllers(live, fence,
    { installation, subject, stateRoot });
  for (let changed = true; changed;) {
    changed = false;
    for (const item of live) {
      if (!unrelated.has(item.pid) && unrelated.has(item.parent)) {
        unrelated.add(item.pid);
        changed = true;
      }
    }
  }
  const recoveryOnly = item => cli(item) &&
    item.command[2] === 'recover-deliver-fence' && item.command.length === 4;
  requireThat(live.every(item => unrelated.has(item.pid) || recoveryOnly(item)),
    'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED');
  return digest(processes.map(({ pid, startTicks, state }) =>
    ({ pid, startTicks, state })));
}

// The fixed relay receives its request on stdin, not argv. Only private fences
// can attribute those Controllers. Historical fences without process identity
// cannot exempt a live PID: it might have been reused for this Issue's helper.
async function unrelatedControllers(live, target, {
  installation, subject, stateRoot,
}) {
  const result = new Set();
  if (!stateRoot || !installation || !subject) return result;
  const candidates = live.filter(item => item.command?.[1] ===
    `${installation}/bin/nibfin-controller.mjs` || item.command?.[1] ===
    `${installation}/bin/nibfin-core.mjs` && item.command[2] === 'stage');
  if (candidates.length === 0) return result;
  await privateHostDirectory(stateRoot);
  const names = (await readdir(stateRoot)).filter(name =>
    /^issue-[1-9][0-9]*-[1-9][0-9]*$/.test(name));
  requireThat(names.length <= 4096, 'RECOVERY_PROCESS_LIMIT');
  for (const name of names) {
    if (name === `issue-${subject.repositoryId}-${subject.number}`) continue;
    const directory = join(stateRoot, name);
    await privateHostDirectory(directory);
    const path = join(directory, 'stage.lock');
    let snapshot;
    try { snapshot = await recoveryFile(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const fence = JSON.parse(snapshot.bytes);
    const owner = candidates.find(item => item.pid === fence.pid);
    const command = owner?.command;
    const relay = command?.length === 2 &&
      command[1] === `${installation}/bin/nibfin-controller.mjs`;
    const stage = command?.length === 5 &&
      command[1] === `${installation}/bin/nibfin-core.mjs` &&
      command[2] === 'stage' && command[3] === name.split('-')[2];
    if ((relay || stage) && fence.bootId === target.bootId &&
      fence.binding?.execution?.actorId === target.binding.execution.actorId &&
      typeof fence.binding.issueId === 'string' &&
      fence.binding.issueId !== subject.id &&
      isId(fence.binding.execution?.jobId) &&
      typeof fence.startTicks === 'string' &&
      owner.startTicks === fence.startTicks) {
      await inspectRecoveryFile(path, snapshot);
      result.add(owner.pid);
    }
  }
  return result;
}
