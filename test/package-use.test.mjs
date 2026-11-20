import test from 'node:test';
import assert from 'node:assert/strict';
import { observePackageUse, packageMountUse, packageMountOrigin }
  from '../src/package-use.mjs';

const candidate = '/opt/nibfin/core-before-abc';
const baseMount = '1 0 8:1 / / rw - ext4 /dev/sda rw\n';
const stat = (start = '100') => '12 (name with spaces) S ' +
  [...Array(18).fill('0'), start, '0'].join(' ');
const failure = code => { throw Object.assign(new Error('private detail'), { code }); };

function procFixture() {
  const values = new Map([
    ['/proc/self/mountinfo', baseMount], ['/proc/12/mountinfo', baseMount],
    ['/proc/12/stat', stat()], ['/proc/12/cmdline', '/usr/bin/node\0script.mjs\0'],
    ['/proc/12/maps', ''], ['/proc/12/root', '/'], ['/proc/12/cwd', '/srv'],
    ['/proc/12/exe', '/usr/bin/node'], ['/proc/12/ns/mnt', 'mnt:[1]'],
    ['/proc/12/fd/1', '/dev/null'],
  ]);
  const ports = {
    read: async path => {
      const value = values.get(path);
      return typeof value === 'function' ? value() : value ?? failure('ENOENT');
    },
    link: async path => ports.read(path),
    canonical: async () => failure('ENOENT'),
    inspect: async () => ({}),
    list: async path => path === '/proc' ? ['12', 'self'] : ['1'],
  };
  return { values, ports };
}

test('complete process observation establishes non-use with boundaries', async () => {
  const { values, ports } = procFixture();
  values.set('/proc/12/cwd', candidate + '-other');
  assert.deepEqual(await observePackageUse(candidate, ports), { used: false });
});

for (const [name, path, value] of [
  ['executable', 'exe', candidate + '/node'],
  ['script argument', 'cmdline', `/usr/bin/node\0${candidate}/src/entry.mjs\0`],
  ['relative script', 'cwd', candidate + '/src'],
  ['root', 'root', candidate],
  ['descriptor', 'fd/1', candidate + '/file (deleted)'],
  ['mapping', 'maps', `100-200 r--p 0000 8:1 1 ${candidate}/mapped\n`],
  ['namespace mount', 'mountinfo', baseMount +
    `2 1 8:1 ${candidate} /alias rw - ext4 /dev/sda rw\n`],
]) {
  test(`preserves package referenced by ${name}`, async () => {
    const { values, ports } = procFixture();
    values.set('/proc/12/' + path, value);
    assert.equal((await observePackageUse(candidate, ports)).used, true);
  });
}

test('failed visibility retains; confirmed process exit does not', async () => {
  const { values, ports } = procFixture();
  values.set('/proc/12/fd/1', () => failure('EACCES'));
  assert.equal((await observePackageUse(candidate, ports)).reason,
    'PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
  let reads = 0;
  values.set('/proc/12/stat', () => ++reads === 1 ? stat() : failure('ENOENT'));
  ports.inspect = async () => failure('ENOENT');
  assert.deepEqual(await observePackageUse(candidate, ports), { used: false });
});

test('PID reuse and failed identity read remain uncertain without private diagnostics',
  async () => {
    const { values, ports } = procFixture();
    let reads = 0;
    values.set('/proc/12/stat', () => stat(String(++reads)));
    assert.equal((await observePackageUse(candidate, ports)).reason,
      'PACKAGE_PROCESS_IDENTITY_CHANGED');
    values.set('/proc/12/stat', () => failure('EACCES'));
    const result = await observePackageUse(candidate, ports);
    assert.equal(result.reason, 'PACKAGE_PROCESS_IDENTITY_UNKNOWN');
    assert.equal(JSON.stringify(result).includes('private detail'), false);
  });

test('mount escaping, boundaries and aliases on a separate filesystem', () => {
  const spaced = '/opt/nibfin/core before';
  assert.equal(packageMountUse(baseMount +
    '2 1 8:1 /opt/nibfin/core\\040before /alias rw - ext4 /dev/sda rw', spaced),
  true);
  assert.equal(packageMountUse(baseMount +
    `2 1 8:1 ${candidate}-other /alias rw - ext4 /dev/sda rw`, candidate), false);
  const host = baseMount + '2 1 8:2 / /opt/nibfin rw - ext4 /dev/sdb rw';
  const origin = packageMountOrigin(host, candidate);
  assert.equal(packageMountUse(host, candidate, origin), false);
  const namespace = baseMount +
    '3 1 8:2 /core-before-abc /work rw - ext4 /dev/sdb rw';
  assert.equal(packageMountUse(namespace, candidate, origin), true);
  assert.throws(() => packageMountUse('incomplete', candidate));
});

test('argument symlinks resolve through the process root before declaring non-use',
  async () => {
    const { ports } = procFixture();
    ports.canonical = async () => candidate + '/script.mjs';
    assert.equal((await observePackageUse(candidate, ports)).used, true);
  });

test('unobserved pinned mount namespace and missing proc visibility retain', async () => {
  const { values, ports } = procFixture();
  values.set('/proc/12/fd/1', 'mnt:[other]');
  assert.equal((await observePackageUse(candidate, ports)).reason,
    'PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
  ports.list = async () => [];
  assert.equal((await observePackageUse(candidate, ports)).reason,
    'PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
});

test('missing stat with a still-visible process is not proof of exit', async () => {
  const { values, ports } = procFixture();
  values.set('/proc/12/stat', () => failure('ENOENT'));
  assert.equal((await observePackageUse(candidate, ports)).reason,
    'PACKAGE_PROCESS_IDENTITY_UNKNOWN');
});
