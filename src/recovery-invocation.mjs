import { digest, requireThat } from './identity.mjs';
import { recoveryProcessCensus } from './recovery-process-census.mjs';
import { controllerRelayArguments, controllerRelayProgram }
  from './controller-contract.mjs';

const identity = ({ pid, parent, startTicks, command }) =>
  ({ pid, parent, startTicks, command });

// Only this authenticated invocation and fixed transport ancestors qualify.
// No descendant, sibling, reparented helper or same-name stage is exempted.
export async function observeRecoveryInvocation(installation, issueNumber, {
  census = recoveryProcessCensus,
} = {}) {
  const pid = process.pid, uid = process.getuid();
  const processes = await census(pid);
  const current = processes.find(item => item.pid === pid);
  const command = current?.command;
  const controller = command?.length === 2 &&
    command[1] === `${installation}/bin/nibfin-controller.mjs`;
  const direct = command?.length === 5 &&
    command[1] === `${installation}/bin/nibfin-core.mjs` &&
    command[2] === 'stage' && command[3] === String(issueNumber) &&
    command[4] === 'continue';
  requireThat(current && !['Z', 'X'].includes(current.state) &&
    (controller || direct), 'RECOVERY_INVOCATION_UNAVAILABLE');
  const members = [identity(current)];
  const parent = processes.find(item => item.pid === current.parent);
  if (controller && parent && digest(parent.command) === digest([
    controllerRelayProgram, ...controllerRelayArguments(uid),
  ])) members.push(identity(parent));
  const snapshot = { pid, members };
  await confirmRecoveryInvocation(processes, snapshot);
  return snapshot;
}

export async function confirmRecoveryInvocation(processes, snapshot) {
  requireThat(snapshot.pid === process.pid, 'RECOVERY_INVOCATION_CHANGED');
  const allowed = new Set();
  for (const member of snapshot.members) {
    const current = processes.find(item => item.pid === member.pid);
    requireThat(current && !['Z', 'X'].includes(current.state) &&
      digest(identity(current)) === digest(member), 'RECOVERY_INVOCATION_CHANGED');
    allowed.add(member.pid);
  }
  return allowed;
}
