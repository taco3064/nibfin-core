import { mkdtemp, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { officialRunnerArtifact } from './installed-runner-identity.mjs';
import { repoPath } from './github-read.mjs';
import { sharedTarget, verifySharedFile } from './shared-platform.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { requireThat } from './identity.mjs';

// The repository API chooses what this pool may run; the official release
// supplies authenticated integrity metadata. The downloads API has no digest.
export async function discoverRunnerRefresh(reader, repository, arch) {
  const target = sharedTarget(arch);
  const packages = await reader.get(repoPath(repository) + '/actions/runners/downloads');
  requireThat(Array.isArray(packages), 'RUNNER_REFRESH_DOWNLOADS_INVALID');
  const matches = packages.filter(item => item.os === 'linux' &&
    item.architecture === target.artifactArch);
  requireThat(matches.length === 1, 'RUNNER_REFRESH_PACKAGE_UNAVAILABLE');
  const offered = matches[0];
  requireThat(typeof offered.filename === 'string', 'RUNNER_REFRESH_DOWNLOADS_INVALID');
  const pattern = new RegExp('^actions-runner-linux-' + target.artifactArch +
    '-([0-9]+\\.[0-9]+\\.[0-9]+)\\.tar\\.gz$');
  const version = pattern.exec(offered.filename)?.[1];
  requireThat(version, 'RUNNER_REFRESH_DOWNLOADS_INVALID');
  const release = await reader.get('/repos/actions/runner/releases/tags/v' + version);
  const artifact = officialRunnerArtifact(release, arch);
  requireThat(offered.filename === artifact.name &&
    offered.download_url === artifact.url && release.draft === false,
  'RUNNER_REFRESH_OFFICIAL_PACKAGE_MISMATCH');
  return { release: { tag_name: release.tag_name, draft: false,
    assets: release.assets.filter(asset => asset.name === artifact.name) },
  artifact, arch };
}

// No token is sent to a public package/CDN URL. API metadata was authenticated
// by the existing reader; verified package bytes remain the integrity boundary.
export async function downloadRunnerRefresh(selected, path, fetcher = fetch) {
  const target = sharedTarget(selected.arch);
  const artifact = officialRunnerArtifact(selected.release, selected.arch);
  const directory = dirname(path);
  await rootOwnedPath(directory);
  const candidates = [basename(path), ...(await readdir(directory)).filter(name =>
    /^package-download-[A-Za-z0-9]+\.tar\.gz$/.test(name))];
  for (const name of new Set(candidates)) {
    const candidate = join(directory, name);
    try {
      await verifySharedFile(candidate, artifact.sha256, target, false);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'SHARED_ARTIFACT_DIGEST_MISMATCH'].includes(error.code))
        throw error;
      // Unknown bytes stay in place. Another private download can complete the
      // unfinished preparation without replacing an unrelated or changed file.
    }
  }
  const response = await fetcher(artifact.url, { redirect: 'follow' });
  requireThat(response.ok && response.body, 'RUNNER_REFRESH_DOWNLOAD_UNAVAILABLE');
  const temporary = await mkdtemp(join(directory, 'download-'));
  const partial = join(temporary, 'archive');
  const file = await open(partial, 'wx', 0o600);
  const identity = await file.stat();
  try {
    for await (const chunk of response.body) await file.writeFile(chunk);
    await file.sync();
  } catch (error) {
    await file.close();
    const { lstat } = await import('node:fs/promises');
    const actual = await lstat(partial);
    if (actual.dev === identity.dev && actual.ino === identity.ino) {
      await unlink(partial);
      await rmdir(temporary);
    }
    throw error;
  }
  await file.close();
  await verifySharedFile(partial, artifact.sha256, target, false);
  const completed = join(directory, `package-${basename(temporary)}.tar.gz`);
  await rename(partial, completed);
  await rmdir(temporary);
  await syncRecoveryDirectory(directory);
  return completed;
}
