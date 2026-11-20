import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, sha256 } from '../src/identity.mjs';
import { inspectRetirementPackage, removeRetirementPackage }
  from '../src/core-package-retirement-files.mjs';
import { retireCorePackages } from '../src/core-package-retirement.mjs';
import { readdir } from 'node:fs/promises';

export async function fixture(t) {
  await mkdir('.deliver-test-tmp', { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(join(process.cwd(), '.deliver-test-tmp/package-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

export async function source(parent, name, commit = 'a'.repeat(40)) {
  const path = join(parent, name);
  const files = [];
  for (const relative of ['src/example.mjs', 'skills/example/SKILL.md']) {
    const bytes = Buffer.from(`source ${relative}\n`);
    await mkdir(join(path, relative, '..'), { recursive: true });
    await writeFile(join(path, relative), bytes, { mode: 0o644 });
    files.push({ path: relative, mode: '100644', size: bytes.length,
      sha256: sha256(bytes) });
  }
  const manifest = { schemaVersion: 1, repository: 'taco3064/nibfin-core',
    commit, files, policyHash: digest(files.filter(file =>
      file.path.startsWith('src/'))), skillsHash: digest(files.filter(file =>
      file.path.startsWith('skills/'))) };
  await writeFile(join(path, 'nibfin-manifest.json'), JSON.stringify(manifest));
  return { path, manifest, pin: { repository: manifest.repository, commit,
    manifestHash: digest(manifest) } };
}

export function sweep(parent, overrides = {}) {
  return retireCorePackages({ list: () => readdir(parent),
    inspect: name => inspectRetirementPackage(parent, name),
    protection: async () => null, unused: async () => {},
    remove: removeRetirementPackage, ...overrides });
}
export const name = (kind = 'staged', commit = 'a') =>
  `core-${kind}-${commit.repeat(40)}`;
