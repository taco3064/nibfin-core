"""Controlled fixed-bridge/legacy ports; no installed host resources are used."""
import importlib.util
import json
from pathlib import Path
import subprocess

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
    def continue_after_gate(value, handle):
        events.append('continuation')
        return {**value, 'continuation': {'status': 'paused', 'results': []}}


bridge.fresh_manager_result = lambda *args: (
    events.append('child-exited') or {'status': 'installed',
                                     'installation': 'complete'}, 0)
bridge.fcntl.flock = lambda *args: events.append('exclusive')
bridge.retire_packages = lambda handle: events.append('retire') or report
bridge.normal_installer = lambda handle: events.append('refresh') or {
    'status': 'installed'}
bridge.module_at = lambda *args: Admin
value, status = bridge.run(b'{}', 3, 'administrator')
assert events == ['child-exited', 'exclusive', 'retire', 'refresh', 'continuation']
assert status == 0 and value['cleanup'] == report
assert value['continuation']['status'] == 'paused'

events.clear()
bridge.normal_installer = lambda handle: events.append('refresh') or {
    'status': 'pending', 'code': 'PUBLICATION_RETRY'}
value, status = bridge.run(b'{}', 3, 'administrator')
assert events == ['child-exited', 'exclusive', 'retire', 'refresh']
assert status == 0 and value['installation'] == 'complete'
assert value['cleanup'] == report and value['continuation']['status'] == 'pending'

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
    calls.append([str(arg) for arg in arguments])
    return subprocess.CompletedProcess(arguments, 0,
        json.dumps({'status': 'complete', 'cleanup': report}), '')


legacy.subprocess.run = delegated
legacy.api = lambda *args: (_ for _ in ()).throw(AssertionError('No ancestry query'))
assert legacy.clean_superseded_staged_packages() == report
assert calls == [['node', '/opt/nibfin/core/src/core-package-retirement-entry.mjs']]

results = load('package_results', 'scripts/core_rollout_result.py')
for status in ('complete', 'pending'):
    value = results.project_result({'status': status, 'cleanup': [
        {**report[0], 'secret': '/private/value'},
        {'package': '/private/value', 'status': 'retained', 'code': 'ACTIVE_APPLY'},
        {'status': 'retained', 'code': 'PACKAGE_GATE_PENDING', 'secret': 'private'}]})
    assert value['cleanup'] == [report[0],
        {'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
print('Fixed bridge, publication retry, legacy delegation and typed decoder passed')
