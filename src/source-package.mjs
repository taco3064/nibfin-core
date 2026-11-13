import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { command } from './process.mjs';
import { digest, sha256, isSha, isDigest, requireThat } from './identity.mjs';
import { isSourceMode, matchesSourceMode } from './source-mode.mjs';

export const includesPackagePath = (path) =>
  /^(src|bin|skills|docs)\//.test(path) ||
  /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path) ||
  [
    'scripts/package-ci.mjs',
    'scripts/release-ci.mjs',
    'scripts/host-auto-rollout.py',
    'scripts/nibfin-rollout.service',
    'scripts/nibfin-rollout.timer',
    'package.json',
    'package-lock.json',
    '.node-version',
    'README.md',
    'LICENSE',
  ].includes(path);
const safe = (path) =>
  typeof path === 'string' &&
  path.length <= 100 &&
  /^[A-Za-z0-9._/-]+$/.test(path) &&
  !path.startsWith('/') &&
  path.split('/').every((part) => part && !['.', '..', '.git'].includes(part));

function tar(files) {
  const chunks = [];
  for (const file of files) {
    requireThat(safe(file.path) && Buffer.isBuffer(file.bytes), 'INVALID_PACKAGE_ENTRY');
    const header = Buffer.alloc(512);
    const string = (value, offset, length) =>
      header.write(value, offset, length, 'ascii');
    const octal = (value, offset, length) =>
      string(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    string(file.path, 0, 100);
    octal(file.mode === '100755' ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    string('0', 156, 1);
    string('ustar\0', 257, 6);
    string('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    string(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(
      header,
      file.bytes,
      Buffer.alloc((512 - (file.bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

// Packages committed public source only. Local modifications, private state,
// credentials and injected files cannot silently enter a published artifact.
export async function packageSource(
  root,
  commit,
  { git = '/usr/bin/git', run = command } = {},
) {
  requireThat(isSha(commit), 'INVALID_PACKAGE_COMMIT');
  const readGit = async (args) =>
    (
      await run(
        git,
        ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd: root,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/nonexistent',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
          },
          limit: 32 * 1024 * 1024,
        },
      )
    ).stdout;
  const tree = (await readGit(['ls-tree', '-r', '-z', commit]))
    .toString()
    .split('\0')
    .filter(Boolean);
  const files = [];
  let size = 0;
  for (const entry of tree) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match || !includesPackagePath(match[3])) {
      requireThat(
        !entry.split('\t')[1] || !includesPackagePath(entry.split('\t')[1]),
        'UNSUPPORTED_PACKAGE_TREE',
      );
      continue;
    }
    const [, mode, blob, path] = match;
    requireThat(isSourceMode(mode) && safe(path), 'UNSAFE_PACKAGE_SOURCE');
    const bytes = await readGit(['cat-file', 'blob', blob]);
    size += bytes.length;
    requireThat(size <= 32 * 1024 * 1024 && files.length < 1000, 'PACKAGE_SIZE_LIMIT');
    files.push({ path, mode, bytes });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  requireThat(
    [
      'scripts/package-ci.mjs',
      'scripts/release-ci.mjs',
      'package.json',
      'src/stage-runtime.mjs',
      'skills/scope/SKILL.md',
      'skills/shape/SKILL.md',
      'skills/deliver/SKILL.md',
      'skills/accept/SKILL.md',
    ].every((path) => files.some((file) => file.path === path)),
    'INCOMPLETE_SOURCE_PACKAGE',
  );
  const entries = files.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
  }));
  const manifest = {
    schemaVersion: 1,
    repository: 'taco3064/nibfin-core',
    commit,
    files: entries,
    policyHash: digest(entries.filter((file) => file.path.startsWith('src/'))),
    skillsHash: digest(entries.filter((file) => file.path.startsWith('skills/'))),
  };
  const bytes = gzipSync(
    tar([
      ...files,
      {
        path: 'nibfin-manifest.json',
        mode: '100644',
        bytes: Buffer.from(JSON.stringify(manifest) + '\n'),
      },
    ]),
    { level: 9 },
  );
  return { bytes, sha256: sha256(bytes), manifest, manifestHash: digest(manifest) };
}

export async function verifyInstalledSource(directory, expected) {
  const root = resolve(directory);
  requireThat(
    expected?.repository === 'taco3064/nibfin-core' &&
      isSha(expected.commit) &&
      isDigest(expected.manifestHash) &&
      (await realpath(root)) === root,
    'INVALID_INSTALLATION_PIN',
  );
  const read = async (path) => {
    requireThat(
      safe(path) && (await realpath(join(root, path))) === join(root, path),
      'UNSAFE_INSTALLED_PATH',
    );
    const handle = await open(
      join(root, path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      requireThat(
        stat.isFile() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024,
        'UNSAFE_INSTALLED_FILE',
      );
      return {
        bytes: await handle.readFile(),
        mode: stat.mode & 0o111 ? '100755' : '100644',
      };
    } finally {
      await handle.close();
    }
  };
  const manifest = JSON.parse((await read('nibfin-manifest.json')).bytes.toString());
  requireThat(
    digest(manifest) === expected.manifestHash &&
      manifest.schemaVersion === 1 &&
      manifest.repository === expected.repository &&
      manifest.commit === expected.commit &&
      Array.isArray(manifest.files) &&
      manifest.files.length <= 1000,
    'SOURCE_MANIFEST_MISMATCH',
  );
  const actual = [];
  const walk = async (prefix) => {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      requireThat(safe(path) && !entry.isSymbolicLink(), 'UNSAFE_INSTALLED_PATH');
      if (entry.isDirectory()) {
        requireThat(
          (await lstat(join(root, path))).isDirectory(),
          'INSTALLATION_CHANGED',
        );
        await walk(path);
      } else actual.push(path);
    }
  };
  await walk('');
  requireThat(
    digest(actual.sort()) ===
      digest([...manifest.files.map((file) => file.path), 'nibfin-manifest.json'].sort()),
    'INSTALLATION_FILE_SET_CHANGED',
  );
  for (const file of manifest.files) {
    const observed = await read(file.path);
    requireThat(
      matchesSourceMode(observed.mode, file.mode) &&
        observed.bytes.length === file.size &&
        sha256(observed.bytes) === file.sha256,
      'INSTALLED_SOURCE_CHANGED',
    );
  }
  requireThat(
    manifest.policyHash ===
      digest(manifest.files.filter((file) => file.path.startsWith('src/'))) &&
      manifest.skillsHash ===
        digest(manifest.files.filter((file) => file.path.startsWith('skills/'))),
    'SOURCE_COMPONENT_HASH_MISMATCH',
  );
  return {
    repository: manifest.repository,
    commit: manifest.commit,
    policyHash: manifest.policyHash,
    skillsHash: manifest.skillsHash,
  };
}
