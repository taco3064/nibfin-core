import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { isId, requireThat } from './identity.mjs';

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

