"""Forward native Actions locators privately to the fixed administrator bridge."""
import sys
sys.dont_write_bytecode = True

import json
import os
from pathlib import Path
import subprocess

BRIDGE = '/usr/local/libexec/nibfin/core-rollout/bridge.py'


def request(environment, arguments):
    upgrade = len(arguments) == 3 and arguments[0] == 'upgrade'
    locators = arguments[1:] if upgrade else arguments
    if len(locators) != 2 or not all(value.isascii() and value.isdecimal()
                                    and int(value) > 0 for value in locators):
        raise ValueError('Invalid native activation target')
    keys = ('repositoryId', 'pullNumber') if upgrade else ('runId', 'artifactId')
    value = {'kind': 'upgrade-receive' if upgrade else 'maintenance',
        'target': dict(zip(keys, map(int, locators))),
        'runId': int(environment['GITHUB_RUN_ID']),
        'attempt': int(environment['GITHUB_RUN_ATTEMPT']),
        'repository': environment['GITHUB_REPOSITORY'],
        'requestUrl': environment['ACTIONS_ID_TOKEN_REQUEST_URL'],
        'requestToken': environment['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}
    if not upgrade:
        value['githubToken'] = environment['GH_TOKEN']
    return value


def owned(path):
    value = Path(path)
    if value.resolve() != value:
        raise ValueError('Untrusted fixed administrator entry')
    for current in (value, *value.parents):
        info = current.lstat()
        if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted fixed administrator entry')


def main():
    payload = request(os.environ, sys.argv[1:])
    owned('/usr/bin/sudo')
    owned(BRIDGE)
    result = subprocess.run(['/usr/bin/sudo', '-n', '--', BRIDGE],
                            input=json.dumps(payload).encode(),
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('CORE_MAINTENANCE_CLIENT_UNAVAILABLE', file=sys.stderr)
        sys.exit(2)
