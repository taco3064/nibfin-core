import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { installSource } from '../src/source-install.mjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256 } from '../src/identity.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { packageSource, verifyInstalledSource } from '../src/source-package.mjs';
import { command } from '../src/process.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), installed = join(root, 'installed');
  await mkdir(source); await mkdir(installed);
  const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async args => (await command('/usr/bin/git', args, { cwd: source, env })).stdout.toString().trim();
  await git(['init']);
  for (const path of ['scripts/package-ci.mjs', 'scripts/release-ci.mjs', 'package.json', 'src/stage-runtime.mjs', 'skills/shape/SKILL.md', 'skills/deliver/SKILL.md', 'skills/accept/SKILL.md']) {
    await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), 'Public fixture\n');
  }
  await writeFile(join(source, 'auth.json'), 'Synthetic excluded login file');
  await git(['add', '.']); await git(['commit', '-m', 'Source fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  const pack = await packageSource(source, commit), archive = join(root, 'artifact.tar.gz');
  await writeFile(archive, pack.bytes);
  await command('/usr/bin/tar', ['-xzf', archive, '-C', installed], { env: { PATH: '/usr/bin:/bin' } });
  const expected = { repository: 'taco3064/nibfin-core', commit, manifestHash: pack.manifestHash };
  return { source, installed, commit, pack, expected };
}

test('committed-source package is reproducible, excludes operational files and verifies after real extraction', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'src/stage-runtime.mjs'), 'Uncommitted changes');
  const again = await packageSource(f.source, f.commit);
  assert.equal(again.sha256, f.pack.sha256); assert.deepEqual(again.bytes, f.pack.bytes);
  assert.equal(f.pack.manifest.files.some(file => file.path === 'auth.json'), false);
  assert.deepEqual(await verifyInstalledSource(f.installed, f.expected), { repository: f.expected.repository,
    commit: f.commit, policyHash: f.pack.manifest.policyHash, skillsHash: f.pack.manifest.skillsHash });
});

test('changed source, extra executable, symlink and swapped manifest refuse installed authority', async t => {
  for (const mutation of ['source', 'extra', 'symlink', 'manifest']) {
    const f = await fixture(t);
    if (mutation === 'source') await writeFile(join(f.installed, 'src/stage-runtime.mjs'), 'Changed');
    if (mutation === 'extra') await writeFile(join(f.installed, 'src/extra.mjs'), 'Extra');
    if (mutation === 'symlink') { await rm(join(f.installed, 'package.json')); await symlink(join(f.source, 'package.json'), join(f.installed, 'package.json')); }
    if (mutation === 'manifest') await writeFile(join(f.installed, 'nibfin-manifest.json'), '{}');
    await assert.rejects(verifyInstalledSource(f.installed, f.expected));
  }
});


test('pinned archive installation is immutable, independently verifiable and refuses overwrites', async t => {
  const f = await fixture(t), target = join(f.source, 'installation');
  const expected = { ...f.expected, archiveHash: f.pack.sha256 };
  await installSource(f.pack.bytes, target, expected);
  assert.equal((await verifyInstalledSource(target, expected)).commit, f.commit);
  await assert.rejects(installSource(f.pack.bytes, target, expected), /EXISTS/);
  await assert.rejects(installSource(f.pack.bytes, target + '-other', { ...expected, archiveHash: 'a'.repeat(64) }), /ARCHIVE_PIN/);
});

test('even digest-pinned malformed archives cannot extract paths, links, truncated files or mismatched source', async t => {
  const f = await fixture(t);
  for (const fault of ['path', 'link', 'truncated', 'manifest']) {
    const raw = gunzipSync(f.pack.bytes);
    if (fault === 'path') { raw.fill(0, 0, 100); raw.write('../outside', 0); }
    if (fault === 'link') raw[156] = 50;
    const bytes = gzipSync(fault === 'truncated' ? raw.subarray(0, 700) : raw);
    const expected = { ...f.expected, archiveHash: sha256(bytes), ...(fault === 'manifest' ? { manifestHash: 'a'.repeat(64) } : {}) };
    await assert.rejects(installSource(bytes, join(f.source, fault), expected));
  }
});
