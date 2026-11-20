#!/usr/bin/python3 -I
"""Fixed root entry; all source use shares the existing configuration gate."""
import sys
sys.dont_write_bytecode = True

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess

BASE = Path('/usr/local/libexec/nibfin/core-rollout')
MANAGER = BASE / 'manager'
LIVE = Path('/opt/nibfin/core')
BOOTSTRAP = BASE / 'bootstrap'
CONFIG = Path('/etc/nibfin')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C'}
REPAIRABLE = {'ENOENT', 'SOURCE_MANIFEST_MISMATCH',
              'ROLLOUT_MANAGER_METADATA_UNAVAILABLE',
              'CORE_MANAGEMENT_RUNTIME_UNAVAILABLE', 'CORE_MAINTENANCE_ENTRY_PENDING',
              'ROLLOUT_MANAGER_HOST_SOURCE_UNAVAILABLE'}
SHARED_KINDS = ('pre-worker', 'inspect', 'maintenance',
                'upgrade-receive', 'upgrade-complete')
UPGRADE_KINDS = ('upgrade-prepare', 'upgrade-bind', 'upgrade-observe',
                 'upgrade-complete', 'upgrade-receive')

LIVE_CHECK = '''
import {readFile} from 'node:fs/promises';
import {verifyInstalledSource} from '/opt/nibfin/core/src/source-package.mjs';
try {
  const host = JSON.parse(await readFile('/etc/nibfin/host.json', 'utf8'));
  await verifyInstalledSource('/opt/nibfin/core', host.installation.pin);
  process.stdout.write(JSON.stringify({status:'verified'}));
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]*$/.test(error.code || '') ? error.code :
    'CORE_MAINTENANCE_LIVE_SOURCE_UNAVAILABLE';
  process.stdout.write(JSON.stringify({status:'denied',code}));
  process.exitCode = 1;
}
'''


def owned(path):
    if path.resolve() != path:
        raise ValueError('Untrusted administrator path')
    for current in (path, *path.parents):
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('Untrusted administrator path')


def owned_tree(root):
    owned(root)
    for path in root.iterdir():
        owned(path)
        if path.is_dir():
            owned_tree(path)
        elif not path.is_file():
            raise ValueError('Untrusted administrator source')


def module_at(name, path):
    owned(path)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runtime_node(root):
    # Root-only immutable source is checked before any dynamic package import.
    # The maintained runtime verifies the official Node bytes and ELF identity;
    # the normal Core source verifier remains the content/integrity authority.
    owned_tree(root)
    module = module_at('nibfin_management_runtime',
                       root / 'src/security/shared-runtime.py')
    module.CORE = root
    return module.runtime()


def command(arguments, handle, payload=None):
    descriptors = (handle,)
    if payload and json.loads(payload).get('kind') == 'pre-worker':
        # Only the verified legacy LIVE admission may use this human-only
        # stderr channel. New typed and unknown child stderr stays captured.
        os.dup2(2, 4)
        descriptors = (handle, 4)
    return subprocess.run(arguments, input=payload, capture_output=True,
                          env={**ENV, 'SUDO_UID': os.environ.get('SUDO_UID', '')},
                          pass_fds=descriptors)


def normal_installer(handle):
    if LIVE.is_dir():
        node = runtime_node(LIVE)
        checked = command([node, '--input-type=module', '-e', LIVE_CHECK], handle)
        result = process_result(LIVE, checked)
        if result.get('status') != 'verified':
            return result
        if (LIVE / 'src/core-maintenance-installation.json').is_file():
            completed = command([node, str(LIVE / 'bin/nibfin-core.mjs'),
                                 'install-core-rollout-manager'], handle)
            return process_result(LIVE, completed)
    # First bootstrap may precede the live Core's new command. It is still the
    # normal fixed, verified administrator package, not a requested source path.
    node = runtime_node(BOOTSTRAP)
    completed = command([node, str(BOOTSTRAP / 'scripts/core-maintenance-bootstrap.mjs')],
                        handle)
    return process_result(BOOTSTRAP, completed)


def installer_results(root):
    helper = root / 'scripts/core_rollout_result.py'
    if not helper.is_file():
        # A legacy LIVE predates typed reporting; the normal verified bootstrap
        # supplies the shared decoder, without treating free stderr as authority.
        helper = BOOTSTRAP / 'scripts/core_rollout_result.py'
    return module_at('nibfin_installer_results', helper)


def process_result(root, completed):
    return decode_result(installer_results(root), completed)


