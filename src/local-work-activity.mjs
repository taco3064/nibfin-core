import { open, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { limits } from './local-work-values.mjs';
import { requireThat } from './identity.mjs';

async function kernelFile(pid, name) {
  const file = await open(`/proc/${pid}/${name}`, constants.O_RDONLY |
    constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireThat(bytesRead < buffer.length, 'OBSERVATION_LIMIT');
    return buffer.subarray(0, bytesRead).toString();
  } finally { await file.close(); }
}
const running = stat => {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return fields[0] !== 'Z' && fields[0] !== 'X' ? fields[19] : null;
};
const unescapeMount = text => text.replace(/\\([0-7]{3})/g,
  (_, value) => String.fromCharCode(parseInt(value, 8)));

// Kernel mount identity links a live invocation process to its trusted input
// directory. A retained session lock, container name or workflow title cannot
// substitute for this proof. No daemon API, process signal or privilege is used.
export async function observeInvocation(input) {
  const directory = await opendir('/proc');
  let count = 0;
  for await (const entry of directory) {
    if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
    requireThat(++count <= limits.entries, 'OBSERVATION_LIMIT');
    const pid = entry.name;
    try {
      const before = running(await kernelFile(pid, 'stat'));
      if (!before) continue;
      const mounts = (await kernelFile(pid, 'mountinfo')).split('\n');
      const matches = mounts.filter(line => {
        const fields = line.split(' ');
        return unescapeMount(fields[3] ?? '') === input && fields[4] === '/input' &&
          fields[5]?.split(',').includes('ro');
      });
      if (matches.length !== 1) continue;
      const command = (await kernelFile(pid, 'cmdline')).split('\0');
      if (command[0] !== '/usr/local/bin/node' ||
          command[1] !== '/input/bootstrap.mjs') continue;
      const confirm = async () => {
        requireThat(running(await kernelFile(pid, 'stat')) === before &&
          (await kernelFile(pid, 'mountinfo')).split('\n').includes(matches[0]) &&
          (await kernelFile(pid, 'cmdline')).split('\0')[1] === '/input/bootstrap.mjs',
        'OBSERVATION_CHANGED');
      };
      await confirm();
      return { confirm };
    } catch (error) {
      if (error.code === 'OBSERVATION_LIMIT') throw error;
      // hidepid, process exit and denied kernel reads provide no activity proof.
    }
  }
  return null;
}
