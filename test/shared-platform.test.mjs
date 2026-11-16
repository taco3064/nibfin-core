import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { platformContract, sharedPlatforms, sharedTarget, selectSharedPlatform,
  elfMachine, verifySharedExecutable, currentSharedPlatform }
  from '../src/shared-platform.mjs';
import { runnerReleaseArtifact, nodeManifestArtifact, verifySharedArchive,
  sharedArchiveMember }
  from '../src/shared-artifacts.mjs';
import { includesPackagePath } from '../src/source-package.mjs';
import { requireEngineAdministrator } from '../src/engine-host.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function elf(machine) {
  const bytes = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  return bytes;
}

for (const arch of ['amd64', 'arm64']) {
  test(`${arch}: finite artifact identities and native execution selection`, () => {
    const target = sharedTarget(arch);
    assert.equal(target.elfMachine, arch === 'amd64' ? 62 : 183);
    assert.equal(target.runnerArchive,
      `actions-runner-linux-${target.artifactArch}-2.338.2.tar.gz`);
    assert.equal(target.nodeArchive,
      `node-v24.22.1-linux-${target.artifactArch}.tar.xz`);
    for (const kernel of target.observations) {
      const observations = { platform: 'linux', kernel,
        runtime: target.artifactArch, executable: target.elfMachine,
        packageArch: arch, daemon: arch };
      assert.equal(selectSharedPlatform(observations).arch, arch);
      for (const field of ['runtime', 'packageArch', 'daemon']) {
        assert.throws(() => selectSharedPlatform({ ...observations,
          [field]: arch === 'amd64' ? 'arm64' : 'amd64' }),
        { code: 'SHARED_PLATFORM_MISMATCH' });
        assert.throws(() => selectSharedPlatform({ ...observations, [field]: 'riscv64' }),
          { code: 'SHARED_PLATFORM_MISMATCH' });
      }
      assert.throws(() => selectSharedPlatform({ ...observations,
        executable: arch === 'amd64' ? 183 : 62 }),
      { code: 'SHARED_PLATFORM_MISMATCH' });
    }
  });

  test(`${arch}: reviewed official release and checksum formats only`, () => {
    const target = sharedTarget(arch);
    const asset = { name: target.runnerArchive,
      digest: `sha256:${target.runnerArchiveSha256}`,
      browser_download_url: 'https://github.com/actions/runner/releases/download/' +
        `v2.338.2/${target.runnerArchive}` };
    const release = { tag_name: 'v2.338.2', assets: [asset] };
    assert.equal(runnerReleaseArtifact(release, arch).sha256,
      target.runnerArchiveSha256);
    for (const changed of [
      { ...release, tag_name: 'v2.338.1' }, { ...release, assets: [] },
      { ...release, assets: [asset, asset] },
      { ...release, assets: [{ ...asset, name: 'unreviewed.tar.gz' }] },
      { ...release, assets: [{ ...asset, digest: `sha256:${'a'.repeat(64)}` }] },
      { ...release, assets: [{ ...asset, browser_download_url: 'https://example.com' }] },
    ]) assert.throws(() => runnerReleaseArtifact(changed, arch),
      { code: 'INVALID_RUNNER_RELEASE' });
    const line = `${target.nodeArchiveSha256}  ${target.nodeArchive}`;
    assert.equal(nodeManifestArtifact(line + '\n', arch).sha256,
      target.nodeArchiveSha256);
    for (const manifest of ['', line + '\n' + line,
      line.replace('24.22.1', '24.22.0'), line.replace(/^[a-f0-9]{64}/, 'a'.repeat(64)),
      line.replace('  ', ' *'), line + '\nmalformed']) {
      assert.throws(() => nodeManifestArtifact(manifest, arch),
        { code: 'INVALID_NODE_MANIFEST' });
    }
  });

  test(`${arch}: digest agreement never replaces ELF architecture verification`, () => {
    const target = sharedTarget(arch);
    const bytes = elf(target.elfMachine);
    verifySharedExecutable(bytes, hash(bytes), target);
    assert.equal(elfMachine(bytes), target.elfMachine);
    const other = elf(arch === 'amd64' ? 183 : 62);
    assert.throws(() => verifySharedExecutable(other, hash(other), target),
      { code: 'SHARED_PLATFORM_MISMATCH' });
    assert.throws(() => verifySharedExecutable(bytes, 'a'.repeat(64), target),
      { code: 'SHARED_ARTIFACT_DIGEST_MISMATCH' });
    for (const offset of [0, 4, 5, 6, 16, 20]) {
      const changed = Buffer.from(bytes);
      changed[offset] = 0;
      assert.throws(() => elfMachine(changed), { code: 'INVALID_SHARED_EXECUTABLE' });
    }
    assert.throws(() => elfMachine(bytes.subarray(0, 63)),
      { code: 'INVALID_SHARED_EXECUTABLE' });
  });
}