def decode_result(results, completed):
    try:
        return results.read_result(completed)
    except results.CoreRolloutFailure as error:
        return error.result


def manager_result(payload, handle):
    node = runtime_node(MANAGER)
    metadata = BASE / 'runtime.json'
    owned(metadata)
    info = metadata.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
            json.loads(metadata.read_text()) != {'nodePath': node}:
        raise ValueError('Unfinished management runtime publication')
    entry = MANAGER / 'src/core-maintenance-bridge-entry.mjs'
    owned(entry)
    results = module_at('nibfin_bridge_results',
                        MANAGER / 'scripts/core_rollout_result.py')
    child = command([node, str(entry)], handle, payload)
    try:
        return results.read_result(child), child.returncode
    except results.CoreRolloutFailure as error:
        return error.result, results.result_exit(error.result)


def fresh_manager_result(payload, handle, kind):
    try:
        value, code = manager_result(payload, handle)
    except FileNotFoundError:
        value, code = {'status': 'pending', 'code': 'ENOENT'}, 2
    except ValueError:
        # This is not permission to overwrite a foreign source. The normal
        # installer independently verifies the adopted LIVE and existing full
        # manager before publishing; incompatible or changed bytes remain denied.
        value, code = {'status': 'pending',
                       'code': 'CORE_MANAGEMENT_RUNTIME_UNAVAILABLE'}, 2
    if kind == 'inspect' or value.get('code') not in REPAIRABLE:
        return value, code
    # This only finishes deployment of the actual adopted management source.
    # It grants no job, promotion or workflow-target authority. Admission is
    # performed afresh after repair, with the original private request.
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    repaired = normal_installer(handle)
    if repaired.get('status') != 'installed':
        return repaired, 1 if repaired.get('status') == 'denied' else 2
    if kind in SHARED_KINDS:
        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
    return manager_result(payload, handle)


