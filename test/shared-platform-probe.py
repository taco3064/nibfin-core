"""Offline bootstrap contract, executable, and fixed launch behavior checks."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('shared_runtime', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value = json.loads((path.parent.parent / 'shared-platform.json').read_text())
module.contract(value, '24.22.1')


def rejects(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError('Expected fail-closed rejection')


def elf(machine):
    header = bytearray(64)
    header[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHI', header, 16, 3, machine, 1)
    return header


for arch, target in value['targets'].items():
    for observation in target['observations']:
        assert module.select(value, 'Linux', observation, target['elfMachine']) == target
    rejects(lambda: module.select(value, 'Darwin', arch, target['elfMachine']))
    rejects(lambda: module.select(value, 'Linux', arch, 99))
    with tempfile.TemporaryDirectory(prefix='nibfin-platform-') as directory:
        node = Path(directory) / 'node'
        data = elf(target['elfMachine'])
        node.write_bytes(data)
        node.chmod(0o755)
        digest = hashlib.sha256(data).hexdigest()
        with patch.object(module, 'owned'):
            module.verify_executable(node, target, digest)
            rejects(lambda: module.verify_executable(node, target, 'a' * 64))
            wrong = elf(183 if arch == 'amd64' else 62)
            node.write_bytes(wrong)
            rejects(lambda: module.verify_executable(
                node, target, hashlib.sha256(wrong).hexdigest()))
            node.write_bytes(data)
            node.chmod(0o644)
            rejects(lambda: module.verify_executable(node, target, digest))

for change in ('missing', 'extra', 'incomplete', 'overlap'):
    changed = json.loads(json.dumps(value))
    if change == 'missing':
        del changed['targets']['arm64']
    elif change == 'extra':
        changed['targets']['unknown'] = changed['targets']['amd64']
    elif change == 'incomplete':
        del changed['targets']['arm64']['nodeSha256']
    else:
        changed['targets']['arm64']['observations'].append('x64')
    rejects(lambda: module.contract(changed, '24.22.1'))
rejects(lambda: module.contract(value, '24.22.0'))
rejects(lambda: module.select(value, 'Linux', 'riscv64', 62))

# Read native interpreter/kernel; mock installation ownership and the absent Node file.
with patch.object(module, 'CORE', path.parent.parent.parent), \
        patch.object(module, 'owned'), \
        patch.object(module, 'verify_executable') as verify:
    selected, target = module.runtime_selection()
    assert selected.endswith(f"linux-{target['artifactArch']}/bin/node")
    verify.assert_called_once()

with patch.object(module, 'CORE', path.parent.parent.parent), \
        patch.object(module, 'owned'), \
        patch.object(sys, 'executable', str(path)):
    rejects(module.runtime_selection)

# Observe exec arguments; no host runtime or privileged installation is invoked.
for arch in value['targets']:
    artifact = value['targets'][arch]['artifactArch']
    node = f'/opt/nibfin/tools/node-v24.22.1-linux-{artifact}/bin/node'
    for mode, arguments in [('controller', []), ('start', ['2']), ('job', [])]:
        with patch.object(module, 'runtime', return_value=node), \
                patch.object(module, 'owned'), patch.object(module.os, 'chdir'), \
                patch.object(module.os, 'execve') as execute, \
                patch.dict(os.environ, {'GOARCH': 'riscv64', 'NODE_OPTIONS': '--inspect',
                           'SUDO_UID': '123', 'NIBFIN_ISSUE': '336',
                           'NIBFIN_STAGE': 'deliver'}, clear=True), \
                patch.object(sys, 'argv', ['bootstrap', mode, *arguments]):
            module.main()
            executable, argv, environment = execute.call_args.args
            assert executable == node and argv[0] == node
            assert 'GOARCH' not in environment and 'NODE_OPTIONS' not in environment
            if mode == 'controller':
                assert argv[1:] == [str(module.CORE / 'bin/nibfin-controller.mjs')]
                assert environment['NIBFIN_INVOKER_UID'] == '123'
            elif mode == 'start':
                assert argv[-1] == '2'
            else:
                assert argv[2:] == ['stage', '336', 'deliver']

with patch.object(module, 'runtime', return_value='/fixed/node'), \
        patch.object(module.os, 'execve') as execute:
    for args in (['controller', '/caller/node'], ['start', '3'],
                 ['job', '/caller/node'], ['unknown']):
        with patch.object(sys, 'argv', ['bootstrap', *args]):
            rejects(module.main)
    execute.assert_not_called()

with patch.object(module, 'runtime', return_value='/fixed/node'), \
        patch.object(module, 'owned'), patch.object(module.os, 'chdir'), \
        patch.object(module.os, 'execve') as execute, \
        patch.dict(os.environ, {'NIBFIN_ISSUE': '336', 'NIBFIN_STAGE': 'wake'},
                   clear=True), patch.object(sys, 'argv', ['bootstrap', 'job']):
    module.main()
    assert execute.call_args.args[1][2:] == ['dispatch-event', '336']
