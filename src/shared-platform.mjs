import { readFile, open, constants, realpath } from 'node:fs/promises';
import { machine } from 'node:os';
import { createHash } from 'node:crypto';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import contract from './shared-platform.json' with { type: 'json' };

const hashFields = ['runnerArchiveSha256', 'listenerSha256', 'workerSha256',
  'nodeArchiveSha256', 'nodeSha256'];
const exactKeys = (value, keys) => value && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function platformContract(value, nodeVersion) {
  requireThat(exactKeys(value,
    ['schemaVersion', 'runnerVersion', 'nodeVersion', 'targets']) &&
    value.schemaVersion === 1 && value.nodeVersion === nodeVersion &&
    /^\d+\.\d+\.\d+$/.test(value.runnerVersion) &&
    /^\d+\.\d+\.\d+$/.test(nodeVersion) &&
    exactKeys(value.targets, ['amd64', 'arm64']), 'INVALID_SHARED_PLATFORM');
  const aliases = new Set();
  for (const [arch, target] of Object.entries(value.targets)) {
    requireThat(exactKeys(target, ['artifactArch', 'observations', 'elfMachine',
      ...hashFields]) && target.artifactArch === (arch === 'amd64' ? 'x64' : arch) &&
      Number.isInteger(target.elfMachine) && target.elfMachine > 0 &&
      Array.isArray(target.observations) && target.observations.includes(arch) &&
      target.observations.includes(target.artifactArch) &&
      hashFields.every(key => /^[a-f0-9]{64}$/.test(target[key])),
    'INVALID_SHARED_PLATFORM');
    for (const alias of target.observations) {
      requireThat(typeof alias === 'string' && /^[a-z0-9_]+$/.test(alias) &&
        !aliases.has(alias), 'INVALID_SHARED_PLATFORM');
      aliases.add(alias);
    }
  }
  requireThat(value.targets.amd64.elfMachine !== value.targets.arm64.elfMachine,
    'INVALID_SHARED_PLATFORM');
  return value;
}

export const sharedPlatforms = platformContract(contract, contract.nodeVersion);

export function sharedTarget(arch) {
  requireThat(Object.hasOwn(sharedPlatforms.targets, arch),
    'UNSUPPORTED_SHARED_PLATFORM');
  const record = sharedPlatforms.targets[arch];
  const runnerArchive =
    `actions-runner-linux-${record.artifactArch}-${sharedPlatforms.runnerVersion}.tar.gz`;
  const nodeDirectory =
    `node-v${sharedPlatforms.nodeVersion}-linux-${record.artifactArch}`;
  return { ...record, arch, runnerArchive, nodeDirectory,
    nodeArchive: `${nodeDirectory}.tar.xz`,
    nodeMember: `${nodeDirectory}/bin/node`,
    nodePath: `/opt/nibfin/tools/${nodeDirectory}/bin/node` };
}

export function selectSharedPlatform({ platform, kernel, runtime, executable,
  packageArch, daemon }) {
  requireThat(platform === 'linux', 'UNSUPPORTED_SHARED_PLATFORM');
  const canonical = observation => Object.entries(sharedPlatforms.targets)
    .find(([, value]) => value.observations.includes(observation))?.[0];
  const arch = canonical(kernel);
  const target = sharedTarget(arch);
  requireThat(canonical(runtime) === arch && executable === target.elfMachine &&
    (packageArch === undefined || canonical(packageArch) === arch) &&
    (daemon === undefined || canonical(daemon) === arch),
  'SHARED_PLATFORM_MISMATCH');
  return target;
}

export function elfMachine(bytes) {
  requireThat(bytes.length >= 64 && bytes.subarray(0, 4).equals(
    Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 &&
    bytes[6] === 1 && [2, 3].includes(bytes.readUInt16LE(16)) &&
    bytes.readUInt32LE(20) === 1, 'INVALID_SHARED_EXECUTABLE');
  return bytes.readUInt16LE(18);
}

export function verifySharedExecutable(bytes, digest, target) {
  requireThat(createHash('sha256').update(bytes).digest('hex') === digest,
    'SHARED_ARTIFACT_DIGEST_MISMATCH');
  requireThat(elfMachine(bytes) === target.elfMachine, 'SHARED_PLATFORM_MISMATCH');
}

// The same verifier handles fresh files, cached archives, and installed executables.
export async function verifySharedFile(path, digest, target, executable = true) {
  await rootOwnedPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size > 0 &&
      stat.size <= 512 * 1024 * 1024 &&
      (!executable || (stat.mode & 0o111) !== 0), 'INVALID_SHARED_EXECUTABLE');
    const hash = createHash('sha256');
    const header = Buffer.alloc(64);
    let count = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (count < 64) chunk.copy(header, count, 0, 64 - count);
      count += chunk.length;
      hash.update(chunk);
    }
    requireThat(count === stat.size && hash.digest('hex') === digest,
      'SHARED_ARTIFACT_DIGEST_MISMATCH');
    if (executable) requireThat(elfMachine(header) === target.elfMachine,
      'SHARED_PLATFORM_MISMATCH');
  } finally { await file.close(); }
}

export async function currentSharedPlatform() {
  const version = (await readFile(new URL('../.node-version', import.meta.url),
    'utf8')).trim();
  platformContract(sharedPlatforms, version);
  const file = await open('/proc/self/exe', 'r');
  const bytes = Buffer.alloc(64);
  try { await file.read(bytes, 0, 64, 0); }
  finally { await file.close(); }
  requireThat(process.versions.node === sharedPlatforms.nodeVersion,
    'SHARED_RUNTIME_VERSION_MISMATCH');
  return selectSharedPlatform({ platform: process.platform, kernel: machine(),
    runtime: process.arch, executable: elfMachine(bytes) });
}

export async function installedSharedRuntime() {
  const target = await currentSharedPlatform();
  requireThat(process.execPath === target.nodePath &&
    await realpath('/proc/self/exe') === target.nodePath,
    'SHARED_RUNTIME_PATH_MISMATCH');
  await verifySharedFile(target.nodePath, target.nodeSha256, target);
  return target;
}