test('unknown and incomplete package records fail closed', () => {
  for (const mutate of [
    value => { delete value.targets.arm64; },
    value => { value.targets.riscv64 = value.targets.arm64; },
    value => { delete value.targets.amd64.workerSha256; },
    value => { value.targets.arm64.nodeSha256 = ''; },
    value => { value.targets.arm64.observations.push('x64'); },
    value => { value.targets.amd64.unrecognized = true; },
  ]) {
    const value = structuredClone(sharedPlatforms);
    mutate(value);
    assert.throws(() => platformContract(value, '24.22.1'),
      { code: 'INVALID_SHARED_PLATFORM' });
  }
  assert.throws(() => platformContract(sharedPlatforms, '24.22.0'),
    { code: 'INVALID_SHARED_PLATFORM' });
  for (const arch of ['riscv64', 'x64', '', '__proto__']) {
    assert.throws(() => sharedTarget(arch), { code: 'UNSUPPORTED_SHARED_PLATFORM' });
  }
  assert.throws(() => selectSharedPlatform({ platform: 'darwin' }),
    { code: 'UNSUPPORTED_SHARED_PLATFORM' });
  assert.throws(() => selectSharedPlatform({ platform: 'linux', kernel: 'riscv64' }),
    { code: 'UNSUPPORTED_SHARED_PLATFORM' });
});

test('fresh and cached unreviewed archives are refused for both targets', async () => {
  const path = fileURLToPath(new URL(
    './fixtures/shared-platform/unreviewed-cache.txt', import.meta.url));
  for (const arch of ['amd64', 'arm64']) {
    for (const kind of ['runner', 'node']) {
      for (let use = 0; use < 2; use++) {
        await assert.rejects(verifySharedArchive(path, kind, arch),
          error => ['SHARED_ARTIFACT_DIGEST_MISMATCH', 'UNTRUSTED_ADOPTION_PATH']
            .includes(error.code));
      }
    }
  }
});

test('host selection ignores GOARCH and retains amd64 Engine admission', {
  skip: process.platform !== 'linux',
}, async () => {
  const before = process.env.GOARCH;
  try {
    const native = await currentSharedPlatform();
    process.env.GOARCH = native.arch === 'amd64' ? 'arm64' : 'amd64';
    assert.deepEqual(await currentSharedPlatform(), native);
  } finally {
    if (before === undefined) delete process.env.GOARCH;
    else process.env.GOARCH = before;
  }
  assert.throws(() => requireEngineAdministrator('linux', 'arm64', 0, true),
    { code: 'ENGINE_REQUIRES_LINUX_X64_ADMINISTRATOR' });
  requireEngineAdministrator('linux', 'x64', 0, true);
});

test('Python bootstrap validates both targets without executing fixture binaries', {
  skip: process.platform !== 'linux',
}, () => {
  const result = spawnSync('python3', ['-I', fileURLToPath(
    new URL('./shared-platform-probe.py', import.meta.url)), fileURLToPath(
    new URL('../src/security/shared-runtime.py', import.meta.url))],
  { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('fixed consumers are package members and preserve the existing x64 workflow',
  async () => {
    for (const path of ['src/shared-platform.json', 'src/security/shared-runtime.py',
      'bin/nibfin-shared-job', 'bin/nibfin-shared-start', 'bin/nibfin-controller']) {
      assert.ok(includesPackagePath(path));
    }
    const workflow = await readFile(new URL(
      '../.github/workflows/shared-runner.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes('node-v${version}-linux-x64/bin/node'));
    const target = sharedTarget('amd64');
    assert.equal(target.nodePath,
      '/opt/nibfin/tools/node-v24.22.1-linux-x64/bin/node');
  });

test('archive members allow dot prefixes and reject missing or duplicates', () => {
  const member = 'bin/Runner.Listener';
  assert.equal(sharedArchiveMember(`./${member}\n`, member), `./${member}`);
  assert.equal(sharedArchiveMember(`${member}\n`, member), member);
  for (const listing of ['', `${member}\n./${member}\n`, `../${member}\n`]) {
    assert.throws(() => sharedArchiveMember(listing, member),
      { code: 'INVALID_SHARED_ARCHIVE_MEMBERS' });
  }
});
