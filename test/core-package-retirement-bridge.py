"""Controlled fixed-bridge/legacy ports; no installed host resources are used."""
import importlib.util
from contextlib import nullcontext
import json
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
report = [{'package': 'core-staged-' + 'a' * 40,
           'status': 'removed', 'code': 'PACKAGE_REMOVED'}]


class Results:
    @staticmethod
    def result_exit(value):
        return 0


class Admin:
    RESULTS = Results

    @staticmethod
    def continue_installed(value):
        events.append('continuation')
        return {**value, 'continuation': {'status': 'paused', 'results': []}}


bridge.fresh_manager_result = lambda *args: (
    events.append('child-exited') or {'status': 'installed',
                                     'installation': 'complete'}, 0)


def retire():
    events.append('retire')
    return report


native_retire = bridge.retire_packages
bridge.retire_packages = retire
bridge.normal_installer = lambda: events.append('refresh') or {
    'status': 'installed'}
bridge.module_at = lambda *args: Admin
bridge.manager_package = lambda: nullcontext(Path('/manager'))
value, status = bridge.run(b'{}', 'administrator')
assert events == ['child-exited', 'refresh', 'continuation', 'retire']
assert status == 0 and value['cleanup'] == report
assert value['continuation']['status'] == 'paused'

events.clear()
bridge.normal_installer = lambda: events.append('refresh') or {
    'status': 'pending', 'code': 'PUBLICATION_RETRY'}
value, status = bridge.run(b'{}', 'administrator')
assert events == ['child-exited', 'refresh', 'retire']
assert status == 0 and value['installation'] == 'complete'
assert value['cleanup'] == report and value['continuation']['status'] == 'pending'

events.clear()
bridge.normal_installer = lambda: {'status': 'installed'}
bridge.retire_packages = lambda: [
    {'status': 'retained', 'code': 'PACKAGE_OBSERVATION_UNAVAILABLE'}]
value, status = bridge.run(b'{}', 'administrator')
assert status == 0 and value['installation'] == 'complete'
assert value['continuation']['status'] == 'paused'
assert value['cleanup'][0]['code'] == 'PACKAGE_OBSERVATION_UNAVAILABLE'

events.clear()
bridge.retire_packages = retire


def unexpected_failure(*_args):
    raise RuntimeError('unexpected completion failure')


bridge.continue_installed = unexpected_failure
try:
    bridge.run(b'{}', 'administrator')
except RuntimeError as error:
    assert str(error) == 'unexpected completion failure'
else:
    raise AssertionError('unexpected completion failure was swallowed')
assert events == ['child-exited', 'retire']


events.clear()
bridge.runtime_node = lambda _root: '/node'
bridge.command = lambda *_, **_options: {'status': 'verified'}
bridge.process_result = lambda _root, result: result
bridge.installer_results = lambda _root: 'verified decoder'
bridge.owned = lambda _path: None


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

    def standalone(arguments, **options):
        bridge.LIVE.rename(base / 'verified')
        bridge.LIVE.mkdir()
        (source,) = options['pass_fds']
        pinned = Path('/proc/self/fd') / str(source)
        assert options['cwd'] == pinned
        entry = pinned / 'src/core-package-retirement-entry.mjs'
        assert arguments == ['/node', str(entry)]
        assert pinned.stat().st_ino == expected != bridge.LIVE.stat().st_ino
        events.append('standalone')
        return {'status': 'complete', 'cleanup': report}

    bridge.subprocess.run = standalone
    assert native_retire() == report
assert events == ['standalone']

admin = load('package_admin', 'scripts/core-rollout-admin.py')
deferred = [{'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
admin.continuation = lambda: {'status': 'paused', 'results': [], 'cleanup': deferred}
value = admin.continue_installed({'installation': 'complete', 'cleanup': report})
assert value['cleanup'] == report
assert value['continuation'] == {'status': 'paused', 'results': []}
value = admin.continue_installed({'installation': 'complete'})
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
