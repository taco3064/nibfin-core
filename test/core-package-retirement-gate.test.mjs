import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fixture } from './core-package-retirement-fixture.mjs';

test('native inherited shared gate defers; exclusive gate is reused and retained',
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
        assert.deepEqual(JSON.parse(child.stdout), [{ status: shared ? 'retained' :
          'removed', code: shared ? 'PACKAGE_GATE_PENDING' : 'PACKAGE_REMOVED' }]);
        // A second open description cannot obtain exclusive access, proving
        // the child did not release/downgrade its parent's lifetime gate.
        const contender = spawnSync('/usr/bin/flock', ['-n', '-E', '75', directory,
          '/usr/bin/true']);
        assert.equal(contender.status, 75);
      }
    } finally { await handle.close(); }
  });
