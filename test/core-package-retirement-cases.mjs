import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile }
  from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, source, sweep, name } from './core-package-retirement-fixture.mjs';
import { inspectRetirementPackage, removeRetirementPackage, retirementEvidenceName }
  from '../src/core-package-retirement-files.mjs';
import { packageProtection } from '../src/core-package-retirement-references.mjs';
import { selectAdoptedSource } from '../src/adopted-source-path.mjs';
import { requireNoResourceReferences } from '../src/resource-references.mjs';
import { requireNoMountReferences } from '../src/retirement-observe.mjs';
import { requireNoPackageServices }
  from '../src/core-package-retirement-services.mjs';
import { verifyInstalledSource } from '../src/source-package.mjs';
import { projectRolloutResult } from '../src/core-rollout-result.mjs';

import { fixtureOwnedPath, requireProductionRefusal }
  from './core-package-retirement-ownership.mjs';

const noop = async () => {};

test('fixture policy checks real identity, ancestors, permissions and symlinks',
  async t => {
    const parent = await fixture(t);
    const { path } = await source(parent, name());
    await fixtureOwnedPath(join(path, 'src/example.mjs'));
    // Classification must succeed before any negative mutation is introduced.
    assert.equal((await inspectRetirementPackage(parent, name())).path, path);
    await assert.rejects(fixtureOwnedPath('/'),
      { code: 'UNTRUSTED_ADOPTION_PATH' });
    await chmod(join(path, 'src'), 0o777);
    await assert.rejects(fixtureOwnedPath(join(path, 'src/example.mjs')),
      { code: 'UNTRUSTED_ADOPTION_PATH' });
    await requireProductionRefusal(join(path, 'src/example.mjs'));
    await chmod(join(path, 'src'), 0o755);
    await symlink(join(path, 'src'), join(path, 'alias'));
    await assert.rejects(fixtureOwnedPath(join(path, 'alias/example.mjs')),
      { code: 'UNTRUSTED_ADOPTION_PATH' });
    if (process.getuid() !== 0) await requireProductionRefusal(path);
  });

test('owned staged and former backup attribution; unrelated names survive', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const backup = await source(parent, name('before', 'b'));
  const inspected = await inspectRetirementPackage(parent, name('before', 'b'));
  assert.equal(inspected.pin.commit, backup.pin.commit);
  await mkdir(join(parent, 'foreign'));
  assert.deepEqual((await sweep(parent)).map(item => item.status),
    ['removed', 'removed']);
  assert.deepEqual(await readdir(parent), ['foreign']);
  assert.deepEqual(await sweep(parent), []);
});

test('changed, injected, damaged, writable and symlinked contents survive', async t => {
  const parent = await fixture(t);
  const cases = [
    async path => writeFile(join(path, 'src/example.mjs'), 'foreign'),
    async path => writeFile(join(path, 'foreign'), 'retain'),
    async path => unlink(join(path, 'src/example.mjs')),
    async path => chmod(join(path, 'skills'), 0o777),
    async path => {
      await unlink(join(path, 'src/example.mjs'));
      await symlink('/etc/passwd', join(path, 'src/example.mjs'));
    },
  ];
  for (const change of cases) {
    const { path } = await source(parent, name());
    await inspectRetirementPackage(parent, name());
    await change(path);
    assert.equal((await sweep(parent))[0].status, 'retained');
    assert.ok((await readdir(parent)).includes(name()));
    await rm(path, { recursive: true });
  }
  const { path } = await source(parent, 'foreign-source');
  await symlink(path, join(parent, name()));
  assert.equal((await sweep(parent))[0].status, 'retained');
});

test('candidate uncertainty stays isolated and sanitized', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  await source(parent, name('before', 'b'));
  const report = await sweep(parent, { unused: async candidate => {
    if (candidate.name === name()) throw new Error('/private/credential');
  } });
  assert.equal(report.find(item => item.package === name()).status, 'retained');
  assert.equal(report.find(item => item.package === name('before', 'b')).status,
    'removed');
  assert.ok(!JSON.stringify(report).includes('/private'));
});

