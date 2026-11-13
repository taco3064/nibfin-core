import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, readdir, readFile, rm, writeFile, mkdir, chmod,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRelease } from '../src/release-build.mjs';
import {
  includesPackagePath, verifyInstalledSource, packageSource,
} from '../src/source-package.mjs';
import { installSource } from '../src/source-install.mjs';
import { sha256 } from '../src/identity.mjs';
import { releaseVersion } from '../src/release-version.mjs';
import { command } from '../src/process.mjs';

// Simulate Git reads only; real packaging, extraction, verification and installed
// CLI execution run unchanged. Native Git checkout coverage belongs to PR CI.
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'nibfin-build-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  await mkdir(source);
  const blobs = new Map(), tree = [];
  let packageBlob;
  async function walk(prefix = '') {
    for (const entry of await readdir(resolve(prefix || '.'), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') && !path.startsWith('.github')) continue;
      if (entry.isDirectory()) {
        if (['src', 'bin', 'skills', 'docs', 'scripts', '.github'].includes(path) ||
          prefix) await walk(path);
      } else if (includesPackagePath(path)) {
        const id = (blobs.size + 1).toString(16).padStart(40, '0');
        blobs.set(id, await readFile(path));
        if (path === 'package.json') packageBlob = id;
        tree.push(`100644 blob ${id}\t${path}`);
      }
    }
  }
  await walk();
  const state = { branch: 'refs/heads/main', dirty: '', failEntry: false };
  const commit = 'a'.repeat(40);
  const run = async (exe, args, options) => {
    if (exe === process.execPath) {
      if (state.failEntry) throw new Error('ENTRY_FAILURE');
      return command(exe, args, options);
    }
    let value;
    if (args.includes('--show-toplevel')) value = source;
    else if (args.includes('symbolic-ref')) value = state.branch;
    else if (args.includes('status')) value = state.dirty;
    else if (args.includes('rev-parse')) value = commit;
    else if (args.includes('ls-tree')) {
      value = tree.join('\0') + '\0';
      if (state.unsafe) value = value.replace('100644', '120000');
    }
    else if (args.includes('cat-file')) {
      const bytes = state.incompatible && args.at(-1) === packageBlob
        ? Buffer.from('{"name":"other-package"}') : blobs.get(args.at(-1));
      return { stdout: bytes };
    }
    else throw new Error('Unexpected Git call');
    return { stdout: Buffer.from(value) };
  };
  return { temp, source, state, run, commit, output: join(temp, 'assets') };
}

test('canonical semantic versions reject invalid and ambiguous syntax', () => {
  for (const value of ['1.2.3', '0.0.0-rc.1+build.002', '1.2.3-x-y'])
    assert.equal(releaseVersion(value), value);
  for (const value of ['v1.2.3', '01.2.3', '1.2', '1.2.3-01', '1.2.3\n', ''])
    assert.throws(() => releaseVersion(value));
});

test('stages consistent verified assets and leaves source untouched', async (t) => {
  const f = await fixture(t);
  const result = await buildRelease(f.source, '2.3.4-rc.1', f.output, { run: f.run });
  assert.equal(result.status, 'verified-build');
  assert.equal(result.releaseVersion, '2.3.4-rc.1');
  assert.equal(result.commit, f.commit);
  const pin = JSON.parse(await readFile(join(f.output, 'source-pin.json')));
  const archive = await readFile(join(f.output, 'nibfin-core.tar.gz'));
  assert.equal(sha256(archive), pin.archiveHash);
  assert.equal(await readFile(join(f.output, 'SHA256SUMS'), 'utf8'),
    `${pin.archiveHash}  nibfin-core.tar.gz\n`);
  const installed = join(f.temp, 'installed');
  await installSource(archive, installed, pin);
  await verifyInstalledSource(installed, pin);
  await assert.rejects(verifyInstalledSource(installed,
    { ...pin, releaseVersion: '9.9.9' }), /SOURCE_MANIFEST_MISMATCH/);
  const manifest = JSON.parse(await readFile(join(installed, 'nibfin-manifest.json')));
  assert.equal(manifest.releaseVersion, pin.releaseVersion);
  assert.equal(manifest.developmentVersion,
    JSON.parse(await readFile('package.json')).version);
  assert.deepEqual(await readFile(join(installed, 'package.json')),
    await readFile('package.json'));
  assert.deepEqual(await readdir(f.source), []);
  await assert.rejects(buildRelease(f.source, '2.3.4', f.output, { run: f.run }));
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'source-pin.json'))), pin);
});

test('rejects wrong branch, dirty source, unsafe output and missing tools', async (t) => {
  const f = await fixture(t);
  f.state.branch = 'refs/heads/feature';
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }));
  f.state.branch = 'refs/heads/main';
  f.state.dirty = '?? injected.mjs';
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }));
  f.state.dirty = '';
  await assert.rejects(buildRelease(f.source, '1.2.3', join(f.source, 'out')));
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output,
    { git: '/nonexistent/git' }), /PROCESS_UNAVAILABLE/);
  await writeFile(f.output, 'preserve');
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }));
  assert.equal(await readFile(f.output, 'utf8'), 'preserve');
});

test('verification failure cleans output and temporary installation', async (t) => {
  const f = await fixture(t);
  const before = (await readdir(tmpdir())).filter(x => x.startsWith('nibfin-release-'));
  f.state.failEntry = true;
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }),
    /ENTRY_FAILURE/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith('nibfin-release-')),
    before);
});

test('CLI failures are noninteractive machine-readable denials', async () => {
  const result = await command(process.execPath, [
    resolve('bin/nibfin-core-release.mjs'), '/missing', 'v1.2.3', '/missing',
  ], { allowedExitCodes: [1] });
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(JSON.parse(result.stderr),
    { status: 'denied', code: 'INVALID_RELEASE_VERSION' });
});

test('versioned installation still rejects content and manifest tampering', async (t) => {
  const f = await fixture(t);
  const result = await buildRelease(f.source, '1.2.3', f.output, { run: f.run });
  const installed = join(f.temp, 'installed');
  await installSource(await readFile(join(f.output, 'nibfin-core.tar.gz')),
    installed, result);
  await chmod(join(installed, 'package.json'), 0o600);
  await writeFile(join(installed, 'package.json'), '{}');
  await assert.rejects(verifyInstalledSource(installed, result),
    /INSTALLED_SOURCE_CHANGED/);
  const path = join(installed, 'nibfin-manifest.json');
  const manifest = JSON.parse(await readFile(path));
  await chmod(path, 0o600);
  manifest.releaseVersion = '9.9.9';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyInstalledSource(installed, result),
    /SOURCE_MANIFEST_MISMATCH/);
});


test('unversioned compatibility and unsafe or incompatible tree rejection', async (t) => {
  const f = await fixture(t);
  const built = await packageSource(f.source, f.commit, { run: f.run });
  assert.equal(Object.hasOwn(built.manifest, 'releaseVersion'), false);
  const again = await packageSource(f.source, f.commit, { run: f.run });
  assert.deepEqual(again.bytes, built.bytes);
  f.state.unsafe = true;
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }),
    /UNSAFE_PACKAGE_SOURCE/);
  f.state.unsafe = false;
  f.state.incompatible = true;
  await assert.rejects(buildRelease(f.source, '1.2.3', f.output, { run: f.run }),
    /INCOMPATIBLE_RELEASE_SOURCE/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
