import test from 'node:test';
import assert from 'node:assert/strict';
import { reclaimManagedStorage, reclamationMounts, observeDiscardCapability }
  from '../src/storage-reclamation-host.mjs';
import { requestStorageReclamation, reportStorageReclamation }
  from '../src/storage-reclamation.mjs';
import { managedBase } from '../src/managed-credential-files.mjs';
import { engine } from '../src/engine-contract.mjs';

function fixture() {
  const calls = [], checked = [];
  const stat = { uid: 0, gid: 0, mode: 0o755, dev: 2049, rdev: 2049,
    isDirectory: () => true, isSymbolicLink: () => false,
    isBlockDevice: () => true };
  const io = {
    platform: () => 'linux', release: async () => 'Linux',
    controller: async () => 1001,
    diskGroup: async () => 6, capability: async () => true,
    mounts: async () => '24 1 8:1 / / rw - ext4 /dev/sda1 rw\n',
    realpath: async path => path,
    lstat: async path => ({ ...stat, uid: path === managedBase ? 1001 : 0,
      mode: path === managedBase && stat.mode === 0o755 ? 0o700 : stat.mode }),
    rootOwnedPath: async path => { checked.push(path); },
    run: async (path, args) => {
      calls.push([path, args]);
      return { stdout: Buffer.from('/: 0 B (0 bytes) trimmed\n') };
    },
  };
  return { io, calls, checked, stat };
}

test('managed roots deduplicate a filesystem and preserve zero bytes', async () => {
  const f = fixture();
  const result = await reclaimManagedStorage(f.io);
  assert.deepEqual(result, { platform: 'linux', status: 'success', attempted: true,
    filesystems: [{ status: 'success', attempted: true, bytes: 0,
      capability: 'supported', nativeDiscard: 'absent' }] });
  assert.deepEqual(f.calls, [['/usr/sbin/fstrim',
    ['--verbose', '--', '/']]]);
  assert(f.checked.includes('/dev'));
});

test('WSL records only the guest operation and strips uncontrolled output', async () => {
  const f = fixture();
  f.io.release = async () => '6.6.87.2-microsoft-standard-WSL2';
  f.io.run = async () => ({ stdout: Buffer.from('/: 123 B (123 bytes) trimmed secret') });
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.platform, 'wsl');
  assert.equal(result.filesystems[0].bytes, 123);
  assert(!JSON.stringify(result).includes('secret'));
});

test('native root:disk block nodes are eligible without accepting foreign writers',
  async () => {
    const f = fixture(), original = f.io.lstat;
    let group = 6;
    f.io.lstat = async path => path.startsWith('/dev/')
      ? { ...f.stat, gid: group, mode: 0o660 } : original(path);
    assert.equal((await reclaimManagedStorage(f.io)).status, 'success');
    group = 1001;
    assert.equal((await reclaimManagedStorage(f.io)).status, 'unknown');
    assert.equal(f.calls.length, 1);
  });

const unsupported = [
  ['read-only', f => { f.io.mounts = async () =>
    '24 1 8:1 / / ro - ext4 /dev/sda1 ro'; }],
  ['foreign filesystem', f => { f.io.mounts = async () =>
    '24 1 8:1 / / rw - overlay overlay rw'; }],
  ['bind mount', f => { f.io.mounts = async () =>
    '24 1 8:1 /foreign / rw - ext4 /dev/sda1 rw'; }],
  ['ambiguous device', f => { f.io.mounts = async () =>
    '24 1 8:1 / / rw - ext4 /dev/sda1 rw\n' +
    '25 1 8:1 / /other rw - ext4 /dev/sda1 rw'; }],
  ['overmounted target', f => { f.io.mounts = async () =>
    '24 1 8:1 / / rw - ext4 /dev/sda1 rw\n' +
    '25 1 8:2 / / rw - ext4 /dev/sda2 rw'; }],
  ['symlink root', f => { f.io.realpath = async path => path + '/redirect'; }],
  ['foreign owner', f => { f.stat.uid = 99;
    f.io.lstat = async () => f.stat; }],
  ['writable ancestor', f => { f.stat.mode = 0o777; }],
  ['device mismatch', f => { f.stat.dev = 2050; }],
  ['not block storage', f => { f.stat.isBlockDevice = () => false; }],
  ['foreign mount target', f => { f.io.rootOwnedPath = async () => {
    throw Error('foreign');
  }; }],
];
for (const [name, change] of unsupported) {
  test(`refuses ${name} without invoking discard`, async () => {
    const f = fixture();
    change(f);
    const result = await reclaimManagedStorage(f.io);
    const knownUnsupported = ['read-only', 'foreign filesystem', 'bind mount'];
    assert.equal(result.status, knownUnsupported.includes(name)
      ? 'unsupported' : 'unknown');
    assert.equal(result.attempted, false);
    assert.equal(f.calls.length, 0);
  });
}

