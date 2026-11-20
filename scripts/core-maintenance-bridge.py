#!/usr/bin/python3 -I
"""Fixed root entry for verified, immutable management packages."""
import sys
sys.dont_write_bytecode = True

from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
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
UPGRADE_KINDS = ('upgrade-prepare', 'upgrade-bind', 'upgrade-observe',
                 'upgrade-complete', 'upgrade-receive')

LIVE_CHECK = '''
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.cwd();
try {
  const verifier = pathToFileURL(join(root, 'src/source-package.mjs'));
  const {verifyInstalledSource} = await import(verifier.href);
  const host = JSON.parse(await readFile('/etc/nibfin/host.json', 'utf8'));
  await verifyInstalledSource(root, host.installation.pin);
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


def command(arguments, payload=None, source=None, descriptors=()):
    if payload and json.loads(payload).get('kind') == 'pre-worker':
        # Only the verified legacy LIVE admission may use this human-only
        # stderr channel. New typed and unknown child stderr stays captured.
        os.dup2(2, 4)
        descriptors = (*descriptors, 4)
    return subprocess.run(arguments, input=payload, capture_output=True,
                          env={**ENV, 'SUDO_UID': os.environ.get('SUDO_UID', '')},
                          pass_fds=descriptors, cwd=source)


@contextmanager
def live_package():
    owned(LIVE)
    handle = os.open(LIVE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        observed = os.fstat(handle)

        def assert_live():
            actual = LIVE.lstat()
            if (actual.st_dev, actual.st_ino) != (observed.st_dev, observed.st_ino):
                raise ValueError('Installed source changed')

        node = runtime_node(LIVE)
        decoder = installer_results(LIVE)
        assert_live()
        pinned = Path('/proc/self/fd') / str(handle)
        checked = command([node, '--input-type=module', '-e', LIVE_CHECK],
                          source=pinned, descriptors=(handle,))
        if decode_result(decoder, checked).get('status') != 'verified':
            raise ValueError('Live source is unavailable')
        assert_live()
        yield node, pinned, decoder, handle
    finally:
        os.close(handle)


def normal_installer():
    if LIVE.is_dir():
        with live_package() as (node, source, decoder, handle):
            if (source / 'src/core-maintenance-installation.json').is_file():
                completed = command([node, str(source / 'bin/nibfin-core.mjs'),
                                     'install-core-rollout-manager'], source=source,
                                    descriptors=(handle,))
                return decode_result(decoder, completed)
    # First bootstrap may precede the live Core's new command. It is still the
    # normal fixed, verified administrator package, not a requested source path.
    node = runtime_node(BOOTSTRAP)
    completed = command([node,
                         str(BOOTSTRAP / 'scripts/core-maintenance-bootstrap.mjs')])
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


def selected_manager():
    pointer = BASE / 'current-manager.json'
    try:
        owned(pointer)
    except FileNotFoundError:
        return MANAGER
    info = pointer.lstat()
    selected = json.loads(pointer.read_text())
    pattern = r'generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            not isinstance(selected, dict) or
            selected.get('schemaVersion') != 1 or
            not re.fullmatch(pattern, selected.get('generation', ''))):
        raise ValueError('Untrusted management selection')
    return BASE / selected['generation'] / 'package'


@contextmanager
def manager_package():
    path = selected_manager()
    owned(path)
    handle = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # A reader that acquired a predecessor before publication keeps an
        # actual descriptor. A reader arriving afterwards uses the new package.
        if selected_manager() != path:
            raise ValueError('Management selection changed before source use')
        yield path
    finally:
        os.close(handle)


def manager_result(payload):
    with manager_package() as root:
        node = runtime_node(root)
        metadata = root.parent / 'runtime.json'
        owned(metadata)
        info = metadata.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
                json.loads(metadata.read_text()) != {'nodePath': node}:
            raise ValueError('Unfinished management runtime publication')
        entry = root / 'src/core-maintenance-bridge-entry.mjs'
        owned(entry)
        results = installer_results(root)
        child = command([node, str(entry)], payload=payload)
        try:
            return results.read_result(child), child.returncode
        except results.CoreRolloutFailure as error:
            return error.result, results.result_exit(error.result)


def fresh_manager_result(payload, kind):
    try:
        value, code = manager_result(payload)
    except FileNotFoundError:
        value, code = {'status': 'pending', 'code': 'ENOENT'}, 2
    except ValueError:
        # This is not permission to overwrite a foreign source. The normal
        # installer independently verifies the adopted LIVE and existing full
        # manager before publishing; incompatible or changed bytes remain denied.
        value, code = {'status': 'pending',
                       'code': 'CORE_MANAGEMENT_RUNTIME_UNAVAILABLE'}, 2
    if (kind != 'prepare' or value.get('code') not in REPAIRABLE or
            selected_manager() != MANAGER or not local_administrator()):
        return value, code
    # This only finishes deployment of the actual adopted management source.
    # It grants no job, promotion or workflow-target authority. Admission is
    # performed afresh after repair, with the original private request.
    repaired = normal_installer()
    if repaired.get('status') != 'installed':
        return repaired, 1 if repaired.get('status') == 'denied' else 2
    return manager_result(payload)


def local_administrator():
    host_file = CONFIG / 'host.json'
    owned(host_file)
    host = json.loads(host_file.read_text())
    uid = os.environ.get('SUDO_UID', '0')
    return (re.fullmatch(r'0|[1-9][0-9]*', uid) is not None and
            int(uid) not in (host['runnerUid'],
                host['sharedRunner']['additionalRunner']['uid']) and
            not re.search(r'nibfin-shared-runner@(?:1|2)\.service',
                          Path('/proc/self/cgroup').read_text()))


def retire_packages():
    try:
        with live_package() as (node, pinned, decoder, handle):
            entry = pinned / 'src/core-package-retirement-entry.mjs'
            result = subprocess.run([node, str(entry)], cwd=pinned, pass_fds=(handle,),
                                    capture_output=True, env=ENV)
            value = decode_result(decoder, result)
        if value.get('status') == 'complete' and isinstance(value.get('cleanup'), list):
            return value['cleanup']
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return [{'status': 'retained', 'code': 'PACKAGE_OBSERVATION_UNAVAILABLE'}]


def upgrade_request(**request):
    result, _ = manager_result(json.dumps(request).encode())
    return result


def ready_upgrade(value):
    return (value.get('continuationEligible') is True and
            value.get('readiness') in ('ready', 'not-required'))


def settle_upgrades(operations, continuation):
    results = []
    for item in operations:
        if ready_upgrade(item):
            outcome = upgrade_request(kind='upgrade-settle',
                                      operationId=item['operationId'],
                                      result=continuation)
            if outcome and outcome.get('upgrade'):
                item = outcome['upgrade']
        results.append(item)
    return results


def continue_upgrade(value, code):
    upgrade = value.get('upgrade')
    if not upgrade or not ready_upgrade(upgrade):
        return value, code
    with manager_package() as root:
        admin = module_at('nibfin_current_completion',
                          root / 'scripts/core-rollout-admin.py')
        observed = admin.continue_installed({'status': 'installed'})
    continuation = observed['continuation']
    updated, = settle_upgrades([upgrade], continuation)
    return {**value, 'upgrade': updated}, code


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


def continue_installed(value, activation, admin):
    if not activation:
        return admin.continue_installed(value)
    matched = upgrade_request(kind='upgrade-installed', activation=activation)
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
    value = admin.continue_installed(value)
    if upgrades:
        value['upgradeOperations'] = settle_upgrades(
            upgrades, value['continuation'])
    return value


def finish_installed(value, payload):
    # Refresh and continue independently of the local retirement sweep.
    value = {**value, 'cleanup': []}
    try:
        refreshed = normal_installer()
        if refreshed.get('status') != 'installed':
            return {**value, 'continuation': {**refreshed, 'status': 'pending',
                                             'results': []}}, 0
        with manager_package() as root:
            admin = module_at('nibfin_current_completion',
                              root / 'scripts/core-rollout-admin.py')
            value = continue_installed(value, json.loads(payload).get('target'), admin)
            return value, admin.RESULTS.result_exit(value)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {**value, 'continuation': {'status': 'pending', 'results': [],
                                          'code': 'CORE_MANAGEMENT_PUBLICATION_RETRY'}}, 0


def run(payload, kind):
    value, code = fresh_manager_result(payload, kind)
    if kind in ('upgrade-complete', 'upgrade-receive'):
        value, code = continue_upgrade(value, code)
        return upgrade_action_result(value, code) if kind == 'upgrade-receive' else (
            value, code)
    if (kind in ('maintenance', 'administrator') and
            value.get('code') == 'CORE_ONLY_MAINTENANCE_REQUIRED'):
        try:
            upgrade_request(kind='upgrade-promotion-unsupported',
                            activation=json.loads(payload)['target'])
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            # Preserve the verified maintenance outcome if projection can retry.
            pass
    local_promotion = kind == 'administrator' and not json.loads(payload).get('coreOnly')
    if value.get('installation') == 'complete' and (
            kind == 'maintenance' or local_promotion):
        # The old management child has exited. The live source is already
        # adopted and verified; its same installer updates management code,
        # without running Core promotion or Runner registration again.
        try:
            value, code = finish_installed(value, payload)
        finally:
            cleanup = retire_packages()
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
    return run(payload, kind)


if __name__ == '__main__':
    try:
        outcome, exit_status = main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        outcome, exit_status = {'status': 'pending',
                               'code': 'CORE_MAINTENANCE_BRIDGE_RETRY'}, 2
    print(json.dumps(outcome))
    if exit_status:
        print(json.dumps(outcome), file=sys.stderr)
    sys.exit(exit_status)
