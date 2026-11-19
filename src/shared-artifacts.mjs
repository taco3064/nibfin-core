import { requireThat } from './identity.mjs';
import { sharedPlatforms, sharedTarget, verifySharedFile, verifySharedExecutable }
  from './shared-platform.mjs';
import { sharedArchiveMembers } from './shared-archive-members.mjs';
export { sharedArchiveMember } from './shared-archive-members.mjs';

export function runnerReleaseArtifact(release, arch) {
  const target = sharedTarget(arch);
  requireThat(release?.tag_name === `v${sharedPlatforms.runnerVersion}` &&
    Array.isArray(release.assets), 'INVALID_RUNNER_RELEASE');
  const assets = release.assets.filter(asset => asset.name === target.runnerArchive);
  const url = 'https://github.com/actions/runner/releases/download/' +
    `v${sharedPlatforms.runnerVersion}/${target.runnerArchive}`;
  requireThat(assets.length === 1 &&
    assets[0].digest === `sha256:${target.runnerArchiveSha256}` &&
    assets[0].browser_download_url === url, 'INVALID_RUNNER_RELEASE');
  return { name: target.runnerArchive, sha256: target.runnerArchiveSha256, url };
}

export function nodeManifestArtifact(manifest, arch) {
  const target = sharedTarget(arch);
  requireThat(typeof manifest === 'string' && manifest.length <= 1024 * 1024,
    'INVALID_NODE_MANIFEST');
  const entries = manifest.trim().split('\n').map(line => {
    const entry = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
    requireThat(entry, 'INVALID_NODE_MANIFEST');
    return { sha256: entry[1], name: entry[2] };
  });
  const matches = entries.filter(entry => entry.name === target.nodeArchive);
  requireThat(matches.length === 1 && matches[0].sha256 === target.nodeArchiveSha256,
    'INVALID_NODE_MANIFEST');
  const base = `https://nodejs.org/dist/v${sharedPlatforms.nodeVersion}/`;
  return { ...matches[0], url: base + target.nodeArchive };
}

// Call for every archive use, including a previously populated cache.
export async function verifySharedArchive(path, kind, arch) {
  const target = sharedTarget(arch);
  requireThat(kind === 'runner' || kind === 'node', 'INVALID_SHARED_ARTIFACT');
  await verifySharedFile(path, kind === 'runner' ? target.runnerArchiveSha256 :
    target.nodeArchiveSha256, target, false);
  const members = kind === 'runner' ? [
    ['bin/Runner.Listener', target.listenerSha256],
    ['bin/Runner.Worker', target.workerSha256],
  ] : [[target.nodeMember, target.nodeSha256]];
  const digests = new Map(members);
  for await (const { member, bytes } of sharedArchiveMembers(path, digests.keys())) {
    verifySharedExecutable(bytes, digests.get(member), target);
  }
  return target;
}
