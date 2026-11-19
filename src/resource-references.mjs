import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { requireThat } from './identity.mjs';
import { assertNoSlotMounts } from './retirement-observe.mjs';

const refers = (value, path) => value === path || value.startsWith(path + '/') ||
  value === path + ' (deleted)';

export async function requireNoResourceReferences(path, { proc = '/proc',
  mounts = assertNoSlotMounts, code = 'MANAGED_RESOURCE_IN_USE' } = {}) {
  await mounts(path);
  for (const pid of await readdir(proc)) {
    if (!/^[1-9][0-9]*$/.test(pid)) continue;
    const root = join(proc, pid);
    try {
      for (const name of ['exe', 'cwd']) {
        const observed = await readlink(join(root, name));
        requireThat(!refers(observed, path), code);
      }
      const maps = await readFile(join(root, 'maps'), 'utf8');
      requireThat(!maps.split('\n').some(line => {
        const file = /^(?:\S+\s+){5}(.*)$/.exec(line)?.[1];
        return file && refers(file, path);
      }), code);
      for (const fd of await readdir(join(root, 'fd'))) {
        try {
          requireThat(!refers(await readlink(join(root, 'fd', fd)), path),
            code);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      // A process that exited contributes no remaining reference. Failed access
      // to a live process is uncertainty and preserves the affected material.
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
}
