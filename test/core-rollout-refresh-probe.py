"""Exercise the actual runtime's trusted failure class and refresh control flow."""
import sys
sys.dont_write_bytecode = True

import base64
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('refresh_admin',
    ROOT / 'scripts/core-rollout-admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)
head = 'a' * 40
branch = 'cd/consumers-' + 'a' * 12 + '-' + 'b' * 12
pr = {'number': 1, 'headRefOid': head}

for stage in ('GET', 'PUT'):
    for result in ({'status': 'pending', 'code': 'GITHUB_API_RETRY_PENDING',
                    'githubApi': {'kind': 'http', 'httpStatus': 422}},
                   {'status': 'denied', 'code': 'INVALID_ROLLOUT_PROVIDER_REQUEST'}):
        writes = []

        def provider(*args, request=None):
            method = 'PUT' if '--method' in request else 'GET'
            if method == 'PUT':
                writes.append(request)
            if method == stage:
                raise admin.RESULTS.CoreRolloutFailure(result)
            value = {'number': 1, 'state': 'open', 'draft': False,
                     'base': {'ref': 'main', 'repo': {'full_name': 'owner/repo'}},
                     'head': {'ref': branch, 'sha': head,
                              'repo': {'full_name': 'owner/repo'}},
                     'mergeable': True, 'mergeable_state': 'behind'}
            return {'bytes': base64.b64encode(json.dumps(value).encode()).decode()}

        admin.bridge = provider
        runtime = admin.load_runtime()
        try:
            runtime.refresh_consumer('owner/repo', branch, pr)
            raise AssertionError('Typed provider failure was swallowed')
        except admin.RESULTS.CoreRolloutFailure as error:
            assert error.result == result
        assert len(writes) == (1 if stage == 'PUT' else 0)
        if stage == 'PUT':
            runtime.refresh_consumer('owner/repo', branch, pr)
            assert len(writes) == 1

observations, writes = [], []


def unknown_write(*args, request=None):
    if '--method' in request:
        writes.append(request)
        raise RuntimeError('local response lost')
    observations.append(request)
    value = {'number': 1, 'state': 'open', 'draft': False,
             'base': {'ref': 'main', 'repo': {'full_name': 'owner/repo'}},
             'head': {'ref': branch, 'sha': head if not writes else 'c' * 40,
                      'repo': {'full_name': 'owner/repo'}},
             'mergeable': True, 'mergeable_state': 'behind'}
    return {'bytes': base64.b64encode(json.dumps(value).encode()).decode()}


admin.bridge = unknown_write
runtime = admin.load_runtime()
assert 'uncertainty' in runtime.refresh_consumer('owner/repo', branch, pr)
runtime.refresh_consumer('owner/repo', branch, pr)
assert len(writes) == 1 and len(observations) == 1
runtime = admin.load_runtime()
assert 'head mismatch' in runtime.refresh_consumer('owner/repo', branch, pr)
assert len(writes) == 1 and len(observations) == 2
