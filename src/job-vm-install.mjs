import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateJobVmWorkspace } from './job-vm-workspace.mjs';

// Stage only regular, validated files outside the live tree. No process in the
// guest can hold a host workspace descriptor or modify a file after transfer.
export async function installJobVmWorkspace(root, files) {
  const entries = validateJobVmWorkspace(files);
  const transaction = await mkdtemp(join(dirname(root), 'vm-work-'));
  const next = join(transaction, 'next'), previous = join(transaction, 'previous');
  let preserve = false;
  try {
    await mkdir(next, { mode: 0o700 });
    for (const { path, bytes, executable } of entries) {
      const target = join(next, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      if (executable) await chmod(target, 0o700);
    }
    await rename(root, previous);
    try {
      await rename(next, root);
    } catch (error) {
      preserve = true;
      await rename(previous, root);
      preserve = false;
      throw error;
    }
  } finally {
    if (!preserve) await rm(transaction, { recursive: true });
  }
}
