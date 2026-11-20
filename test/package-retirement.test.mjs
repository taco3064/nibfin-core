import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, unlink,
  lstat, realpath, readdir, rename }
  from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sha256, digest } from '../src/identity.mjs';
import { retirePackages } from '../src/package-retirement.mjs';
import { classifyPackage, packageIdentity, removePackage }
  from '../src/package-candidates.mjs';
import { observePackageBindings } from '../src/package-bindings.mjs';
import { rolloutPlanPath } from '../src/rollout-admission.mjs';
import { retirementPath } from '../src/retirement-admission.mjs';

// Controlled protected-host fact: the Runner owns private fixture ancestors.
// Preserve canonical, permission and symlink checks without claiming root ownership.
async function trust(path) {
  const stat = await lstat(path);
  assert.equal(await realpath(path), path);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o022, 0);
}
const remove = (candidate, recheck, ports = {}) =>
  removePackage(candidate, recheck, { trust, ...ports });

async function fixture(t, kind = 'before') {
  const scratch = resolve('.nibfin-cache/tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(join(scratch, 'packages-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, `core-${kind}-${'b'.repeat(40)}`);
  await mkdir(path, { mode: 0o755 });
  const contents = { 'package.json': '{"name":"nibfin-core"}',
    'bin/nibfin-core.mjs': 'console.log("fixture");\n',
    'src/source-package.mjs': '// source fixture\n' };
  const files = [];
  for (const [relative, bytes] of Object.entries(contents)) {
    await mkdir(join(path, relative, '..'), { recursive: true });
    await writeFile(join(path, relative), bytes, { mode: 0o644 });
    files.push({ path: relative, size: Buffer.byteLength(bytes), mode: '100644',
      sha256: sha256(bytes) });
  }
  const manifest = { schemaVersion: 1, repository: 'taco3064/nibfin-core',
    commit: (kind === 'staged' ? 'b' : 'a').repeat(40), files,
    policyHash: digest(files.filter(file => file.path.startsWith('src/'))),
    skillsHash: digest([]) };
  await writeFile(join(path, 'nibfin-manifest.json'), JSON.stringify(manifest));
  let protect = null;
  const ports = {
    discover: async () => await packageIdentity(path) === null ? [] : [path],
    classify: candidate => classifyPackage(candidate, parent, { trust }),
    identity: packageIdentity,
    bindings: async () => () => protect,
    use: async () => ({ used: false }), remove,
  };
  return { parent, path, ports, protect: reason => { protect = reason; } };
}

test('completed backup uses target suffix, retires, and reentry observes absence',
  async t => {
    const { path, ports } = await fixture(t);
    assert.deepEqual(await retirePackages(ports), { retired: [path], retained: [] });
    assert.deepEqual(await retirePackages(ports), { retired: [], retained: [] });
  });

test('former recovery backup retires only after its actual reference ends', async t => {
  const { path, ports, protect } = await fixture(t);
  protect('PACKAGE_INSTALLATION_OR_RECOVERY_REFERENCE');
  const held = await retirePackages(ports);
  assert.equal(held.retained[0].reason, 'PACKAGE_INSTALLATION_OR_RECOVERY_REFERENCE');
  assert.notEqual(await packageIdentity(path), null);
  protect(null);
  assert.deepEqual((await retirePackages(ports)).retired, [path]);
});

test('foreign, symlinked, writable, and additional content stays intact', async t => {
  const { path, parent, ports } = await fixture(t, 'staged');
  await writeFile(join(path, 'user-backup'), 'private');
  assert.equal((await retirePackages(ports)).retired.length, 0);
  assert.equal(await readFile(join(path, 'user-backup'), 'utf8'), 'private');
  await unlink(join(path, 'user-backup'));
  await symlink(parent, join(path, 'outside'));
  assert.equal((await retirePackages(ports)).retired.length, 0);
  await unlink(join(path, 'outside'));
  await chmod(path, 0o777);
  assert.equal((await retirePackages(ports)).retired.length, 0);
  await chmod(path, 0o755);
  const file = join(path, 'nibfin-manifest.json');
  const source = JSON.parse(await readFile(file, 'utf8'));
  source.repository = 'someone/else';
  await writeFile(file, JSON.stringify(source));
  assert.equal((await retirePackages(ports)).retired.length, 0);
});

