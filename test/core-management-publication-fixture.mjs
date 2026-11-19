import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile }
  from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installVerifiedRolloutManager } from '../src/core-manager-installation.mjs';
import { managerRecoveryPackages, cleanupManagerRecovery }
  from '../src/core-manager-recovery.mjs';
import { publishMaintenanceFile } from '../src/core-maintenance-files.mjs';
import { verifyOwnedSourcePackage } from '../src/owned-source-package.mjs';
import { inspectAdoptedSource } from '../src/adopted-source-path.mjs';

// Only called after the launcher mounted private /etc, /opt and /usr/local.
export async function checkManagementPublication(manager, oldPin, nodePath, manifest) {
  const base = dirname(manager);
  const runtime = { nodePath };
  const sources = [];
  const pins = [];
  for (const [index, marker] of ['B', 'C', 'D'].entries()) {
    const root = `/opt/nibfin/source-${marker}`;
    await cp(manager, root, { recursive: true });
    await writeFile(join(root, 'src/publication-fixture.mjs'),
      `export const fixture = '${marker}';\n`);
    sources.push(root);
    pins.push(await manifest(root, String(index + 2).repeat(40)));
  }
  const reset = async () => {
    for (const name of await readdir(base))
      if (name === 'manager' || name.startsWith('.previous-') ||
        ['source-pin.json', 'runtime.json'].includes(name))
        await rm(join(base, name), { recursive: true, force: true });
    await cp(sources[0], manager, { recursive: true });
    await writeFile(join(base, 'source-pin.json'), JSON.stringify(pins[0]));
    // Missing optional runtime publication exercises an actual pending write;
    // confirmed identical metadata must keep its zero-write reuse behavior.
  };
  const pinPath = join(base, 'source-pin.json');
  for (const metadata of [undefined, '{malformed', 'null', '[]', '{}',
    JSON.stringify(pins[2])]) {
    await reset();
    if (metadata === undefined) await rm(pinPath);
    else await writeFile(pinPath, metadata);
    await installVerifiedRolloutManager(sources[1], pins[1], runtime);
    await verifyOwnedSourcePackage(manager, pins[1]);
    const observed = await managerRecoveryPackages();
    assert.equal(observed.packages.length, 0);
    assert.equal(observed.retained.length, 1);
    const old = observed.retained[0];
    assert.deepEqual(await readdir(old), ['package']);
    assert.equal(await readFile(join(old, 'package/src/publication-fixture.mjs'),
      'utf8'), "export const fixture = 'B';\n");
    let writes = 0;
    await installVerifiedRolloutManager(sources[1], pins[1], runtime,
      { published: async () => { writes++; } });
    assert.equal(writes, 0);
  }
  await reset();
  await chmod(pinPath, 0o666);
  await assert.rejects(installVerifiedRolloutManager(sources[1], pins[1], runtime),
    { code: 'UNTRUSTED_ADOPTION_PATH' });
  await chmod(pinPath, 0o644);
  await rm(pinPath);
  const foreignPin = '/etc/nibfin/foreign-manager-pin.json';
  await writeFile(foreignPin, JSON.stringify(pins[0]));
  await symlink(foreignPin, pinPath);
  await assert.rejects(installVerifiedRolloutManager(sources[1], pins[1], runtime),
    { code: 'UNTRUSTED_ADOPTION_PATH' });
  await verifyOwnedSourcePackage(manager, pins[0]);
  assert.deepEqual(JSON.parse(await readFile(foreignPin)), pins[0]);
  for (const phase of ['prepared', 'previous', 'manager', 'pin', 'runtime']) {
    await reset();
    await assert.rejects(installVerifiedRolloutManager(sources[1], pins[1], runtime,
      { published: async observed => {
        if (observed === phase) throw new Error('fixture interruption');
      } }), /fixture interruption/);
    await installVerifiedRolloutManager(sources[2], pins[2], runtime);
    await verifyOwnedSourcePackage(manager, pins[2]);
    assert.deepEqual(JSON.parse(await readFile(join(base, 'source-pin.json'))), pins[2]);
    assert.deepEqual(JSON.parse(await readFile(join(base, 'runtime.json'))), runtime);
    let writes = 0;
    await installVerifiedRolloutManager(sources[2], pins[2], runtime,
      { published: async () => { writes++; } });
    assert.equal(writes, 0, 'Confirmed publication reuses bytes and metadata');
  }
  await reset();
  const entry = join(base, 'client.py');
  const bytes = index => readFile(join(sources[index], 'src/publication-fixture.mjs'));
  await publishMaintenanceFile(entry, await bytes(0), [], 0o755);
  await installVerifiedRolloutManager(sources[1], pins[1], runtime);
  // Interrupted C published one entry; D can recognize both B and C directly.
  await publishMaintenanceFile(entry, await bytes(1), [await bytes(0)], 0o755);
  await installVerifiedRolloutManager(sources[2], pins[2], runtime);
  const recovery = await managerRecoveryPackages();
  assert.equal(recovery.packages.length, 2);
  await publishMaintenanceFile(entry, await bytes(2),
    await Promise.all(recovery.packages.map(pair =>
      readFile(join(pair.root, 'src/publication-fixture.mjs')))), 0o755);
  assert.deepEqual(await readFile(entry), await bytes(2));
  assert.deepEqual(await cleanupManagerRecovery(recovery.packages), []);
  await mkdir(join(base, '.previous-unknown'));
  await writeFile(join(base, '.previous-unknown/foreign'), 'retain');
  await installVerifiedRolloutManager(sources[2], pins[2], runtime);
  assert.equal((await managerRecoveryPackages()).retained.length, 1);
  await writeFile(entry, 'foreign user content');
  await assert.rejects(publishMaintenanceFile(entry, await bytes(2), [], 0o755),
    { code: 'CORE_MAINTENANCE_RESOURCE_UNKNOWN' });
  assert.equal(await readFile(entry, 'utf8'), 'foreign user content');

  const live = '/opt/nibfin/core';
  await cp(sources[2], live, { recursive: true });
  await writeFile('/etc/nibfin/host.json', JSON.stringify({
    installation: { directory: live, pin: pins[2] },
  }));
  await writeFile('/etc/nibfin/rollout-plan.json', '{stale invalid plan');
  assert.equal((await inspectAdoptedSource(pins[2])).path, live);
  await rm(live, { recursive: true });
  await assert.rejects(inspectAdoptedSource(pins[2]), SyntaxError);
  const staged = `/opt/nibfin/core-staged-${pins[2].commit}`;
  await cp(sources[2], staged, { recursive: true });
  await writeFile('/etc/nibfin/rollout-plan.json', JSON.stringify({
    schemaVersion: 2, pin: pins[2], apply: { oldPin },
  }));
  assert.equal((await inspectAdoptedSource(pins[2])).path, staged);
  await writeFile(join(staged, 'src/publication-fixture.mjs'), 'changed source');
  await assert.rejects(inspectAdoptedSource(pins[2]),
    { code: 'INSTALLED_SOURCE_CHANGED' });
}
