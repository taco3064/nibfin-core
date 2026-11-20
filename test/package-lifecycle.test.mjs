import test from 'node:test';
import assert from 'node:assert/strict';
import { completeLocalLifecycle } from '../src/installed-lifecycle.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const status of ['dispatched', 'paused', 'pending']) {
  test(`cleanup runs independently before ${status} continuation`, async () => {
    const order = [], cleanup = { retired: ['/owned/copy'], retained: [] };
    const result = await completeLocalLifecycle(async () => {
      order.push('cleanup');
      return cleanup;
    }, async () => {
      order.push('continuation');
      return { status, results: [] };
    });
    assert.deepEqual(order, ['cleanup', 'continuation']);
    assert.deepEqual(result, { status, results: [], cleanup });
  });
}

test('uncertain cleanup cannot change continuation status or expose errors', async () => {
  const result = await completeLocalLifecycle(async () => {
    throw new Error('private diagnostic');
  }, async () => ({ status: 'dispatched', results: [] }));
  assert.equal(result.status, 'dispatched');
  assert.equal(result.cleanup.deferred, 'PACKAGE_OBSERVATION_OR_REMOVAL_UNCERTAIN');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('legacy cleanup delegates without ancestry or provider calls', () => {
  const script = `
import json, runpy, sys
from types import SimpleNamespace
module = runpy.run_path(sys.argv[1])
cleanup = module['clean_superseded_staged_packages']
g = cleanup.__globals__
def run(args, **options):
    assert args == ('node', str(g['INSTALL'] /
                              'core/src/package-retirement-entry.mjs'))
    return SimpleNamespace(returncode=0, stdout=json.dumps(
        dict(retired=[], retained=[])))
g['subprocess'].run = run
cleanup('unused-source-ancestry')
g['subprocess'].run = lambda *args, **options: SimpleNamespace(
    returncode=1, stdout='', stderr='private diagnostic')
cleanup('unused-source-ancestry')
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('private diagnostic'), false);
});

test('fixed bridge retires after child exit before uncertain management refresh', () => {
  const script = `
import pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
run = module['run']
g = run.__globals__
events = []
def child(*args):
    events.append('child-exited')
    return {'status': 'installed', 'installation': 'complete'}, 0
def cleanup(handle):
    assert events == ['child-exited']
    events.append('cleanup')
    return {'retired': ['owned'], 'retained': []}
def refresh(handle):
    assert events == ['child-exited', 'cleanup']
    events.append('refresh')
    raise ValueError('uncertain publication')
g.update(fresh_manager_result=child, retire_packages=cleanup,
         normal_installer=refresh)
with tempfile.TemporaryFile(dir=pathlib.Path.cwd()) as gate:
    value, code = run(b'{}', gate.fileno(), 'maintenance')
assert code == 0 and value['installation'] == 'complete'
assert value['continuation']['status'] == 'pending'
assert value['cleanup']['retired'] == ['owned']
assert events == ['child-exited', 'cleanup', 'refresh']
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/core-maintenance-bridge.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('administrator releases apply before cleanup and retries without intent', () => {
  const script = `
import json, pathlib, runpy, sys, tempfile
from types import SimpleNamespace
module = runpy.run_path(sys.argv[1])
finish = module['finish']
g = finish.__globals__
with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as temp:
    root = pathlib.Path(temp)
    target = {'runId': 1, 'artifactId': 2}
    pin = {'commit': 'a' * 40}
    (root / 'host.json').write_text(json.dumps({'installation': {'pin': pin}}))
    path = root / 'rollout-plan.json'
    path.write_text(json.dumps(dict(phase='installed', mode='core-only',
        apply={'completed': True}, administratorTarget=target, pin=pin,
        candidate={}, runId=1, originalServices=[])))
    events = []
    def write(path, value):
        assert events == ['release']
        events.append('record')
        path.write_text(json.dumps(value))
    runtime = SimpleNamespace(CONFIG=root, CORE='core', E2E='e2e',
        E2E_HOST='peer.json', HOSTS={'core': 'host.json'},
        pool_step=events.append, write_config=write, sync_directory=lambda _: None,
        require=lambda condition, reason: condition or sys.exit(reason))
    finish(runtime, [])
    assert not path.exists() and events == ['release', 'record']
    runtime.read_consumer = lambda *args: (None, None)
    runtime.rollout = lambda *args: sys.exit('must reuse installed result')
    g['chosen_target'] = lambda *args: (1, {'core': pin}, [])
    g['bridge'] = lambda *args: {'status': 'observed', 'pin': pin}
    result = module['operation'](runtime, target, core_only=True,
                                 defer_continuation=True)
    assert result['installation'] == 'complete'
    assert not path.exists()
    def cleanup(handle):
        assert not path.exists() and events == ['release', 'record']
        events.append('cleanup')
        return {'retired': ['owned'], 'retained': []}
    def continuation(handle):
        assert events[-1] == 'cleanup'
        events.append('continuation')
        return {'status': 'paused', 'results': []}
    g['retire_after_gate'] = cleanup
    g['continuation'] = continuation
    with open(root / 'gate', 'w') as gate:
        completed = module['continue_after_gate'](result, gate.fileno())
    assert completed['continuation']['status'] == 'paused'
    assert completed['cleanup']['retired'] == ['owned']
    assert events == ['release', 'record', 'cleanup', 'continuation']
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/core-rollout-admin.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
