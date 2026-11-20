import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { recoveryFile, inspectRecoveryFile } from './recovery-lock.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { recoveryProcessCensus } from './recovery-process-census.mjs';
import { confirmRecoveryInvocation } from './recovery-invocation.mjs';
export { parseRecoveryProcess, recoveryProcessCensus }
  from './recovery-process-census.mjs';

export async function proveDeliverProcesses(fence, { census = recoveryProcessCensus,
  installation, subject, stateRoot, currentInvocation } = {}) {
  const processes = await census(fence.pid);
  requireThat(Array.isArray(processes), 'RECOVERY_PROCESS_UNAVAILABLE');
  const owner = processes.find(item => item.pid === fence.pid);
  requireThat(!owner || ['Z', 'X'].includes(owner.state),
    owner && fence.startTicks && owner.startTicks !== fence.startTicks
      ? 'RECOVERY_PID_REUSED' : 'RECOVERY_CONTROLLER_UNRESOLVED');
  const invocation = currentInvocation
    ? await confirmRecoveryInvocation(processes, currentInvocation) : new Set();
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
  requireThat(live.every(item => invocation.has(item.pid) ||
    unrelated.has(item.pid) || recoveryOnly(item)),
    'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED');
  if (currentInvocation)
    await confirmRecoveryInvocation(await census(fence.pid), currentInvocation);
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
