import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from './identity.mjs';

// Linux directory descriptors pin each parent before the next component opens.
// O_NOFOLLOW applies to every untrusted component, not just the final file.
// Renaming/replacing a checked path cannot redirect subsequent opens.
export async function readProjectSkill(root, path) {
  const handles = [];
  try {
    requireThat(typeof root === 'string' && /\.md$/i.test(path),
      'PROJECT_SKILL_INVALID');
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY |
      constants.O_NOFOLLOW;
    let parent = await open(resolve(root), directoryFlags);
    handles.push(parent);
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, directoryFlags);
      handles.push(parent);
    }
    const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const stat = await file.stat();
    requireThat(stat.isFile(), 'PROJECT_SKILL_INVALID');
    return await file.readFile('utf8');
  } catch {
    // Do not propagate filesystem paths or project/host content in diagnostics.
    throw new Error('PROJECT_SKILL_UNREADABLE_OR_UNSAFE');
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}
