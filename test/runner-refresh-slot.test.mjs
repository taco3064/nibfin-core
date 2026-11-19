import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command } from '../src/process.mjs';
import { sharedTarget } from '../src/shared-platform.mjs';
import { deriveOfficialRunnerIdentity } from '../src/installed-runner-identity.mjs';
import { publishInstalledRunnerIdentity } from '../src/installed-runner-state.mjs';
import { prepareRunnerSlot, applyRunnerSlot, verifyRefreshedSlot }
  from '../src/runner-refresh-slot.mjs';
import { resumeRunnerSlot, finalizeRunnerSlot } from '../src/runner-refresh-slot.mjs';
import { downloadRunnerRefresh } from '../src/runner-refresh-discovery.mjs';
import { GitHubReader } from '../src/github-read.mjs';
import { refreshRunnerRuntime, runnerRefreshObservation }
  from '../src/runner-refresh.mjs';
import { fixture as flowFixture } from './runner-refresh-fixture.mjs';

const supported = process.platform === 'linux' && process.getuid?.() === 0;
const options = { skip: !supported && 'requires an eligible Linux root-owned fixture' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function executable(target, marker) {
  const bytes = Buffer.alloc(80, marker);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(target.elfMachine, 18);
  bytes.writeUInt32LE(1, 20);
  return bytes;
}

async function packageFixture(root, target, version, marker) {
  const payload = join(root, `payload-${version}`);
  await mkdir(join(payload, 'bin'), { recursive: true, mode: 0o755 });
  await mkdir(join(payload, 'externals'), { mode: 0o755 });
  for (const [index, name] of ['Runner.Listener', 'Runner.Worker'].entries()) {
    const path = join(payload, 'bin', name);
    await writeFile(path, executable(target, marker + index), { mode: 0o755 });
    await chmod(path, 0o755);
  }
  await writeFile(join(payload, 'externals/support'), `support-${version}`);
  await writeFile(join(payload, 'run.sh'), `#!/bin/sh\n# ${version}\n`, { mode: 0o755 });
  await chmod(join(payload, 'run.sh'), 0o755);
  const archive = join(root, `runner-${version}.tar.gz`);
  await command('/usr/bin/tar', ['--create', '--gzip', '--file', archive,
    '--directory', payload, '.'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const name = `actions-runner-linux-${target.artifactArch}-${version}.tar.gz`;
  const artifact = { name, sha256: sha(await readFile(archive)),
    url: `https://github.com/actions/runner/releases/download/v${version}/${name}` };
  const release = { tag_name: `v${version}`, draft: false, assets: [{ name,
    digest: `sha256:${artifact.sha256}`, browser_download_url: artifact.url }] };
  return { archive, payload, selected: { arch: target.arch, release, artifact } };
}

async function fixture(t) {
  const parent = resolve('.deliver-test-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'runner-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = sharedTarget(process.arch === 'arm64' ? 'arm64' : 'amd64');
  const old = await packageFixture(root, target, '9.98.0', 1);
  const next = await packageFixture(root, target, '9.99.0', 3);
  const slots = [];
  for (const slot of [1, 2]) {
    const directory = join(root, `slot-${slot}`);
    await cp(old.payload, directory, { recursive: true });
    const local = { agentId: 40 + slot, agentName: `slot-${slot}`,
      gitHubUrl: 'https://github.com/example/repository', workFolder: '_work' };
    await writeFile(join(directory, '.runner'), JSON.stringify(local), { mode: 0o640 });
    await writeFile(join(directory, '.credentials'), 'private-fixture', { mode: 0o640 });
    await mkdir(join(directory, '_work'), { mode: 0o700 });
    await rename(join(directory, 'bin/Runner.Worker'),
      join(directory, 'bin/Runner.Worker.official'));
    await writeFile(join(directory, 'bin/Runner.Worker'), await readFile(
      new URL('../src/security/shared-worker-dispatcher.sh', import.meta.url)),
    { mode: 0o755 });
    const oldIdentity = await deriveOfficialRunnerIdentity(old.archive,
      old.selected.release, target.arch, local);
    await publishInstalledRunnerIdentity(directory, oldIdentity, target);
    const runner = { id: local.agentId, name: local.agentName };
    const scratch = join(root, `scratch-${slot}`);
    const intent = await prepareRunnerSlot(directory, scratch, next.archive,
      next.selected, runner, 'example/repository', target);
    slots.push({ directory, scratch, intent, runner });
  }
  return { target, slots, next, root };
}

test('real filesystem transition preserves both registrations/private state', options,
  async t => {
    const { target, slots } = await fixture(t);
    for (const slot of slots) {
      const settings = ['.runner', '.credentials', '_work'];
      const before = await Promise.all(settings.map(async name => {
        const stat = await lstat(join(slot.directory, name));
        return { ino: stat.ino, dev: stat.dev, mode: stat.mode };
      }));
      await applyRunnerSlot(slot.directory, slot.scratch, slot.intent, target);
      await verifyRefreshedSlot(slot.directory, slot.intent, slot.runner,
        'example/repository', target);
      const metadata = join(slot.directory, '.nibfin-runner-identity.json');
      const identityStat = await lstat(metadata);
      await applyRunnerSlot(slot.directory, slot.scratch, slot.intent, target);
      assert.equal((await lstat(metadata)).ino, identityStat.ino,
        'confirmed metadata publication must not be repeated');
      for (const [index, name] of settings.entries()) {
        const stat = await lstat(join(slot.directory, name));
        assert.deepEqual({ ino: stat.ino, dev: stat.dev, mode: stat.mode },
          before[index]);
      }
      assert.equal(await readFile(join(slot.directory, '.credentials'), 'utf8'),
        'private-fixture');
      assert.equal(await readFile(join(slot.directory, 'bin/Runner.Worker'), 'utf8'),
        await readFile(new URL('../src/security/shared-worker-dispatcher.sh',
          import.meta.url), 'utf8'));
    }
  });

for (const failAfter of [1, 2, 3, 4]) {
  test(`filesystem rename response loss ${failAfter} resumes from actual bytes`, options,
    async t => {
      const { target, slots: [slot] } = await fixture(t);
      let moves = 0;
      await assert.rejects(applyRunnerSlot(slot.directory, slot.scratch, slot.intent,
        target, { move: async (from, to) => {
          await rename(from, to);
          if (++moves === failAfter) throw Error('response lost after rename');
        } }), /response lost/);
      await applyRunnerSlot(slot.directory, slot.scratch,
        JSON.parse(JSON.stringify(slot.intent)), target);
      await verifyRefreshedSlot(slot.directory, slot.intent, slot.runner,
        'example/repository', target);
    });
}

test('unknown changed live bytes retain original and staged recovery material', options,
  async t => {
    const { target, slots: [slot] } = await fixture(t);
    await writeFile(join(slot.directory, 'run.sh'), 'unexpected modification');
    await assert.rejects(applyRunnerSlot(slot.directory, slot.scratch,
      slot.intent, target),
      { code: 'RUNNER_REFRESH_READBACK_UNKNOWN' });
    assert.equal(await readFile(join(slot.directory, 'run.sh'), 'utf8'),
      'unexpected modification');
    assert((await lstat(join(slot.intent.staged, 'run.sh'))).isFile());
  });

test('missing disposable staging is reconstructed from the verified selected package',
  options, async t => {
    const { target, slots: [slot], next } = await fixture(t);
    await rm(slot.intent.staged, { recursive: true });
    await resumeRunnerSlot(slot.directory, slot.scratch, next.archive, next.selected,
      slot.intent, slot.runner, 'example/repository', target);
    await verifyRefreshedSlot(slot.directory, slot.intent, slot.runner,
      'example/repository', target);
  });

test('public download keeps credentials private and reuses verified bytes', options,
  async t => {
    const { root, next } = await fixture(t);
    const path = join(root, 'downloaded.tar.gz');
    let downloads = 0;
    const fetcher = async (url, request) => {
      downloads++;
      assert.equal(url, next.selected.artifact.url);
      assert.equal(request.headers, undefined);
      return { ok: true, body: [await readFile(next.archive)] };
    };
    const completed = await downloadRunnerRefresh(next.selected, path, fetcher);
    const before = await lstat(completed);
    assert.equal(await downloadRunnerRefresh(next.selected, path, fetcher), completed);
    assert.equal(downloads, 1);
    assert.equal((await lstat(completed)).ino, before.ino);
    await writeFile(completed, 'unknown changed cache');
    const repaired = await downloadRunnerRefresh(next.selected, path, fetcher);
    assert.equal(downloads, 2);
    assert.notEqual(repaired, completed);
    assert.equal(await readFile(completed, 'utf8'), 'unknown changed cache');
    assert.deepEqual(await readFile(repaired), await readFile(next.archive));
  });

test('registration mismatch refuses file replacement before its first write', options,
  async t => {
    const { target, slots: [slot] } = await fixture(t);
    const listener = join(slot.directory, 'bin/Runner.Listener');
    const before = await lstat(listener);
    await writeFile(join(slot.directory, '.runner'), JSON.stringify({ agentId: 999 }));
    await assert.rejects(applyRunnerSlot(slot.directory, slot.scratch,
      slot.intent, target),
      { code: 'SHARED_RUNNER_REGISTRATION_MISMATCH' });
    assert.equal((await lstat(listener)).ino, before.ino);
  });

for (const differentAsset of [false, true]) {
  test(`fresh workspace tolerates old unknown prior; different asset: ${differentAsset}`,
    options, async t => {
      const { target, root, slots: [slot], next } = await fixture(t);
      await applyRunnerSlot(slot.directory, slot.scratch, slot.intent, target);
      const prior = join(slot.scratch, 'previous', 'run.sh');
      await writeFile(prior, 'unknown retained old material');
      const selected = differentAsset
        ? await packageFixture(root, target, '9.100.0', 5) : next;
      const fresh = join(root, 'new-private-operation');
      const intent = await prepareRunnerSlot(slot.directory, fresh, selected.archive,
        selected.selected, slot.runner, 'example/repository', target);
      await applyRunnerSlot(slot.directory, fresh, intent, target);
      await verifyRefreshedSlot(slot.directory, intent, slot.runner,
        'example/repository', target);
      assert.equal(await readFile(prior, 'utf8'), 'unknown retained old material');
    });
}

test('confirmed files repair metadata without old staging or archive', options,
  async t => {
    const { target, slots: [slot] } = await fixture(t);
    await applyRunnerSlot(slot.directory, slot.scratch, slot.intent, target);
    const listener = join(slot.directory, 'bin/Runner.Listener');
    const before = await lstat(listener);
    const metadata = join(slot.directory, '.nibfin-runner-identity.json');
    await rm(metadata);
    await rm(slot.scratch, { recursive: true });
    assert.equal(await finalizeRunnerSlot(slot.directory, slot.intent, slot.runner,
      'example/repository', target), true);
    assert.equal((await lstat(listener)).ino, before.ino);
    await verifyRefreshedSlot(slot.directory, slot.intent, slot.runner,
      'example/repository', target);
  });

test('staging reconstruction preserves unknown files in the old extraction', options,
  async t => {
    const { target, slots: [slot], next } = await fixture(t);
    const old = slot.intent.staged;
    await writeFile(join(old, 'foreign'), 'unrelated retained content');
    await rm(join(old, 'run.sh'));
    await resumeRunnerSlot(slot.directory, slot.scratch, next.archive, next.selected,
      slot.intent, slot.runner, 'example/repository', target);
    assert.notEqual(slot.intent.staged, old);
    assert.equal(await readFile(join(old, 'foreign'), 'utf8'),
      'unrelated retained content');
    await verifyRefreshedSlot(slot.directory, slot.intent, slot.runner,
      'example/repository', target);
  });

for (const cause of [422, 'network', 'invalid-response']) {
  test(`installed inodes are reused after a GitHub read failure: ${cause}`, options,
    async t => {
      const { target, slots, next } = await fixture(t);
      const f = flowFixture();
      let fail = true;
      const reader = new GitHubReader('private-fixture', async () => {
        if (fail) {
          fail = false;
          if (cause === 'network') throw new TypeError('private-fixture');
          return new Response('private-fixture',
            { status: cause === 'invalid-response' ? 200 : cause });
        }
        return Response.json({ id: 7, type: 'User' });
      });
      f.ports.discover = async () => next.selected;
      f.ports.install = async number => {
        const slot = slots[number - 1];
        if (!await finalizeRunnerSlot(slot.directory, slot.intent, slot.runner,
          'example/repository', target))
          await applyRunnerSlot(slot.directory, slot.scratch, slot.intent, target);
        f.installed.add(number);
      };
      f.ports.verify = async () => {
        for (const slot of slots) await verifyRefreshedSlot(slot.directory,
          slot.intent, slot.runner, 'example/repository', target);
        await reader.get('/user');
      };
      const run = () => runnerRefreshObservation(() =>
        refreshRunnerRuntime('resume', f.ports));
      const pending = await run();
      assert.equal(pending.code, 'GITHUB_API_RETRY_PENDING');
      assert.equal(pending.phase, 'applying');
      const paths = slots.flatMap(slot => ['.runner', '.credentials',
        '.nibfin-runner-identity.json', 'bin/Runner.Listener',
        'bin/Runner.Worker', 'bin/Runner.Worker.official']
        .map(path => join(slot.directory, path)));
      const before = await Promise.all(paths.map(path => lstat(path)));
      assert.equal((await run()).status, 'refreshed');
      for (const [index, path] of paths.entries()) {
        const after = await lstat(path);
        assert.equal(after.ino, before[index].ino, path);
        assert.equal(after.mtimeMs, before[index].mtimeMs, path);
      }
    });
}
