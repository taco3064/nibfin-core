import { processIdentity } from './host-memory-pressure.mjs';
import { readFile } from 'node:fs/promises';

// Docker supplies host PIDs. Independently bind them to this exact container's
// cgroup before the monitor captures /proc start times. Namespace mismatches or
// unsupported cgroup layouts disable attribution, not isolation or cleanup.
export async function ownContainerProcesses(monitor, inspect, id, {
  identity = processIdentity, read = readFile,
} = {}) {
  const containers = await inspect(['inspect', id]);
  const container = containers?.[0];
  if (containers.length !== 1 || container.Id !== id ||
    container.State?.Running !== true) return;
  const top = await inspect(['top', id, '-eo', 'pid']);
  if (top.Titles?.length !== 1 || top.Titles[0] !== 'PID') return;
  for (const row of (top.Processes ?? []).slice(0, 256)) {
    if (row.length !== 1 || !/^[1-9][0-9]*$/.test(row[0])) continue;
    const pid = Number(row[0]);
    const process = await identity(pid);
    if (!process) continue;
    const cgroup = await read(`/proc/${pid}/cgroup`, 'utf8');
    if (cgroup.split('\n').some(line => {
      const path = line.split(':')[2];
      return path?.split('/').some(part =>
        part === id || part === `docker-${id}.scope`);
    })) await monitor.own(pid, process.startTicks);
  }
}
