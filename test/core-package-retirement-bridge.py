"""Controlled fixed-bridge/legacy ports; no installed host resources are used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

ROOT = Path.cwd()


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load('package_bridge', 'scripts/core-maintenance-bridge.py')
events = []
mode = bridge.fcntl.LOCK_SH
report = [{'package': 'core-staged-' + 'a' * 40,
           'status': 'removed', 'code': 'PACKAGE_REMOVED'}]


class Results:
    @staticmethod
    def result_exit(value):
        return 0


class Admin:
    RESULTS = Results

    @staticmethod
    def continue_after_gate(value, handle):
        events.append('continuation')
        return {**value, 'continuation': {'status': 'paused', 'results': []}}


bridge.fresh_manager_result = lambda *args: (
    events.append('child-exited') or {'status': 'installed',
                                     'installation': 'complete'}, 0)


def gate(_handle, operation):
    global mode
    mode = operation & ~bridge.fcntl.LOCK_NB
    events.append({bridge.fcntl.LOCK_EX: 'exclusive', bridge.fcntl.LOCK_SH: 'shared',
                   bridge.fcntl.LOCK_UN: 'unlocked'}[mode])


def retire(_handle):
    assert mode == bridge.fcntl.LOCK_UN
    events.append('retire')
    return report


native_retire = bridge.retire_packages
bridge.fcntl.flock = gate
bridge.retire_packages = retire
bridge.normal_installer = lambda handle: events.append('refresh') or {
    'status': 'installed'}
bridge.module_at = lambda *args: Admin
value, status = bridge.run(b'{}', 3, 'administrator')
assert events == ['child-exited', 'exclusive', 'refresh', 'continuation',
                  'unlocked', 'retire']
assert status == 0 and value['cleanup'] == report
assert value['continuation']['status'] == 'paused'

events.clear()
bridge.normal_installer = lambda handle: events.append('refresh') or {
    'status': 'pending', 'code': 'PUBLICATION_RETRY'}
value, status = bridge.run(b'{}', 3, 'administrator')
assert events == ['child-exited', 'exclusive', 'refresh', 'unlocked', 'retire']
assert status == 0 and value['installation'] == 'complete'
assert value['cleanup'] == report and value['continuation']['status'] == 'pending'

events.clear()
bridge.normal_installer = lambda _handle: {'status': 'installed'}
bridge.retire_packages = lambda _handle: [
    {'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
value, status = bridge.run(b'{}', 3, 'administrator')
assert status == 0 and value['installation'] == 'complete'
assert value['continuation']['status'] == 'paused'
assert value['cleanup'][0]['code'] == 'PACKAGE_GATE_PENDING'

events.clear()
bridge.retire_packages = retire


def unexpected_failure(*_args):
    raise RuntimeError('unexpected completion failure')


bridge.continue_installed = unexpected_failure
try:
    bridge.run(b'{}', 3, 'administrator')
except RuntimeError as error:
    assert str(error) == 'unexpected completion failure'
else:
    raise AssertionError('unexpected completion failure was swallowed')
assert events == ['child-exited', 'exclusive', 'unlocked', 'retire']


events.clear()
bridge.runtime_node = lambda _root: '/node'
bridge.command = lambda *_: {'status': 'verified'}
bridge.process_result = lambda _root, result: result
bridge.installer_results = lambda _root: 'verified decoder'


def decode(decoder, result):
    assert decoder == 'verified decoder'
    return result


bridge.decode_result = decode
scratch = ROOT / '.deliver-test-tmp'
scratch.mkdir(exist_ok=True)
with TemporaryDirectory(dir=scratch) as directory:
    base = Path(directory)
    bridge.LIVE = base / 'live'
    bridge.LIVE.mkdir()
    expected = bridge.LIVE.stat().st_ino
    management = os.open(base, os.O_RDONLY | os.O_DIRECTORY)

    def standalone(arguments, **options):
        assert mode == bridge.fcntl.LOCK_UN
        bridge.LIVE.rename(base / 'verified')
        bridge.LIVE.mkdir()
        (source,) = options['pass_fds']
        assert source != management
        pinned = Path('/proc/self/fd') / str(source)
        assert options['cwd'] == pinned
        entry = pinned / 'src/core-package-retirement-entry.mjs'
        assert arguments == ['/node', str(entry)]
        assert pinned.stat().st_ino == expected != bridge.LIVE.stat().st_ino
        events.append('standalone')
        return {'status': 'complete', 'cleanup': report}

    bridge.subprocess.run = standalone
    try:
        assert native_retire(management) == report
    finally:
        os.close(management)
assert events == ['shared', 'unlocked', 'standalone']

admin = load('package_admin', 'scripts/core-rollout-admin.py')
deferred = [{'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
admin.continuation = lambda: {'status': 'paused', 'results': [], 'cleanup': deferred}
value = admin.continue_after_gate({'installation': 'complete', 'cleanup': report}, 3)
assert value['cleanup'] == report
assert value['continuation'] == {'status': 'paused', 'results': []}
value = admin.continue_after_gate({'installation': 'complete'}, 3)
assert value['continuation']['cleanup'] == deferred

legacy = load('package_legacy', 'scripts/host-auto-rollout.py')
calls = []


def delegated(arguments, **options):
    calls.append(([str(arg) for arg in arguments], options['cwd']))
    return subprocess.CompletedProcess(arguments, 0,
        json.dumps({'status': 'complete', 'cleanup': report}), '')


legacy.subprocess.run = delegated
legacy.api = lambda *args: (_ for _ in ()).throw(AssertionError('No ancestry query'))
assert legacy.clean_superseded_staged_packages() == report
assert calls == [(['node', 'src/core-package-retirement-entry.mjs'],
                  Path('/opt/nibfin/core'))]

results = load('package_results', 'scripts/core_rollout_result.py')
for status in ('complete', 'pending'):
    value = results.project_result({'status': status, 'cleanup': [
        {**report[0], 'secret': '/private/value'},
        {'package': '/private/value', 'status': 'retained', 'code': 'ACTIVE_APPLY'},
        {'status': 'retained', 'code': 'PACKAGE_GATE_PENDING', 'secret': 'private'}]})
    assert value['cleanup'] == [report[0],
        {'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
print('Fixed bridge, publication retry, legacy delegation and typed decoder passed')
