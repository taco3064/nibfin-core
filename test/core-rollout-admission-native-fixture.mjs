// Reuses the existing private mount/package fixture; never targets the real host.
import assert from 'node:assert/strict';
import { chmod, link, lstat, readFile, readdir, rm, symlink, writeFile }
  from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function inventory(root, prefix = '') {
  const entries = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    entries.push(path + (entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) entries.push(...await inventory(root, path));
  }
  return entries.sort();
}

export async function checkAdmissionAndFootprint(manager, pin, node) {
  const module = name => import(pathToFileURL(join(manager, 'src', name)).href);
  const { verifyInstalledSource } = await module('source-package.mjs');
  const { digest } = await module('identity.mjs');
  const { rootOwnedPath } = await module('host-paths.mjs');
  const { boundedHostFile } = await module('host-adoption.mjs');
  const { admitRolloutManager } = await module('rollout-manager-context.mjs');
  const { rolloutFailure, readRolloutProcessResult } =
    await module('core-rollout-result.mjs');
  const cli = join(manager, 'scripts/core-rollout-admin.py');
  await verifyInstalledSource(manager, pin);
  const before = await inventory(manager);
  // Production argv/env: no -B, no PYTHONDONTWRITEBYTECODE, no test import wrapper.
  const execution = spawnSync('/usr/bin/python3', [cli], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  assert.equal(execution.status, 2, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).status, 'pending');
  assert.deepEqual(await inventory(manager), before);
  await verifyInstalledSource(manager, pin);

  const publisher = pathToFileURL(join(manager, 'src/command-result.mjs')).href;
  const python = [
    'import importlib.util,json,subprocess,sys',
    `s=importlib.util.spec_from_file_location('r',${JSON.stringify(
      join(manager, 'scripts/core_rollout_result.py'))})`,
    'r=importlib.util.module_from_spec(s);s.loader.exec_module(r)',
    'p=subprocess.CompletedProcess([],int(sys.argv[1]),sys.stdin.buffer.read(),b"")',
    'v=r.read_result(p)',
    'print(json.dumps(r.failure_result(r.CoreRolloutFailure(v))))',
    'sys.exit(r.result_exit(v))',
  ].join(';');
  const denied = async (action, code) => {
    let failure;
    try { await action(); } catch (error) { failure = error; }
    assert.equal(failure?.code, code);
    const value = rolloutFailure(failure);
    assert.deepEqual(value, { status: 'denied', code });
    const script = `import {writeCommandResult} from ${JSON.stringify(publisher)};` +
      `writeCommandResult(${JSON.stringify(value)});`;
    const published = spawnSync(node, ['--input-type=module', '-e', script],
      { encoding: 'utf8' });
    assert.equal(published.status, 1, published.stderr);
    const carried = spawnSync('/usr/bin/python3', ['-B', '-c', python, '1'],
      { input: published.stdout, encoding: 'utf8' });
    assert.equal(carried.status, 1, carried.stderr);
    assert.deepEqual(readRolloutProcessResult(carried.stdout, carried.stderr,
      carried.status), value);
  };
  const alias = '/etc/nibfin/admission-link';
  await symlink(manager, alias);
  await denied(() => rootOwnedPath(alias), 'UNTRUSTED_ADOPTION_PATH');
  await rm(alias);
  const host = '/etc/nibfin/admission-host';
  await writeFile(host, '{}', { mode: 0o666 });
  await chmod(host, 0o666);
  await denied(() => boundedHostFile(host, 65536, true), 'UNTRUSTED_HOST_FILE');
  await rm(host);
  await denied(() => verifyInstalledSource(manager, { ...pin, commit: 'invalid' }),
    'INVALID_INSTALLATION_PIN');
  await denied(() => verifyInstalledSource(manager,
    { ...pin, manifestHash: 'f'.repeat(64) }),
    'SOURCE_MANIFEST_MISMATCH');
  const extra = join(manager, 'admission-extra');
  await symlink(join(manager, '.node-version'), extra);
  await denied(() => verifyInstalledSource(manager, pin), 'UNSAFE_INSTALLED_PATH');
  await rm(extra);
  await writeFile(extra, 'unknown');
  await denied(() => verifyInstalledSource(manager, pin),
    'INSTALLATION_FILE_SET_CHANGED');
  await rm(extra);
  const versionPath = join(manager, '.node-version');
  const hardAlias = join(dirname(manager), 'admission-hard-link');
  assert.equal((await lstat(versionPath)).nlink, 1);
  await link(versionPath, hardAlias);
  try {
    const actual = await lstat(versionPath), linked = await lstat(hardAlias);
    assert.equal(actual.nlink, 2);
    assert.equal(linked.dev, actual.dev);
    assert.equal(linked.ino, actual.ino);
    await denied(() => verifyInstalledSource(manager, pin), 'UNSAFE_INSTALLED_FILE');
  } finally { await rm(hardAlias); }
  assert.equal((await lstat(versionPath)).nlink, 1);
  assert.deepEqual(await inventory(manager), before);
  await verifyInstalledSource(manager, pin);
  const manifestPath = join(manager, 'nibfin-manifest.json');
  const saved = await readFile(manifestPath);
  const changed = { ...JSON.parse(saved), policyHash: 'f'.repeat(64) };
  await writeFile(manifestPath, JSON.stringify(changed));
  await denied(() => verifyInstalledSource(manager,
    { ...pin, manifestHash: digest(changed) }),
    'SOURCE_COMPONENT_HASH_MISMATCH');
  await writeFile(manifestPath, saved);
  await writeFile('/etc/nibfin/host.json', JSON.stringify({ installation: {
    directory: '/opt/nibfin/core', pin } }));
  const context = await admitRolloutManager();
  await denied(() => context.installationPath({ ...pin, commit: 'f'.repeat(40) }),
    'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH');
  await rm('/etc/nibfin/host.json');
  assert.deepEqual(await inventory(manager), before);
  await verifyInstalledSource(manager, pin);
}
