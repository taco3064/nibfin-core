import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from './process.mjs';
import { requireThat, isSha } from './identity.mjs';
import { packageSource, verifyInstalledSource } from './source-package.mjs';
import { installSource } from './source-install.mjs';
import { releaseAssets } from './release.mjs';
import { releaseVersion } from './release-version.mjs';

export async function buildRelease(
  source, version, output, { run = command, git = '/usr/bin/git' } = {},
) {
  releaseVersion(version);
  const root = resolve(source), target = resolve(output), parent = dirname(target);
  requireThat(
    await realpath(root) === root && await realpath(parent) === parent &&
      target !== parent && target !== root && !target.startsWith(root + '/'),
    'UNSAFE_RELEASE_DESTINATION',
  );
  const readGit = async (args) => (await run(git, [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args,
  ], {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    },
  })).stdout.toString().trim();
  const context = async () => {
    requireThat(
      await readGit(['rev-parse', '--show-toplevel']) === root &&
        await readGit(['symbolic-ref', 'HEAD']) === 'refs/heads/main' &&
        await readGit(['status', '--porcelain', '--untracked-files=all']) === '',
      'INVALID_RELEASE_SOURCE_CONTEXT',
    );
    const commit = await readGit(['rev-parse', '--verify', 'HEAD^{commit}']);
    requireThat(isSha(commit), 'INVALID_RELEASE_SOURCE_CONTEXT');
    return commit;
  };
  const commit = await context();
  // Exclusive reservation: an existing file, directory or symlink is never replaced.
  await mkdir(target, { mode: 0o700 });
  let temporary, complete = false;
  try {
    const built = await packageSource(root, commit, { git, run, version });
    const assets = releaseAssets(built);
    const pin = JSON.parse(assets.find((file) => file.name === 'source-pin.json').bytes);
    temporary = await mkdtemp(join(tmpdir(), 'nibfin-release-check-'));
    const installed = join(temporary, 'core');
    await installSource(built.bytes, installed, pin);
    await verifyInstalledSource(installed, pin);
    const entry = await run(process.execPath, [
      join(installed, 'bin/nibfin-core.mjs'), 'help',
    ]);
    requireThat(Array.isArray(JSON.parse(entry.stdout).commands),
      'INSTALLED_ENTRY_UNAVAILABLE');
    requireThat(await context() === commit, 'RELEASE_SOURCE_CHANGED');
    for (const file of assets) {
      await writeFile(join(target, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    }
    complete = true;
    return { status: 'verified-build', output: target, ...pin };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}