test('interrupted deletion resumes only attributed remainder', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const candidate = await inspectRetirementPackage(parent, name());
  let calls = 0;
  await assert.rejects(removeRetirementPackage(candidate, noop, {
    effect: async (path, directory) => {
      if (++calls === 2) throw new Error('interrupted');
      if (directory) await rm(path, { recursive: false });
      else await unlink(path);
    },
  }), /interrupted/);
  assert.ok((await readdir(candidate.path)).includes('nibfin-manifest.json'));
  await assert.rejects(verifyInstalledSource(candidate.path, candidate.pin),
    { code: 'INSTALLATION_FILE_SET_CHANGED' });
  assert.ok((await readdir(parent)).includes(retirementEvidenceName(name())));
  assert.equal((await sweep(parent))[0].status, 'removed');
  assert.deepEqual(await readdir(parent), []);
});

test('changed remainder and replaced candidate retain their evidence', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const candidate = await inspectRetirementPackage(parent, name());
  await assert.rejects(removeRetirementPackage(candidate, noop,
    { effect: async () => { throw new Error('interrupted'); } }));
  await writeFile(join(candidate.path, 'src/example.mjs'), 'injected');
  assert.equal((await sweep(parent))[0].code, 'PACKAGE_CONTENTS_CHANGED');
  await rename(candidate.path, join(parent, 'saved'));
  await source(parent, name());
  assert.equal((await sweep(parent))[0].code, 'PACKAGE_IDENTITY_CHANGED');
  assert.ok((await readdir(parent)).includes(retirementEvidenceName(name())));
});

test('loss of deletion response and final manifest gap read actual state', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const candidate = await inspectRetirementPackage(parent, name());
  const { rmdir } = await import('node:fs/promises');
  await removeRetirementPackage(candidate, noop, { effect: async (path, directory) => {
    if (directory) await rmdir(path); else await unlink(path);
    throw new Error('response lost');
  } });
  assert.deepEqual(await readdir(parent), []);
  await source(parent, name());
  const next = await inspectRetirementPackage(parent, name());
  await assert.rejects(removeRetirementPackage(next, noop, {
    effect: async (path, directory) => {
      if (path === next.path) throw new Error('before final directory');
      if (directory) await rmdir(path); else await unlink(path);
    },
  }));
  assert.deepEqual(await readdir(next.path), []);
  assert.equal((await sweep(parent))[0].status, 'removed');
  // A crash after directory removal leaves only the intent. Confirmed absence
  // is sufficient to finish it without replaying any package removal.
  await source(parent, name());
  const last = await inspectRetirementPackage(parent, name());
  await assert.rejects(removeRetirementPackage(last, async () => {
    if ((await readdir(last.path)).length === 0) {
      await rmdir(last.path);
      throw new Error('lost after directory');
    }
  }));
  assert.equal((await sweep(parent))[0].status, 'removed');
});

test('identity and new reference are rechecked before destructive work', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  let checks = 0;
  const report = await sweep(parent, { protection: async () =>
    ++checks > 1 ? 'ACTIVE_APPLY' : null });
  assert.equal(report[0].code, 'ACTIVE_APPLY');
  assert.equal(await readFile(join(parent, name(), 'src/example.mjs'), 'utf8'),
    'source src/example.mjs\n');
});