def retire_packages(handle):
    source = None
    try:
        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        try:
            node = runtime_node(LIVE)
            checked = command([node, '--input-type=module', '-e', LIVE_CHECK], handle)
            if process_result(LIVE, checked).get('status') != 'verified':
                raise ValueError('Live source is unavailable')
            decoder = installer_results(LIVE)
            source = os.open(LIVE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
        # Pass the verified directory, not FD 3 or the mutable LIVE path.
        # The sweep acquires its own gate and protects its source through cwd.
        pinned = Path('/proc/self/fd') / str(source)
        entry = pinned / 'src/core-package-retirement-entry.mjs'
        result = subprocess.run([node, str(entry)], cwd=pinned, pass_fds=(source,),
                                capture_output=True, env=ENV)
        value = decode_result(decoder, result)
        if value.get('status') == 'complete' and isinstance(value.get('cleanup'), list):
            return value['cleanup']
    except BlockingIOError:
        return [{'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    finally:
        if source is not None:
            os.close(source)
    return [{'status': 'retained', 'code': 'PACKAGE_OBSERVATION_UNAVAILABLE'}]


def upgrade_request(handle, **request):
    result, _ = manager_result(json.dumps(request).encode(), handle)
    return result


def ready_upgrade(value):
    return (value.get('continuationEligible') is True and
            value.get('readiness') in ('ready', 'not-required'))


def settle_upgrades(handle, operations, continuation):
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    results = []
    for item in operations:
        if ready_upgrade(item):
            outcome = upgrade_request(handle, kind='upgrade-settle',
                                      operationId=item['operationId'],
                                      result=continuation)
            if outcome and outcome.get('upgrade'):
                item = outcome['upgrade']
        results.append(item)
    return results


def continue_upgrade(value, handle, code):
    upgrade = value.get('upgrade')
    if not upgrade or not ready_upgrade(upgrade):
        return value, code
    admin = module_at('nibfin_current_completion',
                      MANAGER / 'scripts/core-rollout-admin.py')
    observed = admin.continue_after_gate({'status': 'installed'}, handle)
    continuation = observed['continuation']
    try:
        updated, = settle_upgrades(handle, [upgrade], continuation)
        return {**value, 'upgrade': updated}, code
    except BlockingIOError:
        # Any confirmed dispatch is retained by normal installed continuation.
        # Read it back if this operation's result publication could not finish.
        return value, code


def upgrade_action_result(value, code):
    upgrade = value.get('upgrade')
    if not upgrade:
        return value, code
    if (upgrade.get('installationCause', {}).get('code') ==
            'UPGRADE_CORE_ACTIVATION_QUEUED'):
        return value, code
    for phase in ('installation', 'readiness', 'continuation'):
        cause = upgrade.get(phase + 'Cause')
        if cause:
            return {**value, 'status': 'pending', **cause}, 2
    return value, code


def continue_installed(value, handle, activation, admin):
    if not activation:
        return admin.continue_after_gate(value, handle)
    fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
    matched = upgrade_request(handle, kind='upgrade-installed', activation=activation)
    if matched is None or not isinstance(matched.get('upgradeOperations'), list):
        cause = matched or {}
        pending = {'status': 'pending', 'results': [],
                   'code': cause.get('code', 'UPGRADE_INSTALLATION_READBACK_PENDING')}
        if 'githubApi' in cause:
            pending['githubApi'] = cause['githubApi']
        return {**value, 'continuation': pending}
    upgrades = matched['upgradeOperations']
    for operation in upgrades:
        if not ready_upgrade(operation):
            cause = (operation.get('installationCause') or
                     operation.get('readinessCause') or
                     {'code': 'UPGRADE_READINESS_PENDING'})
            return {**value, 'upgradeOperations': upgrades,
                    'continuation': {**cause, 'status': 'pending', 'results': []}}
    value = admin.continue_after_gate(value, handle)
    if upgrades:
        value['upgradeOperations'] = settle_upgrades(
            handle, upgrades, value['continuation'])
    return value


def finish_installed(value, payload, handle):
    # Refresh and continue independently of the local retirement sweep.
    value = {**value, 'cleanup': []}
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        refreshed = normal_installer(handle)
        if refreshed.get('status') != 'installed':
            return {**value, 'continuation': {**refreshed, 'status': 'pending',
                                             'results': []}}, 0
        admin = module_at('nibfin_current_completion',
                          MANAGER / 'scripts/core-rollout-admin.py')
        value = continue_installed(value, handle, json.loads(payload).get('target'),
                                   admin)
        return value, admin.RESULTS.result_exit(value)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {**value, 'continuation': {'status': 'pending', 'results': [],
                                          'code': 'CORE_MANAGEMENT_PUBLICATION_RETRY'}}, 0
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)


def run(payload, handle, kind):
    value, code = fresh_manager_result(payload, handle, kind)
    if kind in ('upgrade-complete', 'upgrade-receive'):
        value, code = continue_upgrade(value, handle, code)
        return upgrade_action_result(value, code) if kind == 'upgrade-receive' else (
            value, code)
    if (kind in ('maintenance', 'administrator') and
            value.get('code') == 'CORE_ONLY_MAINTENANCE_REQUIRED'):
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            upgrade_request(handle, kind='upgrade-promotion-unsupported',
                            activation=json.loads(payload)['target'])
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            # Preserve the verified maintenance outcome if projection can retry.
            pass
    if value.get('installation') == 'complete':
        # The old management child has exited. The live source is already
        # adopted and verified; its same installer updates management code,
        # without running Core promotion or Runner registration again.
        try:
            value, code = finish_installed(value, payload, handle)
        finally:
            cleanup = retire_packages(handle)
        return {**value, 'cleanup': cleanup}, code
    return value, code


def main():
    if os.getuid() != 0 or len(sys.argv) != 1:
        raise ValueError('Expected fixed administrator invocation')
    payload = sys.stdin.buffer.read()
    supplied = json.loads(payload)
    kind = supplied.get('kind')
    if kind not in ('pre-worker', 'maintenance', 'administrator', 'prepare',
                    'inspect', *UPGRADE_KINDS):
        return {'status': 'denied', 'code': 'CORE_MAINTENANCE_REQUEST_INVALID'}, 1
    owned(CONFIG)
    handle = os.open(CONFIG, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if handle != 3:
        os.dup2(handle, 3)
        os.close(handle)
        handle = 3
    try:
        mode = fcntl.LOCK_SH if kind in SHARED_KINDS else fcntl.LOCK_EX
        fcntl.flock(handle, mode | fcntl.LOCK_NB)
        return run(payload, handle, kind)
    finally:
        os.close(handle)


if __name__ == '__main__':
    try:
        outcome, exit_status = main()
    except BlockingIOError:
        outcome, exit_status = {'status': 'pending',
                               'code': 'CORE_MANAGEMENT_OPERATION_PENDING'}, 2
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        outcome, exit_status = {'status': 'pending',
                               'code': 'CORE_MAINTENANCE_BRIDGE_RETRY'}, 2
    print(json.dumps(outcome))
    if exit_status:
        print(json.dumps(outcome), file=sys.stderr)
    sys.exit(exit_status)
