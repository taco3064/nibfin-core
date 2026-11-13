import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerParentGuard } from '../src/controller-parent.mjs';
import { verifyRunnerProcess } from '../src/controller-separation.mjs';

const host = { uid: 999, runnerUid: 997 };

function status(pid, ppid, uids, gids, groups, tracer = 0) {
  return [
    `Pid:\t${pid}`, `PPid:\t${ppid}`, `TracerPid:\t${tracer}`,
    `Uid:\t${uids.join('\t')}`, `Gid:\t${gids.join('\t')}`,
    `Groups:\t${groups.join(' ')} `, '',
  ].join('\n');
}

function fixture() {
  const own = [999, 999, 999, 999];
  const gids = [988, 988, 988, 988];
  const files = new Map([
    ['/proc/42/status', status(42, 41, own, gids, [986, 988])],
    ['/proc/41/status', status(41, 30, [997, 0, 0, 0], gids, [986, 988])],
    ['/proc/41/cmdline',
      '/usr/bin/sudo\0-n\0-u\0#999\0--\0/opt/nibfin/core/bin/nibfin-controller\0'],
  ]);
  for (const [pid, ppid] of [[42, 41], [41, 30]]) {
    const fields = ['S', String(ppid), ...Array(17).fill('0'), '12345'];
    files.set(`/proc/${pid}/stat`, `${pid} (name with ) parens) ${fields.join(' ')}`);
  }
  return {
    files,
    options: {
      pid: 42, uid: 999,
      async read(path) {
        assert.ok(files.has(path), `Unexpected or missing process evidence: ${path}`);
        return files.get(path);
      },
    },
  };
}

test('only the proven privileged direct parent can carry socket groups', async () => {
  const { files, options } = fixture();
  const guard = await controllerParentGuard(host, options);
  assert.equal(guard.pid, 41);
  guard.verifyStatus(files.get('/proc/41/status'));
  await guard.check();
  const monitor = files.get('/proc/41/status');
  verifyRunnerProcess(monitor, 997, 986);
  const mixed = monitor.replace('Uid:\t997\t0\t0\t0', 'Uid:\t997\t0\t997\t0');
  assert.throws(() => verifyRunnerProcess(mixed, 997, 986));
});

test('argv cannot substitute for privileged identity or exact groups', async () => {
  const changes = [
    ['Uid:\t997\t0\t0\t0', 'Uid:\t997\t997\t997\t997'],
    ['Uid:\t997\t0\t0\t0', 'Uid:\t997\t999\t0\t0'],
    ['TracerPid:\t0', 'TracerPid:\t7'],
    ['Gid:\t988\t988\t988\t988', 'Gid:\t0\t988\t988\t988'],
    ['Groups:\t986 988 ', 'Groups:\t986 988 987 '],
    ['Pid:\t41', 'Pid:\t40'],
    ['PPid:\t30', 'PPid:\t31'],
  ];
  for (const [before, after] of changes) {
    const { files, options } = fixture();
    files.set('/proc/41/status', files.get('/proc/41/status').replace(before, after));
    await assert.rejects(controllerParentGuard(host, options));
  }
  for (const argv of ['/usr/bin/sudo\0', 'sudo\0', '/bin/sh\0', '']) {
    const { files, options } = fixture();
    files.set('/proc/41/cmdline', argv);
    await assert.rejects(controllerParentGuard(host, options));
  }
});

test('unrelated root processes receive no exception', async () => {
  const { files, options } = fixture();
  files.set('/proc/41/status',
    status(41, 30, [0, 0, 0, 0], [0, 0, 0, 0], []));
  assert.equal(await controllerParentGuard(host, options), null);
});

test('process reuse between the bracketing reads fails closed', async () => {
  const { options } = fixture();
  let count = 0;
  const read = async (path) => {
    const text = await options.read(path);
    if (path === '/proc/41/stat' && ++count === 2) {
      return text.replace('12345', '99999');
    }
    return text;
  };
  await assert.rejects(controllerParentGuard(host, { ...options, read }));
});

test('parent disappearance, PID reuse, reparenting or credential changes fail closed',
  async () => {
    for (const path of ['/proc/41/stat', '/proc/42/stat', '/proc/41/status',
      '/proc/42/status', '/proc/41/cmdline']) {
      const { files, options } = fixture();
      const guard = await controllerParentGuard(host, options);
      if (path.endsWith('/stat')) {
        files.set(path, files.get(path).replace('12345', '12346'));
      }
      else if (path.endsWith('/status')) {
        files.set(path, files.get(path).replace('PPid:', 'Unknown:'));
      } else files.delete(path);
      await assert.rejects(guard.check());
    }
  });

test('controller identity and process evidence are mandatory', async () => {
  const { files, options } = fixture();
  await assert.rejects(controllerParentGuard(host, { ...options, uid: 997 }));
  files.set('/proc/42/status',
    files.get('/proc/42/status').replace('Uid:\t999\t999\t999\t999',
      'Uid:\t999\t999\t997\t999'));
  await assert.rejects(controllerParentGuard(host, options));
});
