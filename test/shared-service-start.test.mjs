import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSharedServices } from '../src/shared-service-start.mjs';

function systemd({ overridden = false, failSecond = false } = {}) {
  const active = [false, false];
  const starts = [];
  return {
    starts,
    run: async (executable, [operation, ...args]) => {
      assert.equal(executable, '/usr/bin/systemctl');
      if (operation === 'daemon-reload') return;
      if (operation === 'start') {
        starts.push(args);
        active[0] = true;
        if (failSecond) throw new Error('partial start');
        active[1] = true;
        return;
      }
      assert.equal(operation, 'show');
      const slot = Number(args.at(-1).match(/@(\d)\.service$/)[1]);
      const running = active[slot - 1];
      return { stdout: Buffer.from([
        'LoadState=loaded',
        'FragmentPath=/etc/systemd/system/nibfin-shared-runner@.service',
        'DropInPaths=' + (overridden ? '/etc/systemd/system/override.conf' : ''),
        'NeedDaemonReload=no',
        'User=nibfin-runner-' + slot,
        'Group=nibfin-runner-' + slot,
        'ActiveState=' + (running ? 'active' : 'inactive'),
        'SubState=' + (running ? 'running' : 'dead'),
        'MainPID=' + (running ? '123' : '0'),
      ].join('\n')) };
    },
  };
}

test('start two units once and observe already running services', async () => {
  const { run, starts } = systemd();
  const result = await startSharedServices(run);
  assert.deepEqual(await startSharedServices(run), result);
  assert.equal(result.servicesStarted, true);
  assert.deepEqual(starts, [result.units]);
});

test('refuse overridden units and report a partial start without retrying', async () => {
  const overridden = systemd({ overridden: true });
  await assert.rejects(startSharedServices(overridden.run),
    { code: 'SHARED_SERVICE_EFFECTIVE_UNIT_CONFLICT' });
  assert.deepEqual(overridden.starts, []);
  const partial = systemd({ failSecond: true });
  await assert.rejects(startSharedServices(partial.run),
    { code: 'SHARED_SERVICE_START_READBACK_REQUIRED' });
  assert.equal(partial.starts.length, 1);
});
