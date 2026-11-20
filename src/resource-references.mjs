import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
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
    const exists = async () => {
      try { await lstat(root); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    const alive = async () => {
      if (!await exists()) return false;
      try {
        const text = await readFile(join(root, 'stat'), 'utf8');
        const state = text.slice(text.lastIndexOf(') ') + 2).split(' ')[0];
        requireThat(/^[A-Za-z]$/.test(state), 'RESOURCE_PROCESS_STATE_UNKNOWN');
        return !['Z', 'X', 'x'].includes(state);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code) && !await exists()) return false;
        throw error;
      }
    };
    try {
      for (const name of ['exe', 'cwd', 'root']) {
        try {
          const observed = await readlink(join(root, name));
          requireThat(!refers(observed, path), code);
        } catch (error) {
          // A live kernel thread may have no executable link. Inspect its other
          // evidence; missing one link never skips maps, mounts or descriptors.
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
        }
      }
      const maps = await readFile(join(root, 'maps'), 'utf8');
      requireThat(!maps.split('\n').some(line => {
        const file = /^(?:\S+\s+){5}(.*)$/.exec(line)?.[1];
        return file && refers(file.replace(/\\([0-7]{3})/g,
          (_, octal) => String.fromCharCode(parseInt(octal, 8))), path);
      }), code);
      await mounts(path, join(root, 'mountinfo'));
      for (const fd of await readdir(join(root, 'fd'))) {
        try {
          requireThat(!refers(await readlink(join(root, 'fd', fd)), path), code);
        } catch (error) {
          // ENOENT at an individual descriptor means it closed. Other access
          // errors are not evidence of closure, even if exe was absent.
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code) || await alive()) throw error;
    }
  }
}
