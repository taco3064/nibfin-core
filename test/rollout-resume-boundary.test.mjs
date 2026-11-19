import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installed completion retries without a plan or legacy credential consumption', {
  skip: process.platform !== 'linux',
}, () => {
  const script = `
import json
import pathlib
import runpy
import sys
import tempfile
from types import SimpleNamespace

module = runpy.run_path(sys.argv[1])
resume = module['resume_installed_work']
settings = resume.__globals__
calls = []
status = 'dispatched'

def complete(args, **options):
    assert args == ('node', str(settings['CLI']), 'complete-installed-lifecycle')
    assert options['stdin'] == settings['subprocess'].DEVNULL
    assert options['capture_output'] and options['text']
    assert 'GH_TOKEN' not in options['env']
    calls.append(args)
    return SimpleNamespace(returncode=2 if status == 'pending' else 0,
                           stdout=json.dumps(dict(status=status, results=[])))

settings['subprocess'].run = complete
with tempfile.TemporaryDirectory(prefix='.nibfin-rollout-resume-',
                                 dir=pathlib.Path.cwd()) as temp:
    root = pathlib.Path(temp)
    settings['CONFIG'] = root
    settings['HOSTS'] = {settings['CORE']: 'host.json'}
    settings['CLI'] = root / 'installed/core/bin/nibfin-core.mjs'
    credentials = root / 'credentials'
    credentials.mkdir()
    (credentials / 'managed.json').write_text('fixture marker; never consumed')
    host = dict(sharedRunner={'runner': {}}, tokenFile=str(credentials / 'token'),
                installation={'pin': {'commit': 'a' * 40}})
    host_file = root / 'host.json'
    host_file.write_text(json.dumps(host))
    receipt = root / 'rollout-resume.json'
    receipt.write_text(json.dumps(dict(installation=host['installation'],
                                       status='dispatched')))
    settings['os'].getuid = lambda: 0
    settings['recover_legacy_wakes'] = lambda: None
    settings['pool_step'] = lambda *args: None
    def forbidden(*args):
        raise AssertionError('must not consume legacy credentials or redeploy')
    settings['read_manual_credential'] = forbidden
    settings['next_rollout'] = forbidden
    settings['RATE_WAIT'] = root / 'rate-wait'
    settings['RATE_WAIT'].write_text('999999999999')
    assert not (root / 'rollout-plan.json').exists()
    module['main']()
    receipt.unlink()
    host['sharedRunner']['runner']['runnerId'] = 99
    host_file.write_text(json.dumps(host))
    module['main']()
    assert len(calls) == 2
    status = 'paused'
    resume()
    status = 'pending'
    try:
        resume()
        raise AssertionError('interrupted scan falsely completed')
    except RuntimeError:
        pass
    status = 'dispatched'
    resume()
    assert len(calls) == 5
    assert not receipt.exists()
    # Installed plan recovery restores services before continuation, without gh.
    completed_plan = dict(schemaVersion=2, **host['installation'],
                          apply={'completed': True})
    (root / 'rollout-plan.json').write_text(json.dumps(completed_plan))
    order = []
    def finish(services):
        order.append('restored')
        (root / 'rollout-plan.json').unlink()
    settings['finish'] = finish
    settings['runner_services'] = lambda hosts: ['fixture-service']
    def after_restore():
        assert order == ['restored']
        resume()
        order.append('continued')
    settings['resume_installed_work'] = after_restore
    module['main']()
    assert order == ['restored', 'continued']

    # A pending old lifecycle cannot prevent an authorized newer deployment.
    (credentials / 'managed.json').unlink()
    settings['RATE_WAIT'].unlink()
    settings['read_manual_credential'] = lambda host: 'synthetic-token'
    next_pin = {'commit': 'b' * 40}
    selected = (1, {'core': next_pin}, [])
    order.clear()
    def select(current, target, candidate_run):
        assert current == 'a' * 40 and target is None
        order.append('selected')
        return selected
    def deploy(hosts, selected):
        order.append('installed-and-restored')
        host['installation']['pin'] = next_pin
        host_file.write_text(json.dumps(host))
    def continuation():
        if not order:
            order.append('old-pending')
            raise RuntimeError('pending old continuation')
        assert order == ['old-pending', 'selected', 'installed-and-restored']
        assert json.loads(host_file.read_text())['installation']['pin'] == next_pin
        order.append('new-completion')
    settings['next_rollout'] = select
    settings['rollout'] = deploy
    settings['resume_installed_work'] = continuation
    settings['clean_superseded_staged_packages'] = lambda current: None
    module['main']()
    assert order[-1] == 'new-completion'
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('rollout retains its plan until restored services are verified', () => {
  const script = `
import json, pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
finish = module['finish']
g = finish.__globals__
with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as temp:
    root = pathlib.Path(temp)
    g['CONFIG'] = root
    g['HOSTS'] = {g['CORE']: 'host.json'}
    (root / 'host.json').write_text(json.dumps(
        {'installation': {'pin': {'commit': 'a' * 40}}}))
    path = root / 'rollout-plan.json'
    path.write_text(json.dumps({'phase': 'installed',
                               'apply': {'completed': True, 'targets': []}}))
    events = []
    g['start_enabled'] = lambda services: events.append('restored')
    g['pool_step'] = lambda step: events.append(step)
    g['refresh_rollout_service'] = lambda host: None
    g['clean_superseded_staged_packages'] = lambda revision: None
    def unavailable(*args):
        assert args == ('systemctl', 'is-active', '--quiet', 'fixture-service')
        raise RuntimeError('service not active')
    g['run'] = unavailable
    try:
        finish(['fixture-service'])
        raise AssertionError('unverified service released admission')
    except RuntimeError:
        pass
    assert path.exists() and events == ['restored']
    g['run'] = lambda *args: events.append('verified')
    finish(['fixture-service'])
    assert events == ['restored', 'restored', 'verified', 'release']
    assert not path.exists()
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
