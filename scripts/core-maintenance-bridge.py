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


def process_result(root, completed):
    helper = root / 'scripts/core_rollout_result.py'
    if not helper.is_file():
        # A legacy LIVE predates typed reporting; the normal verified bootstrap
        # supplies the shared decoder, without treating free stderr as authority.
        helper = BOOTSTRAP / 'scripts/core_rollout_result.py'
    results = module_at('nibfin_installer_results', helper)
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
    child = command([node, str(entry)], handle, payload)
    results = module_at('nibfin_bridge_results',
                        MANAGER / 'scripts/core_rollout_result.py')
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
    if kind == 'pre-worker':
        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
    return manager_result(payload, handle)


def run(payload, handle, kind):
    value, code = fresh_manager_result(payload, handle, kind)
    if value.get('installation') == 'complete':
        # The old management child has exited. The live source is already
        # adopted and verified; its same installer updates management code,
        # without running Core promotion or Runner registration again.
        try:
            refreshed = normal_installer(handle)
            if refreshed.get('status') != 'installed':
                return {**value, 'continuation': {**refreshed, 'status': 'pending',
                                                 'results': []}}, 0
            admin = module_at('nibfin_current_completion',
                              MANAGER / 'scripts/core-rollout-admin.py')
            value = admin.continue_after_gate(value, handle)
            return value, admin.RESULTS.result_exit(value)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            value = {**value, 'continuation': {'status': 'pending', 'results': [],
                     'code': 'CORE_MANAGEMENT_PUBLICATION_RETRY'}}
            return value, 0
    return value, code


def main():
    if os.getuid() != 0 or len(sys.argv) != 1:
        raise ValueError('Expected fixed administrator invocation')
    payload = sys.stdin.buffer.read()
    supplied = json.loads(payload)
    kind = supplied.get('kind')
    if kind not in ('pre-worker', 'maintenance', 'administrator', 'prepare', 'inspect'):
        return {'status': 'denied', 'code': 'CORE_MAINTENANCE_REQUEST_INVALID'}, 1
    owned(CONFIG)
    handle = os.open(CONFIG, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if handle != 3:
        os.dup2(handle, 3)
        os.close(handle)
        handle = 3
    try:
        mode = fcntl.LOCK_SH if kind in ('pre-worker', 'inspect') else fcntl.LOCK_EX
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
