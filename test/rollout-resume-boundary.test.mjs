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
    assert not (root / 'rollout-plan.json').exists()
    resume()
    receipt.unlink()
    host['sharedRunner']['runner']['runnerId'] = 99
    host_file.write_text(json.dumps(host))
    resume()
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
    def retire():
        assert not path.exists()
        events.append('retire')
        return []
    g['clean_superseded_staged_packages'] = retire
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
    assert events == ['restored', 'restored', 'verified', 'release', 'retire']
    assert not path.exists()
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