test('adoption, peers, active apply and recovery selections', async t => {
  const parent = await fixture(t);
  const old = await source(parent, name('before', 'b'));
  const current = await source(parent, 'core', 'c'.repeat(40));
  const candidate = await inspectRetirementPackage(parent, name('before', 'b'));
  const live = join(parent, 'core'), config = join(parent, 'config');
  const host = { installation: { directory: live, pin: current.pin } };
  let plan = null, peer = null, closure = null;
  const ports = { live, config, read: async path => {
    if (path.endsWith('/host.json')) return host;
    if (path.endsWith('/host.peer.json')) return peer;
    if (path.endsWith('/rollout-admission.json')) return closure;
    return plan;
  }, match: async (path, pin) => path === live && pin === current.pin ?
    { path, source: current.pin } : path === candidate.path && pin === old.pin ?
      { path, source: old.pin } : null };
  assert.equal(await packageProtection(candidate, ports), null);
  assert.equal(await packageProtection({ ...candidate, pin: current.pin }, ports), null);
  closure = { schemaVersion: 1, pin: { ...current.pin, commit: 'b'.repeat(40) } };
  assert.equal(await packageProtection(candidate, ports), 'ACTIVE_APPLY');
  closure = null;
  peer = { installation: { directory: live, pin: old.pin } };
  host.wakePeerFiles = [join(config, 'host.peer.json')];
  await assert.rejects(packageProtection(candidate, ports),
    { code: 'PACKAGE_ADOPTION_UNAVAILABLE' });
  host.wakePeerFiles = [];
  plan = { schemaVersion: 2, pin: { ...current.pin, commit: 'b'.repeat(40) },
    apply: { oldPin: old.pin } };
  assert.equal(await packageProtection(candidate, ports), 'ACTIVE_APPLY');
  plan.pin = current.pin;
  // The former B-suffixed backup is obsolete; the current C-target fallback
  // contains A, even though its suffix identifies C.
  assert.equal(await packageProtection(candidate, { ...ports,
    managementPins: async () => [old.pin] }), null);
  // Historical unrelated pins do not create another recovery registry.
  assert.equal(await packageProtection(candidate, { ...ports,
    managementPins: async () => [{ ...old.pin, commit: 'd'.repeat(40) }] }), null);
  plan = { schemaVersion: 2, pin: current.pin };
  assert.equal(await packageProtection(candidate, ports), null);
  peer = { installation: { directory: live,
    pin: { ...old.pin, commit: 'd'.repeat(40) } } };
  host.wakePeerFiles = [join(config, 'host.peer.json')];
  assert.equal(await packageProtection(candidate, ports), null);
  host.sharedRunner = { repositories: [42] };
  await assert.rejects(packageProtection(candidate, ports),
    { code: 'PACKAGE_ADOPTION_UNAVAILABLE' });
  delete host.sharedRunner;
  peer = null;
  host.wakePeerFiles = [join(config, 'host.peer.json')];
  await assert.rejects(packageProtection(candidate, ports),
    { code: 'PACKAGE_ADOPTION_UNAVAILABLE' });
});

test('healthy live selection does not read unrelated stale plan', async () => {
  const pin = { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64) };
  const host = { installation: { directory: '/opt/nibfin/core', pin } };
  const selected = await selectAdoptedSource(pin, host, { live: '/opt/nibfin/core',
    match: async path => ({ path }),
    readPlan: async () => { throw new Error('stale'); } });
  assert.equal(selected.path, '/opt/nibfin/core');
});

test('missing exe never skips other live process evidence', async t => {
  const parent = await fixture(t), proc = join(parent, 'proc');
  const pid = join(proc, '12'), path = join(parent, 'package');
  await mkdir(join(pid, 'fd'), { recursive: true });
  await writeFile(join(pid, 'maps'), `00-01 r-xp 0 00:00 1 ${path}/source\n`);
  await assert.rejects(requireNoResourceReferences(path, { proc, mounts: noop }),
    { code: 'MANAGED_RESOURCE_IN_USE' });
  await writeFile(join(pid, 'maps'), '');
  await symlink(path + '/open', join(pid, 'fd/9'));
  await assert.rejects(requireNoResourceReferences(path, { proc, mounts: noop }));
  await unlink(join(pid, 'fd/9'));
  await symlink(path, join(pid, 'root'));
  await assert.rejects(requireNoResourceReferences(path, { proc, mounts: noop }),
    { code: 'MANAGED_RESOURCE_IN_USE' });
  await unlink(join(pid, 'root'));
  await requireNoResourceReferences(path, { proc, mounts: noop });
  await unlink(join(pid, 'maps'));
  await assert.rejects(requireNoResourceReferences(path, { proc, mounts: noop }),
    { code: 'ENOENT' });
  await rm(pid, { recursive: true });
  await requireNoResourceReferences(path, { proc, mounts: noop });
});

test('decoded mount roots, sources and targets use component boundaries', () => {
  const path = '/opt/nibfin/core-staged-' + 'a'.repeat(40);
  const mount = (root, target, source) =>
    `12 1 8:1 ${root} ${target} rw - ext4 ${source} rw`;
  const host = '1 0 8:1 / / rw - ext4 /dev/x rw';
  for (const text of [mount(path + '/src', '/elsewhere', '/dev/x'),
    mount('/', path, '/dev/x'), mount('/', '/elsewhere', path)])
    assert.throws(() => requireNoMountReferences(path, text, host),
      { code: 'RETIREMENT_RESOURCE_MOUNTED' });
  requireNoMountReferences(path, mount(path + '-other', '/elsewhere', '/dev/x'), host);
  assert.throws(() => requireNoMountReferences('/source path',
    mount('/source\\040path', '/elsewhere', '/dev/x'), host),
  { code: 'RETIREMENT_RESOURCE_MOUNTED' });
  assert.throws(() => requireNoMountReferences(path, 'malformed'));
});

