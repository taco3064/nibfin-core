"""Forward native Actions locators privately to the fixed administrator bridge."""
import sys
sys.dont_write_bytecode = True

import json
import os
from pathlib import Path
import subprocess

BRIDGE = '/usr/local/libexec/nibfin/core-rollout/bridge.py'


def request(environment, arguments):
    if len(arguments) != 2 or not all(value.isascii() and value.isdecimal()
                                     and int(value) > 0 for value in arguments):
        raise ValueError('Invalid native activation target')
    return {'kind': 'maintenance', 'target': {
        'runId': int(arguments[0]), 'artifactId': int(arguments[1])},
        'runId': int(environment['GITHUB_RUN_ID']),
        'attempt': int(environment['GITHUB_RUN_ATTEMPT']),
        'repository': environment['GITHUB_REPOSITORY'],
        'requestUrl': environment['ACTIONS_ID_TOKEN_REQUEST_URL'],
        'requestToken': environment['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
        'githubToken': environment['GH_TOKEN']}


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
