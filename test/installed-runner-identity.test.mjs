import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sharedTarget, verifySharedExecutable } from '../src/shared-platform.mjs';
import { deriveOfficialRunnerIdentity, installedRunnerIdentity,
  installedRunnerIdentityFile, legacyRunnerIdentity, officialRunnerArtifact }
  from '../src/installed-runner-identity.mjs';
import { readInstalledRunnerIdentity, ensureInstalledRunnerIdentity,
  publishInstalledRunnerIdentity } from '../src/installed-runner-state.mjs';

const local = { agentId: 42, agentName: 'slot-1',
  gitHubUrl: 'https://github.com/example/repository', workFolder: '_work' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

function elf(machine, marker) {
  const bytes = Buffer.alloc(80, marker);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  return bytes;
}

function release(arch, digest = 'a'.repeat(64)) {
  const name = `actions-runner-linux-${sharedTarget(arch).artifactArch}-9.99.0.tar.gz`;
  return { tag_name: 'v9.99.0', assets: [{ name, digest: `sha256:${digest}`,
    browser_download_url:
      `https://github.com/actions/runner/releases/download/v9.99.0/${name}` }] };
}

async function simulatedIdentity(arch = 'amd64') {
  const target = sharedTarget(arch);
  const bytes = [elf(target.elfMachine, 1), elf(target.elfMachine, 2)];
  let extracted = 0;
  const calls = [];
  const identity = await deriveOfficialRunnerIdentity('/verified/archive', release(arch),
    arch, local, { inspect: async path => calls.push(path),
      verify: async (...args) => calls.push(args),
      run: async (_path, args) => {
        calls.push(args);
        return { stdout: args[0] === '--list'
          ? Buffer.from('bin/Runner.Listener\nbin/Runner.Worker\n')
          : bytes[extracted++] };
      } });
  return { identity, target, bytes, calls };
}

test('verified archive produces installed facts for both architectures', async () => {
  for (const arch of ['amd64', 'arm64']) {
    const { identity, bytes, calls } = await simulatedIdentity(arch);
    assert.equal(identity.release, 'v9.99.0');
    assert.equal(identity.listenerSha256, sha(bytes[0]));
    assert.equal(identity.workerSha256, sha(bytes[1]));
    assert.equal(identity.arch, arch);
    assert.deepEqual(calls[0].slice(0, 2), ['/verified/archive', 'a'.repeat(64)]);
    assert.equal(calls[0][3], false);
    assert.equal(calls[1], '/usr/bin/tar');
  }
});

test('package authenticity, architecture and registration remain mandatory', async () => {
  const { identity, target } = await simulatedIdentity();
  for (const change of [
    value => { value.arch = 'arm64'; },
    value => { value.registration.id++; },
    value => { value.registration.url += '/other'; },
    value => { value.artifact.url = 'https://example.com/untrusted'; },
    value => { value.workerSha256 = ''; },
  ]) {
    const value = structuredClone(identity);
    change(value);
    assert.throws(() => installedRunnerIdentity(value, local, target));
  }
  const bad = release('amd64');
  bad.assets[0].digest = null;
  assert.throws(() => officialRunnerArtifact(bad, 'amd64'));
  let extracted = false;
  await assert.rejects(deriveOfficialRunnerIdentity('/archive', release('amd64'),
    'amd64', local, { verify: async () => { throw Error('digest mismatch'); },
      run: async () => { extracted = true; } }), /digest mismatch/);
  assert.equal(extracted, false);
});

test('startup consumes installed facts and rejects changed bytes', async () => {
  const { identity, target, bytes } = await simulatedIdentity();
  const options = { inspect: async () => {}, read: async () => JSON.stringify(identity),
    verify: async (path, digest, selected) => verifySharedExecutable(
      bytes[path.endsWith('.official') ? 1 : 0], digest, selected) };
  assert.deepEqual(await readInstalledRunnerIdentity('/slot', local, target, options),
    identity);
  bytes[1][79]++;
  await assert.rejects(readInstalledRunnerIdentity('/slot', local, target, options),
    { code: 'SHARED_ARTIFACT_DIGEST_MISMATCH' });
});

test('missing record permits only independent known bootstrap verification', async () => {
  const target = sharedTarget('amd64');
  const observed = [];
  const identity = await readInstalledRunnerIdentity('/legacy', local, target, {
    inspect: missing, verify: async (path, digest) => observed.push([path, digest]),
  });
  assert.deepEqual(identity, legacyRunnerIdentity(local, target));
  assert.deepEqual(observed.map(([, digest]) => digest),
    [target.listenerSha256, target.workerSha256]);
  await assert.rejects(readInstalledRunnerIdentity('/unknown', local, target, {
    inspect: missing, verify: async () => { throw Error('unknown bytes'); },
  }), /unknown bytes/);
  await assert.rejects(readInstalledRunnerIdentity('/unavailable', local, target, {
    inspect: async () => { throw Object.assign(Error('unavailable'), { code: 'EIO' }); },
  }), { code: 'EIO' });
});

const privileged = process.platform === 'linux' && process.getuid() === 0;
test('root installer publishes actual archive facts and reuses confirmed state', {
  skip: !privileged && 'requires Linux root-owned repository-local fixtures',
}, async () => {
  const base = resolve('.deliver-test-tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'installed-runner-'));
  try {
    const target = sharedTarget(process.arch === 'arm64' ? 'arm64' : 'amd64');
    const packageRoot = join(directory, 'package');
    const slot = join(directory, 'slot');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await mkdir(join(slot, 'bin'), { recursive: true });
    for (const [name, marker] of [['Runner.Listener', 1], ['Runner.Worker', 2]]) {
      const bytes = elf(target.elfMachine, marker);
      await writeFile(join(packageRoot, 'bin', name), bytes, { mode: 0o755 });
      const installed = name === 'Runner.Worker' ? name + '.official' : name;
      await writeFile(join(slot, 'bin', installed), bytes, { mode: 0o755 });
    }
    await writeFile(join(slot, '.runner'), JSON.stringify(local));
    const archive = join(directory, 'runner.tar.gz');
    const packed = spawnSync('/usr/bin/tar', ['--create', '--gzip', '--file', archive,
      '--directory', packageRoot, 'bin/Runner.Listener', 'bin/Runner.Worker']);
    assert.equal(packed.status, 0, packed.stderr.toString());
    const identity = await deriveOfficialRunnerIdentity(archive,
      release(target.arch, sha(await readFile(archive))), target.arch, local);
    await publishInstalledRunnerIdentity(slot, identity, target);
    const path = join(slot, installedRunnerIdentityFile);
    const before = await stat(path, { bigint: true });
    assert.deepEqual(await ensureInstalledRunnerIdentity(slot, local, target), identity);
    assert.equal((await stat(path, { bigint: true })).mtimeNs, before.mtimeNs);
    assert.deepEqual(await readInstalledRunnerIdentity(slot, local, target), identity);
    const probe = spawnSync('python3', ['-I', '-B',
      'test/installed-runner-probe.py', resolve('src/security/shared-runtime.py'), slot],
    { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    // Simulate an older bundled package contract using independently known
    // fixture bytes. This checks migration/recovery, not an official release.
    const bootstrap = { ...target, listenerSha256: identity.listenerSha256,
      workerSha256: identity.workerSha256,
      runnerArchiveSha256: identity.artifact.sha256 };
    await rm(path);
    const migrated = await ensureInstalledRunnerIdentity(slot, local, bootstrap);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), migrated);
    const stale = structuredClone(migrated);
    stale.registration.id++;
    await writeFile(path, JSON.stringify(stale));
    await assert.rejects(readInstalledRunnerIdentity(slot, local, bootstrap));
    assert.deepEqual(await ensureInstalledRunnerIdentity(slot, local, bootstrap),
      migrated);
    await writeFile(join(slot, 'bin', 'Runner.Worker.official'), Buffer.from('unknown'));
    await rm(path);
    await assert.rejects(ensureInstalledRunnerIdentity(slot, local, bootstrap));
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await writeFile(join(slot, 'bin', 'Runner.Worker.official'),
      elf(target.elfMachine, 2), { mode: 0o755 });
    await chmod(join(slot, 'bin', 'Runner.Worker.official'), 0o777);
    await assert.rejects(readInstalledRunnerIdentity(slot, local, bootstrap));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