test('filesystem-relative bind roots retain only the referenced package', async t => {
  const parent = await fixture(t);
  const { path } = await source(parent, name());
  await source(parent, name('before', 'b'));
  const mountPoint = parent.replaceAll(' ', '\\040');
  const normal = '1 0 8:1 / / rw - ext4 /dev/x rw';
  const anchor = `11 1 8:2 /volume ${mountPoint} rw - ext4 /dev/y rw`;
  const host = [normal, anchor].join('\n');
  const root = `/volume/${name()}/src`;
  const bind = (device, root) => `21 20 ${device} ${root} /app rw - ext4 /dev/y rw`;
  assert.throws(() => requireNoMountReferences(path,
    [host, bind('8:2', root)].join('\n')), { code: 'RETIREMENT_RESOURCE_MOUNTED' });
  assert.throws(() => requireNoMountReferences(path,
    '21 20 8:2 /volume / rw - ext4 /dev/y rw', host),
  { code: 'RETIREMENT_RESOURCE_MOUNTED' });
  requireNoMountReferences(path, host.replace('11 1', '31 1'), host);
  requireNoMountReferences(path,
    [host, '21 20 0:4 net:[40] /run/netns/x rw shared:1 - nsfs nsfs rw'].join('\n'));
  requireNoMountReferences(path, bind('8:3', root), host);
  requireNoMountReferences(path, bind('8:2', `/volume/${name()}-other`), host);
  const report = await sweep(parent, {
    unused: candidate => requireNoMountReferences(candidate.path, bind('8:2', root),
      host),
  });
  assert.deepEqual(report, [
    { package: name('before', 'b'), status: 'removed', code: 'PACKAGE_REMOVED' },
    { package: name(), status: 'retained', code: 'RETIREMENT_RESOURCE_MOUNTED' },
  ]);
  assert.equal((await inspectRetirementPackage(parent, name())).path, path);
});

