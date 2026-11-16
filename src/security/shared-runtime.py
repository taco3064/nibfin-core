#!/usr/bin/python3
"""Verify package-bound Linux runtime bytes before executing any Node code."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys

CORE = Path('/opt/nibfin/core')
HASH_FIELDS = {'runnerArchiveSha256', 'listenerSha256', 'workerSha256',
               'nodeArchiveSha256', 'nodeSha256'}


def require(condition):
    if not condition:
        raise ValueError('Untrusted shared runtime')


def owned(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path)
    for current in (path, *path.parents):
        info = current.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022
                and not stat.S_ISLNK(info.st_mode))


def elf_machine(header):
    require(len(header) >= 64 and header[:7] == b'\x7fELF\x02\x01\x01')
    require(struct.unpack_from('<H', header, 16)[0] in (2, 3)
            and struct.unpack_from('<I', header, 20)[0] == 1)
    return struct.unpack_from('<H', header, 18)[0]


def contract(value, version):
    require(isinstance(value, dict) and set(value) == {
        'schemaVersion', 'runnerVersion', 'nodeVersion', 'targets'})
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['nodeVersion'] == version
            and re.fullmatch(r'\d+\.\d+\.\d+', version, flags=re.ASCII)
            and re.fullmatch(r'\d+\.\d+\.\d+', value['runnerVersion'], flags=re.ASCII))
    require(isinstance(value['targets'], dict)
            and set(value['targets']) == {'amd64', 'arm64'})
    aliases = set()
    for arch, target in value['targets'].items():
        require(isinstance(target, dict) and set(target) == HASH_FIELDS | {
            'artifactArch', 'observations', 'elfMachine'})
        require(target['artifactArch'] == ('x64' if arch == 'amd64' else arch))
        require(type(target['elfMachine']) is int and target['elfMachine'] > 0)
        require(isinstance(target['observations'], list)
                and arch in target['observations']
                and target['artifactArch'] in target['observations'])
        for key in HASH_FIELDS:
            require(isinstance(target[key], str)
                    and re.fullmatch(r'[a-f0-9]{64}', target[key]))
        for alias in target['observations']:
            require(isinstance(alias, str) and re.fullmatch(r'[a-z0-9_]+', alias)
                    and alias not in aliases)
            aliases.add(alias)
    require(value['targets']['amd64']['elfMachine']
            != value['targets']['arm64']['elfMachine'])
    return value


def select(value, system, kernel, executable):
    require(system == 'Linux')
    targets = [target for target in value['targets'].values()
               if kernel in target['observations']]
    require(len(targets) == 1 and targets[0]['elfMachine'] == executable)
    return targets[0]


def verify_executable(path, target, digest):
    owned(path)
    with open(path, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_mode & 0o111 and 64 <= info.st_size <= 512 * 1024 * 1024)
        require(elf_machine(source.read(64)) == target['elfMachine'])
        source.seek(0)
        hasher = hashlib.sha256()
        for chunk in iter(lambda: source.read(256 * 1024), b''):
            hasher.update(chunk)
        require(hasher.hexdigest() == digest)


def verify_worker(directory):
    node, target = runtime_selection()
    verify_executable(directory / 'Runner.Worker.official',
                      target, target['workerSha256'])
    verify_executable(directory / 'Runner.Listener', target, target['listenerSha256'])
    return node


def runtime():
    return runtime_selection()[0]


def runtime_selection():
    for path in (Path(__file__), CORE / 'src/shared-platform.json',
                 CORE / '.node-version'):
        owned(path)
    version = (CORE / '.node-version').read_text(encoding='utf-8').strip()
    value = contract(json.loads((CORE / 'src/shared-platform.json').read_text()), version)
    with open('/proc/self/exe', 'rb') as source:
        executable = elf_machine(source.read(64))
    interpreter = Path(sys.executable).resolve()
    owned(interpreter)
    require(Path('/proc/self/exe').resolve() == interpreter)
    with open(interpreter, 'rb') as source:
        require(elf_machine(source.read(64)) == executable)
    host = os.uname()
    target = select(value, host.sysname, host.machine, executable)
    directory = f"node-v{version}-linux-{target['artifactArch']}"
    node = Path('/opt/nibfin/tools') / directory / 'bin/node'
    verify_executable(node, target, target['nodeSha256'])
    return str(node), target


def main():
    mode, *args = sys.argv[1:]
    node = runtime()
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    if mode == 'controller':
        require(not args)
        environment['PATH'] = str(Path(node).parent) + ':' + environment['PATH']
        environment['NIBFIN_INVOKER_UID'] = os.environ.get('SUDO_UID', '')
        entry = 'bin/nibfin-controller.mjs'
    elif mode == 'start':
        require(len(args) == 1 and args[0] in ('1', '2'))
        entry = 'src/security/shared-runner-start-check.mjs'
    elif mode == 'job':
        require(not args)
        for key in ('GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
                    'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'RUNNER_ENVIRONMENT',
                    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
                    'NIBFIN_TARGET_REPOSITORY_ID'):
            if key in os.environ:
                environment[key] = os.environ[key]
        issue = os.environ.get('NIBFIN_ISSUE', '')
        stage = os.environ.get('NIBFIN_STAGE', '')
        require(re.fullmatch(r'[1-9][0-9]*', issue))
        args = (['dispatch-event', issue] if stage == 'wake'
                else ['stage', issue, stage])
        entry = 'bin/nibfin-core.mjs'
    else:
        raise ValueError('Unknown runtime entry')
    owned(CORE / entry)
    os.chdir(CORE)
    os.execve(node, [node, str(CORE / entry), *args], environment)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        print('Nibfin shared runtime verification failed.', file=sys.stderr)
        sys.exit(1)
