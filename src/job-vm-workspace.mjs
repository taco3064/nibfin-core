import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { safeCandidatePath } from './candidate-contract.mjs';
import { requireThat } from './identity.mjs';

const maxFiles = 10000;
const maxFileBytes = 16 * 1024 * 1024;
const maxTreeBytes = 64 * 1024 * 1024;

// Send regular files only. The guest receives neither Git metadata nor a
// writable host mount. Keep the same file and tree bounds as Core capture.
export async function snapshotJobVmWorkspace(root) {
  requireThat(await realpath(root) === resolve(root), 'UNSAFE_JOB_VM_WORKSPACE');
  const files = [];
  let size = 0, entries = 0;
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? prefix + '/' + name : name;
      requireThat(++entries <= maxFiles && safeCandidatePath(path),
        'UNSAFE_JOB_VM_WORKSPACE_ENTRY');
      const target = join(directory, name);
      const stat = await lstat(target);
      if (stat.isDirectory()) {
        await visit(target, path);
        continue;
      }
      requireThat(stat.isFile(), 'UNSAFE_JOB_VM_WORKSPACE_ENTRY');
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        requireThat(before.isFile() && before.nlink === 1 &&
          before.ino === stat.ino && before.dev === stat.dev &&
          before.size <= maxFileBytes && (size += before.size) <= maxTreeBytes,
        'UNSAFE_JOB_VM_WORKSPACE_FILE');
        const bytes = await file.readFile();
        const after = await file.stat();
        requireThat(bytes.length === before.size && after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs, 'JOB_VM_WORKSPACE_CHANGED');
        files.push({ path, executable: Boolean(before.mode & 0o111),
          content: bytes.toString('base64') });
      } finally {
        await file.close();
      }
    }
  }
  await visit(root);
  return files;
}

export function validateJobVmWorkspace(files) {
  requireThat(Array.isArray(files) && files.length <= maxFiles,
    'INVALID_JOB_VM_WORKSPACE');
  const paths = new Set();
  let size = 0;
  const entries = files.map(file => {
    requireThat(file && Object.keys(file).sort().join(',') ===
      'content,executable,path' && safeCandidatePath(file.path) &&
      typeof file.executable === 'boolean' && typeof file.content === 'string' &&
      file.content.length <= Math.ceil(maxFileBytes / 3) * 4 &&
      !paths.has(file.path), 'INVALID_JOB_VM_WORKSPACE_ENTRY');
    paths.add(file.path);
    const bytes = Buffer.from(file.content, 'base64');
    requireThat(bytes.length <= maxFileBytes && (size += bytes.length) <= maxTreeBytes &&
      bytes.toString('base64') === file.content, 'INVALID_JOB_VM_WORKSPACE_CONTENT');
    return { path: file.path, executable: file.executable, bytes };
  });
  for (const path of paths) {
    for (let index = path.indexOf('/'); index >= 0; index = path.indexOf('/', index + 1))
      requireThat(!paths.has(path.slice(0, index)), 'INVALID_JOB_VM_WORKSPACE_PATHS');
  }
  return entries;
}
