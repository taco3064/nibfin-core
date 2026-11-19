import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { sharedArchiveMembers } from './shared-archive-members.mjs';
import { sharedPlatforms, sharedTarget, elfMachine, verifySharedFile }
  from './shared-platform.mjs';
import { command } from './process.mjs';

export const installedRunnerIdentityFile = '.nibfin-runner-identity.json';
const invalid = 'INVALID_INSTALLED_RUNNER_IDENTITY';
const keys = (value, names) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') ===
    [...names].sort().join(',');
const matches = (pattern, value) => typeof value === 'string' &&
  pattern.exec(value)?.[0] === value;
const digest = value => matches(/^[a-f0-9]{64}$/, value);

export function officialRunnerArtifact(release, arch) {
  const target = sharedTarget(arch);
  requireThat(matches(/^v\d+\.\d+\.\d+$/, release?.tag_name) &&
    Array.isArray(release.assets), 'INVALID_RUNNER_RELEASE');
  const version = release.tag_name.slice(1);
  const name = `actions-runner-linux-${target.artifactArch}-${version}.tar.gz`;
  const url = 'https://github.com/actions/runner/releases/download/' +
    `${release.tag_name}/${name}`;
  const assets = release.assets.filter(asset => asset.name === name);
  requireThat(assets.length === 1 && assets[0].browser_download_url === url &&
    matches(/^sha256:[a-f0-9]{64}$/, assets[0].digest), 'INVALID_RUNNER_RELEASE');
  return { name, url, sha256: assets[0].digest.slice(7) };
}

export function installedRunnerIdentity(value, local, target) {
  const arch = target.artifactArch === 'x64' ? 'amd64' : target.artifactArch;
  requireThat(keys(value, ['schemaVersion', 'arch', 'release', 'artifact',
    'registration', 'listenerSha256', 'workerSha256']) &&
    value.schemaVersion === 1 && value.arch === arch &&
    matches(/^v\d+\.\d+\.\d+$/, value.release) &&
    keys(value.artifact, ['name', 'url', 'sha256']) &&
    digest(value.artifact.sha256) && digest(value.listenerSha256) &&
    digest(value.workerSha256) &&
    keys(value.registration, ['id', 'name', 'url']) &&
    Number.isSafeInteger(value.registration.id) && value.registration.id > 0 &&
    typeof value.registration.name === 'string' && value.registration.name &&
    matches(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      value.registration.url) &&
    value.registration.id === local.agentId &&
    value.registration.name === local.agentName &&
    value.registration.url === local.gitHubUrl && local.workFolder === '_work', invalid);
  const artifact = officialRunnerArtifact({ tag_name: value.release, assets: [{
    ...value.artifact, digest: `sha256:${value.artifact.sha256}`,
    browser_download_url: value.artifact.url,
  }] }, arch);
  requireThat(artifact.name === value.artifact.name, invalid);
  return value;
}

function facts(artifact, release, local, target, listenerSha256, workerSha256) {
  return installedRunnerIdentity({ schemaVersion: 1, arch: target.arch,
    release, artifact, registration: { id: local.agentId, name: local.agentName,
      url: local.gitHubUrl }, listenerSha256, workerSha256 }, local, target);
}

// Only the trusted installer calls this after reading authenticated actions/runner
// release metadata. Archive bytes are verified before deriving executable facts.
export async function deriveOfficialRunnerIdentity(path, release, arch, local, {
  inspect = rootOwnedPath, verify = verifySharedFile, run = command,
} = {}) {
  const target = sharedTarget(arch);
  const artifact = officialRunnerArtifact(release, arch);
  await verify(path, artifact.sha256, target, false);
  const hashes = [];
  const members = ['bin/Runner.Listener', 'bin/Runner.Worker'];
  for await (const { bytes } of sharedArchiveMembers(path, members, { inspect, run })) {
    requireThat(elfMachine(bytes) === target.elfMachine, 'SHARED_PLATFORM_MISMATCH');
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
  }
  return facts(artifact, release.tag_name, local, target, ...hashes);
}

// Compatibility is attested by the already trusted bootstrap package contract,
// never by ownership alone. A newer package uses deriveOfficialRunnerIdentity.
export function legacyRunnerIdentity(local, target,
  bootstrapVersion = sharedPlatforms.runnerVersion) {
  const release = `v${bootstrapVersion}`;
  return facts({ name: target.runnerArchive,
    url: `https://github.com/actions/runner/releases/download/${release}/` +
      target.runnerArchive, sha256: target.runnerArchiveSha256 }, release,
  local, target, target.listenerSha256, target.workerSha256);
}

export async function verifyRunnerIdentityFiles(directory, identity, target,
  verify = verifySharedFile) {
  await verify(join(directory, 'bin', 'Runner.Listener'),
    identity.listenerSha256, target);
  await verify(join(directory, 'bin', 'Runner.Worker.official'),
    identity.workerSha256, target);
}
