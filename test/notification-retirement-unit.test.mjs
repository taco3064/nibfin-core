import test from 'node:test';
import assert from 'node:assert/strict';
import { readNotificationUnit, notificationUnitStopped }
  from '../src/notification-retirement-host.mjs';

const name = 'nibfin-notification-relay.timer';
const state = () => ({ Id: name, LoadState: 'loaded',
  FragmentPath: '/etc/systemd/system/' + name, DropInPaths: '',
  ActiveState: 'inactive', UnitFileState: 'disabled', MainPID: '0',
  ControlGroup: '', NeedDaemonReload: 'no' });

async function read(value) {
  return readNotificationUnit(name, async (executable, args) => {
    assert.equal(executable, '/usr/bin/systemctl');
    assert.deepEqual(args.slice(0, 2), ['show', name]);
    return { stdout: Buffer.from(Object.entries(value)
      .map(([key, content]) => `${key}=${content}`).join('\n') + '\n') };
  }, async path => assert.equal(path, '/usr/bin/systemctl'));
}

test('native unit observation verifies fixed fragment and no drop-ins', async () => {
  assert.deepEqual(await read(state()), state());
  for (const change of [
    { Id: 'unrelated.timer' }, { FragmentPath: '/usr/lib/systemd/system/' + name },
    { DropInPaths: '/etc/systemd/system/override.conf' }, { LoadState: 'masked' },
  ]) await assert.rejects(read({ ...state(), ...change }),
    { code: 'NOTIFICATION_UNIT_NOT_OWNED' });
});

test('inactive alone cannot establish worker and scheduler termination', () => {
  assert(notificationUnitStopped(state(), name));
  for (const change of [
    { ActiveState: 'active' }, { UnitFileState: 'enabled' },
  ]) assert(!notificationUnitStopped({ ...state(), ...change }, name));
  const service = name.replace('.timer', '.service');
  for (const change of [{ MainPID: '100' }, { ControlGroup: '/active' }])
    assert(!notificationUnitStopped({ ...state(), ...change }, service));
  const timer = { ...state() };
  delete timer.MainPID;
  delete timer.ControlGroup;
  assert(notificationUnitStopped(timer, name), 'timer has no service PID properties');
});

test('already removed resource reuses native not-found state', async () => {
  const absent = { ...state(), LoadState: 'not-found', FragmentPath: '',
    UnitFileState: '' };
  assert(notificationUnitStopped(await read(absent), name));
});
