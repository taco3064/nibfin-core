"""Controlled runtime dispatch probe; never executes privileged host commands."""

import os
from pathlib import Path
import runpy
import sys
from unittest.mock import patch


namespace = runpy.run_path('src/security/shared-runtime.py')
main = namespace['main']
scope = main.__globals__
root = Path(sys.argv[1])
for folder in ('src', 'bin'):
    (root / folder).mkdir()
    (root / folder / 'owned-source').write_text('fixture')


class Executed(Exception):
    pass


for mode, entry in [('reclaim', 'bin/nibfin-reclaim.mjs'),
                    ('reclaim-install', 'bin/nibfin-reclaim-install.mjs')]:
    checked = []

    def execute(node, args, environment):
        assert node == '/trusted/node'
        assert args == [node, str(root / entry)]
        assert environment == {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        raise Executed()

    with patch.dict(scope, CORE=root, runtime=lambda: '/trusted/node',
                    owned=lambda path: checked.append(path)), \
            patch.object(sys, 'argv', ['shared-runtime.py', mode]), \
            patch.object(os, 'getuid', return_value=0), \
            patch.object(os, 'chdir') as chdir, \
            patch.object(os, 'execve', side_effect=execute):
        try:
            main()
            raise AssertionError('runtime did not execute')
        except Executed:
            pass
        chdir.assert_called_once_with(root)
    assert root / 'src/owned-source' in checked
    assert root / 'bin/owned-source' in checked
    assert root / entry in checked
    assert root / 'package.json' in checked

    def refuse_source(path):
        if path == root / 'src/owned-source':
            raise ValueError('untrusted source')

    with patch.dict(scope, CORE=root, runtime=lambda: '/trusted/node',
                    owned=refuse_source), \
            patch.object(sys, 'argv', ['shared-runtime.py', mode]), \
            patch.object(os, 'getuid', return_value=0), \
            patch.object(os, 'execve') as execve:
        try:
            main()
            raise AssertionError('untrusted source executed')
        except ValueError:
            pass
        execve.assert_not_called()

    for arguments, uid in [([mode, '/caller/target'], 0), ([mode], 1000)]:
        with patch.dict(scope, CORE=root, runtime=lambda: '/trusted/node'), \
                patch.object(sys, 'argv', ['shared-runtime.py', *arguments]), \
                patch.object(os, 'getuid', return_value=uid), \
                patch.object(os, 'execve') as execve:
            try:
                main()
                raise AssertionError('unsafe invocation accepted')
            except ValueError:
                pass
            execve.assert_not_called()

print('Controlled reclamation runtime dispatch passed')
