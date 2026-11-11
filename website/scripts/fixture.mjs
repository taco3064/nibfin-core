import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One disposable native dependency environment per control, retired by its caller.
export async function websiteFixture(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const path of ['package.json', '.node-version', 'bin', 'src', 'website']) {
      await cp(path, join(directory, path), { recursive: true,
        filter: (path) => !/(?:^|\/)(?:dist|\.astro|node_modules)(?:\/|$)/
          .test(path) });
    }
    for (const path of ['node_modules', 'website/node_modules']) {
      await cp(path, join(directory, path), { recursive: true,
        verbatimSymlinks: true,
        filter: (path) => !/\/(?:\.astro|\.vite|\.cache)(?:\/|$)/.test(path) });
    }
    return directory;
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
