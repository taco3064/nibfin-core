import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fixture, name } from './core-package-retirement-fixture.mjs';
import { withKernelGate } from '../src/kernel-gate.mjs';
import { retireCorePackages } from '../src/core-package-retirement.mjs';

test('native inherited shared and exclusive gates defer without dropping the lock',
  async t => {
    const directory = await fixture(t);
    const handle = await open(directory, 'r');
    try {
      for (const shared of [true, false]) {
        const locked = spawnSync('/usr/bin/flock',
          ['-n', ...(shared ? ['--shared'] : []), '3'],
        { stdio: ['ignore', 'ignore', 'pipe', handle.fd] });
        assert.equal(locked.status, 0, locked.stderr?.toString());
        const child = spawnSync(process.execPath, ['--experimental-test-module-mocks',
          'test/core-package-retirement-gate-fixture.mjs', directory],
        { stdio: ['ignore', 'pipe', 'pipe', handle.fd], encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout),
          [{ status: 'retained', code: 'PACKAGE_GATE_PENDING' }]);
        // A second open description cannot obtain exclusive access, proving
        // the child did not release/downgrade its parent's lifetime gate.
        const contender = spawnSync('/usr/bin/flock', ['-n', '-E', '75', directory,
          '/usr/bin/true']);
        assert.equal(contender.status, 75);
      }
    } finally { await handle.close(); }
  });

test('a native shared contender can enter between retirement candidates', async t => {
  const directory = await fixture(t);
  const caller = await open(directory, 'r');
  const first = name('before', 'a'), next = name('before', 'b');
  const remaining = new Set([first, next]);
  const inspected = [];
  let acquired = false;
  const ports = {
    list: () => remaining,
    inspect: candidate => { inspected.push(candidate); return { candidate }; },
    protection: () => null,
    unused: () => {},
    remove: ({ candidate }) => { remaining.delete(candidate); },
  };
  const withGate = async use => {
    const handle = await open(directory, 'r');
    try {
      return await withKernelGate(handle, use);
    } finally {
      await handle.close();
      if (!acquired) {
        const contender = spawnSync('/usr/bin/flock', ['--shared', '-n', '3'],
          { stdio: ['ignore', 'pipe', 'pipe', caller.fd], encoding: 'utf8' });
        assert.equal(contender.status, 0, contender.stderr);
        acquired = true;
      }
    }
  };
  try {
    assert.deepEqual(await retireCorePackages(ports, withGate), [
      { package: first, status: 'removed', code: 'PACKAGE_REMOVED' },
      { status: 'retained', code: 'PACKAGE_GATE_PENDING' },
    ]);
    assert.deepEqual(inspected, [first]);
  } finally { await caller.close(); }
  assert.deepEqual(await retireCorePackages(ports, withGate),
    [{ package: next, status: 'removed', code: 'PACKAGE_REMOVED' }]);
  assert.deepEqual(inspected, [first, next]);
});