test('Controller-owned root is eligible; root ownership there is not assumed',
  async () => {
    const f = fixture(), original = f.io.lstat;
    f.io.lstat = async path => ({ ...await original(path),
      uid: 0 });
    const result = await reclaimManagedStorage(f.io);
    assert.equal(result.filesystems[0].status, 'unknown');
    assert.equal(result.filesystems[1].status, 'success');
    assert.equal(f.calls.length, 1);
  });

test('separate eligible filesystems each receive one fixed invocation', async () => {
  const f = fixture(), original = f.io.lstat;
  f.io.mounts = async () => '24 1 8:1 / / rw - ext4 /dev/sda1 rw\n' +
    `25 1 8:2 / ${engine.data} rw - ext4 /dev/sda2 rw`;
  f.io.lstat = async path => ({ ...await original(path),
    dev: path === engine.data ? 2050 : 2049,
    rdev: path === '/dev/sda2' ? 2050 : 2049 });
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'success');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1][1], ['--verbose', '--', engine.data]);
});

test('unsupported platform and malformed mount data do not invoke tools', async () => {
  const f = fixture();
  f.io.platform = () => 'darwin';
  assert.equal((await reclaimManagedStorage(f.io)).platform, 'unsupported');
  f.io.platform = () => 'linux';
  f.io.mounts = async () => 'invalid';
  assert.equal((await reclaimManagedStorage(f.io)).status, 'unknown');
  assert.equal(f.calls.length, 0);
  assert.equal(reclamationMounts('24 1 8:1 / /space\\040name rw - ext4 /dev/a rw')[0]
    .target, '/space name');
});

test('missing tool differs from an observed invocation failure', async () => {
  const f = fixture(), original = f.io.rootOwnedPath;
  f.io.rootOwnedPath = async path => {
    if (path === '/usr/sbin/fstrim') throw Error('missing');
    return original(path);
  };
  assert.equal((await reclaimManagedStorage(f.io)).status, 'unavailable');
  assert.equal(f.calls.length, 0);
  f.io.rootOwnedPath = original;
  f.io.run = async () => {
    throw Object.assign(Error('sensitive stderr'), { code: 'PROCESS_FAILED' });
  };
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'failure');
  assert.equal(result.attempted, true);
  assert(!JSON.stringify(result).includes('sensitive'));
});

test('transport contains privilege failures and malformed helper output', async () => {
  for (const run of [async () => { throw Error('private'); },
    async () => ({ stdout: Buffer.from('private') }),
    async () => ({ stdout: Buffer.from(JSON.stringify({ status: 'success' })) })]) {
    assert.equal((await requestStorageReclamation(run)).status, 'unknown');
  }
  const observed = await reclaimManagedStorage(fixture().io);
  assert.deepEqual(await requestStorageReclamation(async () => ({
    stdout: Buffer.from(JSON.stringify({ ...observed, secret: 'private' })),
  })), observed);
  await reportStorageReclamation(async () => { throw Error('private'); });
});

test('effective native ext4 discard is reused without invoking fstrim', async () => {
  const f = fixture();
  f.io.mounts = async () => '24 1 8:1 / / rw - ext4 /dev/sda1 rw,discard';
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'native');
  assert.equal(result.attempted, false);
  assert.deepEqual(result.filesystems, [{ status: 'native', attempted: false,
    bytes: null, capability: 'supported', nativeDiscard: 'configured' }]);
  assert.equal(f.calls.length, 0);
});

