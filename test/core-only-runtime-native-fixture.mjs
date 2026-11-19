// Source/runtime validation only; synthetic Runner bytes are never executed.
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkCoreOnlyRuntime(module, context, host, binding, manifest) {
  const { currentPoolRuntime, prepareCoreOnlyRunnerIdentity } =
    await module('core-only-runtime.mjs');
  const { sharedTargetFromContract, sharedPlatforms } =
    await module('shared-platform.mjs');
  const { sha256 } = await module('identity.mjs');
  const live = context.installationRoot;
  const sourcePath = join(live, 'src/shared-platform.json');
  const manifestPath = join(live, 'nibfin-manifest.json');
  const versionPath = join(live, '.node-version');
  const paths = [sourcePath, manifestPath, '/etc/nibfin/host.json', versionPath];
  const saved = await Promise.all(paths.map(path => readFile(path)));
  const platform = JSON.parse(saved[0]);
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const executable = marker => {
    const bytes = Buffer.alloc(64);
    Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(platform.targets[arch].elfMachine, 18);
    bytes.writeUInt32LE(1, 20);
    bytes[63] = marker;
    return bytes;
  };
  const listener = executable(1), worker = executable(2);
  const managerTarget = sharedTargetFromContract(platform, arch);
  const actualNodeBytes = await readFile(managerTarget.nodePath);
  // The copied ELF proves validation/path selection, not execution of v24.0.0.
  platform.nodeVersion = '24.0.0';
  platform.runnerVersion = '2.300.0';
  Object.assign(platform.targets[arch], { listenerSha256: sha256(listener),
    workerSha256: sha256(worker) });
  assert.notEqual(platform.runnerVersion, sharedPlatforms.runnerVersion);
  const target = sharedTargetFromContract(platform, arch);
  try {
    await mkdir(join(target.nodePath, '..'), { recursive: true });
    await writeFile(target.nodePath, actualNodeBytes, { mode: 0o755 });
    await writeFile(versionPath, platform.nodeVersion + '\n');
    await writeFile(sourcePath, JSON.stringify(platform));
    const pin = await manifest(live, 'b'.repeat(40));
    const current = structuredClone(host);
    current.installation.pin = pin;
    await writeFile('/etc/nibfin/host.json', JSON.stringify(current));
    for (const slot of binding.slots) {
      await mkdir(join(slot.path, 'bin'), { recursive: true });
      await writeFile(join(slot.path, '.runner'), JSON.stringify({
        agentId: slot.runner.id, agentName: slot.runner.name,
        gitHubUrl: `https://github.com/${binding.pool.repository}`, workFolder: '_work',
      }));
      await writeFile(join(slot.path, 'bin/Runner.Listener'), listener, { mode: 0o755 });
      await writeFile(join(slot.path, 'bin/Runner.Worker.official'), worker,
        { mode: 0o755 });
    }
    const runtime = await currentPoolRuntime(context);
    assert.equal(runtime.bootstrapVersion, '2.300.0');
    assert.equal(runtime.target.nodePath, target.nodePath);
    assert.notEqual(runtime.target.nodeVersion, process.version.slice(1));
    const registrations = await Promise.all(binding.slots.map(slot =>
      readFile(join(slot.path, '.runner'))));
    await prepareCoreOnlyRunnerIdentity(binding, runtime, { inspectOnly: true });
    for (const slot of binding.slots)
      await assert.rejects(stat(join(slot.path, '.nibfin-runner-identity.json')),
        { code: 'ENOENT' });
    await prepareCoreOnlyRunnerIdentity(binding, runtime);
    const records = await Promise.all(binding.slots.map(slot =>
      readFile(join(slot.path, '.nibfin-runner-identity.json'), 'utf8')));
    assert.ok(records.every(bytes => JSON.parse(bytes).release === 'v2.300.0'));
    const times = await Promise.all(binding.slots.map(slot =>
      stat(join(slot.path, '.nibfin-runner-identity.json'), { bigint: true })));
    await prepareCoreOnlyRunnerIdentity(binding, runtime);
    const again = await Promise.all(binding.slots.map(slot =>
      stat(join(slot.path, '.nibfin-runner-identity.json'), { bigint: true })));
    assert.deepEqual(again.map(value => value.mtimeNs),
      times.map(value => value.mtimeNs));
    assert.deepEqual(await Promise.all(binding.slots.map(slot =>
      readFile(join(slot.path, '.runner')))), registrations);
    // A candidate's changed bootstrap table cannot invalidate confirmed identity.
    const other = structuredClone(platform);
    other.runnerVersion = '2.301.0';
    other.targets[arch].listenerSha256 = 'f'.repeat(64);
    await prepareCoreOnlyRunnerIdentity(binding, { ...runtime,
      target: sharedTargetFromContract(other, arch),
      bootstrapVersion: other.runnerVersion });
    assert.deepEqual(await Promise.all(binding.slots.map(slot =>
      readFile(join(slot.path, '.nibfin-runner-identity.json'), 'utf8'))), records);
    const first = binding.slots[0].path;
    await rm(join(first, '.nibfin-runner-identity.json'));
    await writeFile(join(first, 'bin/Runner.Listener'), executable(9));
    await assert.rejects(prepareCoreOnlyRunnerIdentity(binding, runtime),
      { code: 'SHARED_ARTIFACT_DIGEST_MISMATCH' });
    await assert.rejects(stat(join(first, '.nibfin-runner-identity.json')),
      { code: 'ENOENT' });
    await writeFile(join(first, 'bin/Runner.Listener'), listener);
    const next = 'c'.repeat(40), backup = `/opt/nibfin/core-before-${next}`;
    await writeFile('/etc/nibfin/rollout-plan.json', JSON.stringify({
      pin: { commit: next }, apply: { oldPin: pin } }));
    await rename(live, backup);
    try {
      assert.equal((await currentPoolRuntime(context)).directory, backup);
    } finally { await rename(backup, live); }
    await rm('/etc/nibfin/rollout-plan.json');
    const sourceBytes = await readFile(sourcePath);
    await writeFile(sourcePath, '{}');
    await assert.rejects(currentPoolRuntime(context),
      { code: 'INSTALLED_SOURCE_CHANGED' });
    await writeFile(sourcePath, sourceBytes);
    const nodeBytes = await readFile(target.nodePath);
    try {
      await writeFile(target.nodePath, executable(8));
      await assert.rejects(currentPoolRuntime(context),
        { code: 'SHARED_ARTIFACT_DIGEST_MISMATCH' });
    } finally { await writeFile(target.nodePath, nodeBytes); }
    await assert.rejects(currentPoolRuntime({ installationRoot: live }),
      { code: 'ROLLOUT_MANAGER_NOT_ADMITTED' });
  } finally {
    for (const [index, path] of paths.entries())
      await writeFile(path, saved[index]);
    await rm('/etc/nibfin/rollout-plan.json', { force: true });
    for (const slot of binding.slots)
      await rm(slot.path, { recursive: true, force: true });
    await rm(join(target.nodePath, '../..'), { recursive: true, force: true });
  }
}