test('kernel uncertainty and changed candidate identity defer deletion', async t => {
  const { path, ports } = await fixture(t);
  ports.use = async () =>
    ({ used: true, reason: 'PACKAGE_PROCESS_VISIBILITY_INCOMPLETE' });
  assert.equal((await retirePackages(ports)).retained[0].reason,
    'PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
  ports.identity = async () => 'replacement';
  assert.equal((await retirePackages(ports)).retained[0].reason,
    'PACKAGE_IDENTITY_CHANGED');
  assert.notEqual(await packageIdentity(path), null);
});

test('a binding introduced immediately before removal protects surviving content',
  async t => {
    const { path, ports, protect } = await fixture(t);
    ports.remove = async (candidate, recheck) => {
      protect('PACKAGE_ADOPTED_OR_RECOVERY_REFERENCE');
      return remove(candidate, recheck);
    };
    assert.equal((await retirePackages(ports)).retained[0].reason,
      'PACKAGE_ADOPTED_OR_RECOVERY_REFERENCE');
    assert.ok(await readFile(join(path, 'bin/nibfin-core.mjs')));
  });

test('interrupted payload removal keeps original manifest and ordinary retry resumes',
  async t => {
    const { path, ports } = await fixture(t);
    ports.remove = async candidate => {
      await unlink(join(path, 'bin/nibfin-core.mjs'));
      throw new Error('simulated interruption');
    };
    assert.equal((await retirePackages(ports)).retired.length, 0);
    assert.ok(await readFile(join(path, 'nibfin-manifest.json')));
    ports.remove = remove;
    assert.deepEqual((await retirePackages(ports)).retired, [path]);
  });

test('lost removal response reuses filesystem absence', async t => {
  const { path, ports } = await fixture(t);
  ports.remove = async (candidate, recheck) => {
    await remove(candidate, recheck);
    throw new Error('simulated lost response');
  };
  assert.deepEqual(await retirePackages(ports), { retired: [path], retained: [] });
});

test('apply current/next resources, recovery paths and unfinished replacement protect',
  async () => {
    const parent = '/opt/nibfin', commit = 'b'.repeat(40);
    const backup = `${parent}/core-before-${commit}`;
    const other = `${parent}/core-before-${'c'.repeat(40)}`;
    const resource = `${parent}/core-staged-${'d'.repeat(40)}`;
    const host = { installation: { directory: `${parent}/core` } };
    const context = { host, inspect: async () => {} };
    let plan = { pin: { commit }, apply: { completed: true,
      targets: [{ current: JSON.stringify(host), next: JSON.stringify(host) }],
      resources: [{ current: JSON.stringify({ executable: other + '/bin/core' }),
        next: JSON.stringify({ executable: resource + '/bin/core' }) }] } };
    let retirement = null;
    const ports = { read: async path => path === rolloutPlanPath ? plan :
      path === retirementPath ? retirement : null };
    const candidate = path => ({ path, manifest: JSON.stringify({ commit }) });
    let binding = await observePackageBindings(context, ports);
    assert.ok(binding(candidate(backup)));
    assert.ok(binding(candidate(`${parent}/core-staged-${commit}`)));
    assert.ok(binding(candidate(other)));
    assert.ok(binding(candidate(resource)));
    // Apply completion still needs the backup until verified release removes intent.
    plan = null;
    binding = await observePackageBindings(context, ports);
    assert.equal(binding(candidate(backup)), null);
    retirement = { phase: 'retired', replacement: { phase: 'prepared' },
      binding: { adoptions: [{ bytes: JSON.stringify({ source: { commit } }) }] } };
    binding = await observePackageBindings(context, ports);
    assert.equal(binding(candidate(backup)), 'PACKAGE_REPLACEMENT_RECOVERY_REFERENCE');
    retirement.replacement.phase = 'released';
    binding = await observePackageBindings(context, ports);
    assert.equal(binding(candidate(backup)), null);
  });

test('uncertain candidate does not prevent retirement of an unrelated owned copy',
  async t => {
    const first = await fixture(t), second = await fixture(t, 'staged');
    const ports = { ...second.ports,
      discover: async () => [first.path, second.path],
      classify: path => path === first.path ?
        first.ports.classify(path) : second.ports.classify(path),
      use: async path => ({ used: path === first.path,
        reason: 'PACKAGE_PROCESS_OR_MOUNT_REFERENCE' }),
    };
    const result = await retirePackages(ports);
    assert.deepEqual(result.retired, [second.path]);
    assert.equal(result.retained[0].path, first.path);
  });

test('missing original metadata is never reconstructed from a package-shaped name',
  async t => {
    const { path, ports } = await fixture(t);
    await rm(path, { recursive: true });
    await mkdir(path);
    const result = await retirePackages(ports);
    assert.equal(result.retained[0].reason, 'PACKAGE_METADATA_UNAVAILABLE');
    assert.notEqual(await packageIdentity(path), null);
  });

test('adopted aliases and normalized paths protect, failed reads remain uncertain',
  async () => {
    const path = '/opt/nibfin/core-before-' + 'e'.repeat(40);
    const host = { installation: { directory: '/opt/nibfin/core' },
      recoveryExecutable: '/adopted/alias' };
    const context = { host, inspect: async () => {} };
    const candidate = { path, manifest: '{}' };
    const ports = { read: async () => null,
      canonical: async value => value === '/adopted/alias' ? path + '/bin/core' : value };
    assert.ok((await observePackageBindings(context, ports))(candidate));
    host.recoveryExecutable = path + '/../' + path.split('/').at(-1) + '/bin/core';
    ports.canonical = async value => value;
    assert.ok((await observePackageBindings(context, ports))(candidate));
    ports.read = async () => { throw Object.assign(new Error(), { code: 'EACCES' }); };
    await assert.rejects(observePackageBindings(context, ports), { code: 'EACCES' });
  });


test('interruption after manifest unlink retains identity evidence for ordinary retry',
  async t => {
    const { path, ports, protect } = await fixture(t);
    ports.remove = (candidate, recheck) => remove(candidate, recheck, {
      removeDirectory: async () => { throw new Error('simulated interruption'); },
    });
    assert.equal((await retirePackages(ports)).retired.length, 0);
    assert.deepEqual(await readdir(path), []);
    ports.remove = remove;
    protect('PACKAGE_ADOPTED_OR_RECOVERY_REFERENCE');
    assert.equal((await retirePackages(ports)).retained[0].reason,
      'PACKAGE_ADOPTED_OR_RECOVERY_REFERENCE');
    protect(null);
    assert.deepEqual(await retirePackages(ports), { retired: [path], retained: [] });
  });

test('finalization evidence never authorizes unexpected surviving payload', async t => {
  const { path, ports } = await fixture(t);
  ports.remove = (candidate, recheck) => remove(candidate, recheck, {
    removeDirectory: async () => { throw new Error('simulated interruption'); },
  });
  await retirePackages(ports);
  await writeFile(join(path, 'foreign'), 'user data');
  ports.remove = remove;
  assert.equal((await retirePackages(ports)).retired.length, 0);
  assert.equal(await readFile(join(path, 'foreign'), 'utf8'), 'user data');
});


test('finalization evidence is bound to its original directory path', async t => {
  const { path, parent, ports } = await fixture(t);
  ports.remove = (candidate, recheck) => remove(candidate, recheck, {
    removeDirectory: async () => { throw new Error('simulated interruption'); },
  });
  await retirePackages(ports);
  const moved = join(parent, `core-before-${'c'.repeat(40)}`);
  await rename(path, moved);
  await assert.rejects(ports.classify(moved), { code: 'PACKAGE_METADATA_UNAVAILABLE' });
  assert.deepEqual(await readdir(moved), []);
});

test('management recovery protects selected paths rather than every matching pin',
  async () => {
    const path = '/opt/nibfin/core-before-' + 'd'.repeat(40);
    const pin = { commit: 'a'.repeat(40) };
    const context = { host: { installation: { directory: '/opt/nibfin/core' } },
      inspect: async () => {} };
    let selected = path;
    const ports = {
      read: async file => file.endsWith('source-pin.json') ? pin : null,
      canonical: async value => value,
      selectSource: async observed => {
        assert.deepEqual(observed, pin);
        return { path: selected };
      },
    };
    const candidate = { path, manifest: JSON.stringify(pin) };
    assert.ok((await observePackageBindings(context, ports))(candidate));
    selected = '/opt/nibfin/core';
    assert.equal((await observePackageBindings(context, ports))(candidate), null);
  });