test('configured discard alone does not prove a usable backing path', async () => {
  const f = fixture();
  f.io.mounts = async () => '24 1 8:1 / / rw,discard - ext4 /dev/sda1 rw';
  f.io.capability = async () => false;
  let result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.filesystems[0].nativeDiscard, 'configured');
  assert.equal(result.filesystems[0].capability, 'unsupported');
  f.io.capability = async () => { throw Error('unreadable sysfs'); };
  result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'unknown');
  assert.equal(result.filesystems[0].capability, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('failed reads and contradictory configuration remain unknown', async () => {
  for (const observation of ['release', 'controller', 'mounts', 'capability']) {
    const f = fixture();
    f.io[observation] = async () => { throw Error('observation failed'); };
    assert.equal((await reclaimManagedStorage(f.io)).status, 'unknown');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.io.mounts = async () => '24 1 8:1 / / rw,discard - ext4 /dev/sda1 rw,nodiscard';
  assert.equal((await reclaimManagedStorage(f.io)).status, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('lost process response differs from observed nonzero exit', async () => {
  const f = fixture();
  f.io.run = async () => {
    throw Object.assign(Error('response lost'), { code: 'PROCESS_TIMEOUT' });
  };
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.status, 'unknown');
  assert.equal(result.attempted, true);
});

test('native sysfs observation validates identity and inherits the partition queue',
  async () => {
    const disk = '/sys/devices/pci/block/sda', partition = disk + '/sda1';
    const checked = [], reads = [];
    let identity = '8:1', bytes = '4096', partitioned = true;
    const io = {
      realpath: async path => path.startsWith('/sys/dev/block/') ? partition : path,
      rootOwnedPath: async path => { checked.push(path); },
      readFile: async path => {
        reads.push(path);
        if (path.endsWith('/dev')) return identity;
        if (path.endsWith('/partition')) {
          if (partitioned) return '1';
          throw Object.assign(Error('not a partition'), { code: 'ENOENT' });
        }
        return bytes;
      },
    };
    assert.equal(await observeDiscardCapability('8:1', io), true);
    assert(checked.includes(disk + '/queue/discard_max_bytes'));
    bytes = '0';
    assert.equal(await observeDiscardCapability('8:1', io), false);
    partitioned = false;
    assert.equal(await observeDiscardCapability('8:1', io), false);
    assert(reads.includes(partition + '/queue/discard_max_bytes'));
    bytes = 'unreadable';
    await assert.rejects(observeDiscardCapability('8:1', io),
      { code: 'RECLAMATION_CAPABILITY_UNKNOWN' });
    identity = '8:2';
    await assert.rejects(observeDiscardCapability('8:1', io),
      { code: 'RECLAMATION_DEVICE_INVALID' });
    io.readFile = async () => { throw Error('read failed'); };
    await assert.rejects(observeDiscardCapability('8:1', io), /read failed/);
  });

test('missing helper response does not fabricate absence of an invocation', async () => {
  const result = await requestStorageReclamation(async () => {
    throw Object.assign(Error('response lost'), { code: 'PROCESS_TIMEOUT' });
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.attempted, null);
});

test('Controller-owned mount keeps its private ownership contract', async () => {
  const f = fixture();
  f.io.mounts = async () => '24 1 8:1 / / rw - ext4 /dev/sda1 rw\n' +
    `25 1 8:2 / ${managedBase} rw - ext4 /dev/sda2 rw,discard`;
  const original = f.io.lstat;
  f.io.lstat = async path => ({ ...await original(path),
    dev: path === managedBase ? 2050 : 2049,
    rdev: path === '/dev/sda2' ? 2050 : 2049 });
  const result = await reclaimManagedStorage(f.io);
  assert.equal(result.filesystems[0].status, 'native');
  assert(!f.checked.includes(managedBase));
  assert.equal(f.calls.length, 1);
  f.io.lstat = async path => ({ ...await original(path),
    mode: path === managedBase ? 0o755 : (await original(path)).mode });
  assert.equal((await reclaimManagedStorage(f.io)).filesystems[0].status, 'unknown');
});