test('inactive service references and uncertain reload preserve source', async () => {
  let properties = 'LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=/package\n';
  const run = async (_program, args) => ({ stdout: Buffer.from(
    args[0] === 'show' ? properties : 'example.service disabled\n') });
  await assert.rejects(requireNoPackageServices('/package', run),
    { code: 'PACKAGE_SERVICE_REFERENCE' });
  properties = properties.replace('/package', '/work');
  await requireNoPackageServices('/package', run);
  properties = properties.replace('Reload=no', 'Reload=yes');
  await assert.rejects(requireNoPackageServices('/package', run),
    { code: 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE' });
});

test('equivalent native service paths retain packages through the sweep', async t => {
  const parent = await fixture(t);
  const { path } = await source(parent, name());
  await symlink(path, join(parent, 'service-source'));
  await symlink(path + '/src', join(parent, 'service-directory'));
  const paths = [path + '/./src/example.mjs',
    path + '/src/../src/example.mjs',
    join(parent, 'service-source/src/example.mjs'),
    parent + '/service-directory/../src/example.mjs'];
  for (const argument of paths) {
    const run = async (_program, args) => ({ stdout: Buffer.from(
      args[0] === 'show' ? 'LoadState=loaded\nNeedDaemonReload=no\n' +
        `ExecStart={ argv[]=${process.execPath} --import=${argument} ; }\n` :
        'example.service disabled\n') });
    const report = await sweep(parent, {
      unused: candidate => requireNoPackageServices(candidate.path, run),
    });
    assert.equal(report[0].code, 'PACKAGE_SERVICE_REFERENCE');
    assert.equal((await inspectRetirementPackage(parent, name())).path, path);
  }
});

test('absent service working paths cannot defer an unrelated package', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const run = async (_program, args) => ({ stdout: Buffer.from(
    args[0] === 'show' ? 'LoadState=loaded\nNeedDaemonReload=no\n' +
      `EnvironmentFiles=${parent}/absent (ignore_errors=yes)\n` +
      'ExecStart={ path=/bin/echo ; argv[]=@echo oneshot ; }\n' :
      'example.service disabled\n') });
  const report = await sweep(parent, {
    unused: candidate => requireNoPackageServices(candidate.path, run),
  });
  assert.equal(report[0].code, 'PACKAGE_REMOVED');
  assert.ok(!(await readdir(parent)).includes(name()));
});

test('concrete service instances use root-relative working and executable paths',
  async t => {
    const parent = await fixture(t);
    const { path } = await source(parent, name());
    const units = [];
    const unit = 'example@slot.service';
    const run = async (_program, [operation, name]) => {
      if (operation === 'list-units') return { stdout: Buffer.from(
        'ghost.service not-found inactive dead\n' + unit + ' loaded inactive dead\n') };
      if (operation !== 'show') return { stdout: Buffer.from(
        'example@.service disabled\n') };
      if (name === 'ghost.service') return { stdout: Buffer.from(
        'LoadState=not-found\nNeedDaemonReload=no\nFragmentPath=\n') };
      units.push(name);
      assert.equal(name, unit);
      return { stdout: Buffer.from('LoadState=loaded\nNeedDaemonReload=no\n' +
        `RootDirectory=${parent}\nWorkingDirectory=/\n` +
        `ExecStart={ path=/bin/node ; argv[]=node ./${path.split('/').at(-1)}` +
        '/src/example.mjs ; }\n') };
    };
    const report = await sweep(parent, {
      unused: candidate => requireNoPackageServices(candidate.path, run),
    });
    assert.equal(report[0].code, 'PACKAGE_SERVICE_REFERENCE');
    assert.deepEqual(units, [unit]);
});

test('service file URLs retain executable packages with decoded boundaries', async t => {
  const parent = await fixture(t);
  const { path } = await source(parent, name());
  const url = pathToFileURL(path + '/src/example.mjs').href;
  let argument;
  const run = async (_program, args) => ({ stdout: Buffer.from(
    args[0] === 'show' ? 'LoadState=loaded\nNeedDaemonReload=no\n' +
      `ExecStart={ argv[]=${process.execPath} --import=${argument} ` +
      `/work/test/core-package-retirement-cases.mjs ; }\n` :
      'example.service disabled\n') });
  for (argument of [url, `'${url}'`, url.replace('core-', '%63ore-'),
    url.replace('file:///', 'file://localhost/'), url + '?mode=service#source']) {
    const report = await sweep(parent, {
      unused: candidate => requireNoPackageServices(candidate.path, run),
    });
    assert.equal(report[0].status, 'retained');
    assert.equal(report[0].code, 'PACKAGE_SERVICE_REFERENCE');
    assert.equal((await inspectRetirementPackage(parent, name())).path, path);
  }
  const other = await source(parent, 'unrelated');
  argument = pathToFileURL(other.path + '/src/example.mjs').href;
  await requireNoPackageServices(path, run);
  argument = pathToFileURL('/package space/src/example.mjs').href;
  await assert.rejects(requireNoPackageServices('/package space', run),
    { code: 'PACKAGE_SERVICE_REFERENCE' });
  argument = 'file:///package%ZZ/source.mjs';
  await assert.rejects(requireNoPackageServices(path, run),
    { code: 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE' });
});

test('typed success and pending results sanitize cleanup', () => {
  for (const status of ['complete', 'pending']) {
    const result = projectRolloutResult({ status, cleanup: [
      { package: name(), status: 'removed', code: 'PACKAGE_REMOVED', secret: 'private' },
      { package: '/private/path', status: 'retained', code: 'ACTIVE_APPLY' },
      { status: 'retained', code: 'PACKAGE_GATE_PENDING', secret: 'private' },
    ] });
    assert.deepEqual(result.cleanup, [
      { package: name(), status: 'removed', code: 'PACKAGE_REMOVED' },
      { status: 'retained', code: 'PACKAGE_GATE_PENDING' },
    ]);
  }
});

test('recovery follows oldPin independently of the backup suffix', async () => {
  const pin = commit => ({ repository: 'taco3064/nibfin-core',
    commit: commit.repeat(40), manifestHash: commit.repeat(64) });
  const oldPin = pin('a'), nextPin = pin('b');
  const live = '/opt/nibfin/core';
  const host = { installation: { directory: live, pin: nextPin } };
  const plan = { schemaVersion: 2, pin: nextPin, apply: { oldPin } };
  const backup = live + '-before-' + nextPin.commit;
  const selected = await selectAdoptedSource(oldPin, host, { live,
    readPlan: async () => plan,
    match: async (path, expected) => path === backup && expected === oldPin ?
      { path, source: oldPin } : null,
  });
  assert.equal(selected.path, backup);
});

test('unexpected replacement after response loss is retained without replay', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const candidate = await inspectRetirementPackage(parent, name());
  await assert.rejects(removeRetirementPackage(candidate, noop, {
    effect: async path => {
      await unlink(path);
      await writeFile(path, 'replacement');
      throw new Error('response lost');
    },
  }));
  const report = await sweep(parent);
  assert.equal(report[0].status, 'retained');
  assert.equal(report[0].code, 'PACKAGE_CONTENTS_CHANGED');
});

test('confirmed zombie exit differs from inaccessible evidence in a live process',
  async t => {
    const parent = await fixture(t), proc = join(parent, 'proc');
    const pid = join(proc, '12');
    await mkdir(pid, { recursive: true });
    // Exe, cwd and maps are absent, as for an exited, unreaped process.
    await writeFile(join(pid, 'stat'), '12 (exited worker) Z 1 0 0\n');
    await requireNoResourceReferences('/package', { proc, mounts: noop });
    await writeFile(join(pid, 'stat'), '12 (live worker) S 1 0 0\n');
    await assert.rejects(requireNoResourceReferences('/package', { proc, mounts: noop }),
      { code: 'ENOENT' });
  });

test('unknown deletion evidence is never treated as absent or overwritten', async t => {
  const parent = await fixture(t);
  await source(parent, name());
  const evidence = join(parent, retirementEvidenceName(name()));
  await writeFile(evidence, 'null');
  assert.equal((await sweep(parent))[0].code, 'PACKAGE_CONTENTS_UNKNOWN');
  assert.equal(await readFile(evidence, 'utf8'), 'null');
  await unlink(evidence);
  await symlink(join(parent, 'missing'), evidence);
  assert.equal((await sweep(parent))[0].code, 'PACKAGE_CONTENTS_UNKNOWN');
  const { readlink } = await import('node:fs/promises');
  assert.equal(await readlink(evidence), join(parent, 'missing'));
  await unlink(evidence);
  const candidate = await inspectRetirementPackage(parent, name());
  await assert.rejects(removeRetirementPackage(candidate, async () => {
    await writeFile(evidence, 'unknown injected evidence');
  }), { code: 'PACKAGE_IDENTITY_CHANGED' });
  assert.equal(await readFile(evidence, 'utf8'), 'unknown injected evidence');
});


test('relative service source resolves from effective working directory', async t => {
  const parent = await fixture(t);
  const { path } = await source(parent, name());
  const working = join(parent, 'service-work');
  await mkdir(working);
  const relative = `../${name()}/src/example.mjs`;
  let context = `WorkingDirectory=${working}\n`;
  let argument = relative;
  const run = async (_program, args) => ({ stdout: Buffer.from(
    args[0] === 'show' ? 'LoadState=loaded\nNeedDaemonReload=no\n' + context +
      `ExecStart={ argv[]=${process.execPath} ${argument} ; }\n` :
      'example.service disabled\n') });
  for (argument of [relative, `--import=${relative}`, `'${relative}'`]) {
    const report = await sweep(parent, {
      unused: candidate => requireNoPackageServices(candidate.path, run),
    });
    assert.equal(report[0].code, 'PACKAGE_SERVICE_REFERENCE');
    assert.equal((await inspectRetirementPackage(parent, name())).path, path);
  }
  argument = '../missing-source.mjs';
  await requireNoPackageServices(path, run);
  await writeFile(join(working, 'unrelated.mjs'), '');
  argument = 'unrelated.mjs';
  await requireNoPackageServices(path, run);
  for (context of ['WorkingDirectory=~\n']) {
    argument = relative;
    const report = await sweep(parent, {
      unused: candidate => requireNoPackageServices(candidate.path, run),
    });
    assert.equal(report[0].code, 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE');
    assert.equal((await inspectRetirementPackage(parent, name())).path, path);
  }
  context = `WorkingDirectory=${working}\nRootDirectory=/other-root\n`;
  await requireNoPackageServices(path, run);
});
