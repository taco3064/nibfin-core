import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  chmod,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { digest, sha256 } from '../src/identity.mjs';
import { verifyInstalledSource } from '../src/source-package.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nibfin-source-mode-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [path, mode, content] of [
    ['bin/launcher', '100755', '#!/bin/sh\nexit 0\n'],
    ['src/entry.mjs', '100644', 'export const value = 1;\n'],
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, {
      mode: mode === '100755' ? 0o755 : 0o644,
    });
    files.push({ path, mode, size: Buffer.byteLength(content), sha256: sha256(content) });
  }
  const manifest = {
    schemaVersion: 1,
    repository: 'taco3064/nibfin-core',
    commit: 'a'.repeat(40),
    files,
    policyHash: digest(files.filter((file) => file.path.startsWith('src/'))),
    skillsHash: digest([]),
  };
  const pin = {
    repository: manifest.repository,
    commit: manifest.commit,
    manifestHash: digest(manifest),
  };
  await writeFile(join(root, 'nibfin-manifest.json'), JSON.stringify(manifest));
  return { root, manifest, pin };
}

test('native cache verifies Git modes and file bytes', async (t) => {
  const f = await fixture(t);
  assert.equal((await verifyInstalledSource(f.root, f.pin)).commit, f.pin.commit);
  await writeFile(join(f.root, 'src/entry.mjs'), 'Changed bytes\n');
  await assert.rejects(verifyInstalledSource(f.root, f.pin), /INSTALLED_SOURCE_CHANGED/);
});

test('invalid modes and extra files reject', async (t) => {
  const f = await fixture(t);
  f.manifest.files[0].mode = '100777';
  await writeFile(join(f.root, 'nibfin-manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(
    verifyInstalledSource(f.root, { ...f.pin, manifestHash: digest(f.manifest) }),
    /INSTALLED_SOURCE_CHANGED/,
  );
  const clean = await fixture(t);
  await writeFile(join(clean.root, 'extra.mjs'), 'Unexpected source\n');
  await assert.rejects(
    verifyInstalledSource(clean.root, clean.pin),
    /INSTALLATION_FILE_SET_CHANGED/,
  );
});

test(
  'POSIX execute-bit tampering still revokes installed source',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const f = await fixture(t);
    await chmod(join(f.root, 'bin/launcher'), 0o644);
    assert.equal(
      await readFile(join(f.root, 'bin/launcher'), 'utf8'),
      '#!/bin/sh\nexit 0\n',
    );
    await assert.rejects(
      verifyInstalledSource(f.root, f.pin),
      /INSTALLED_SOURCE_CHANGED/,
    );
  },
);
