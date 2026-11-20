import test from 'node:test';
import assert from 'node:assert/strict';
import { installStorageReclamation, reclamationPolicy }
  from '../src/storage-reclamation-install.mjs';
import { reclamationProgram } from '../src/storage-reclamation.mjs';
import { managedResourceHost } from '../src/managed-resource-host.mjs';
import { managedPaths } from '../src/managed-credential-files.mjs';
import { spawnSync } from 'node:child_process';

function fixture() {
  const files = new Map(), calls = [];
  const target = '/etc/sudoers.d/nibfin-storage-reclamation';
  let loseReply = false;
  const io = {
    rootOwnedPath: async path => { calls.push(['owned', path]); },
    installEngineFile: async (path, bytes, mode) => {
      assert.equal(mode, 0o440);
      if (files.has(path)) assert.equal(files.get(path), bytes);
      files.set(path, bytes);
      calls.push(['install', path]);
      if (path === target && loseReply) {
        loseReply = false;
        throw Error('reply lost');
      }
    },
    exactFile: async (path, bytes, mode) => {
      assert.equal(files.get(path), bytes);
      assert.equal(mode, 0o440);
      calls.push(['readback', path]);
    },
    unlink: async path => { files.delete(path); },
    syncRecoveryDirectory: async () => {},
    run: async (path, args) => { calls.push([path, args]); },
  };
  return { io, files, calls, target, loseReply: () => { loseReply = true; } };
}

test('policy grants only Controller the fixed root command with no arguments',
  async () => {
    const f = fixture();
    await installStorageReclamation(f.io);
    assert.equal(reclamationPolicy,
      `nibfin-controller ALL=(root) NOPASSWD: ${reclamationProgram} ""\n`);
    assert.deepEqual([...f.files], [[f.target, reclamationPolicy]]);
    const publication = f.calls.findIndex(call => call[0] === 'install' &&
      call[1] === f.target);
    assert(f.calls.slice(0, publication).some(call => call[0] === '/usr/sbin/visudo'));
    assert.deepEqual(f.calls.at(-1), ['/usr/sbin/runuser', [
      '-u', 'nibfin-controller', '--', '/usr/bin/sudo', '-n', '-l', '-u', 'root',
      '--', reclamationProgram,
    ]]);
    await installStorageReclamation(f.io);
    assert.deepEqual([...f.files], [[f.target, reclamationPolicy]]);
  });

test('publication response loss reuses matching policy on normal retry', async () => {
  const f = fixture();
  f.loseReply();
  await assert.rejects(installStorageReclamation(f.io), /reply lost/);
  assert.deepEqual([...f.files], [[f.target, reclamationPolicy]]);
  await installStorageReclamation(f.io);
  assert.deepEqual([...f.files], [[f.target, reclamationPolicy]]);
});

test('foreign policy and failed validation never become successful preparation',
  async () => {
    const f = fixture();
    f.files.set(f.target, 'foreign');
    await assert.rejects(installStorageReclamation(f.io));
    assert.equal(f.files.get(f.target), 'foreign');
    const invalid = fixture();
    invalid.io.run = async () => { throw Error('visudo rejected'); };
    await assert.rejects(installStorageReclamation(invalid.io), /visudo rejected/);
    assert.equal(invalid.files.size, 0);
  });

test('managed Controller preparation reconciles permission on every completion',
  async () => {
    const calls = [];
    const io = managedResourceHost(async () => {}, {}, {
      prepareController: async (paths, options) => {
        assert.deepEqual(paths, managedPaths);
        assert.deepEqual(options, { preparation: true });
        calls.push('accounts');
      },
      installReclamation: async () => { calls.push('permission'); },
    });
    await io.controller();
    await io.controller();
    assert.deepEqual(calls, ['accounts', 'permission', 'accounts', 'permission']);
  });

test('promoted completion reconciles permission even after an older apply', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    'test/storage-reclamation-rollout-fixture.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Controlled rollout completion and retry passed/);
});

test('optional permission failure preserves managed Controller preparation', async () => {
  let prepared = false;
  const io = managedResourceHost(async () => {}, {}, {
    prepareController: async () => { prepared = true; },
    installReclamation: async () => { throw Error('missing visudo'); },
  });
  await io.controller();
  assert.equal(prepared, true);
});
