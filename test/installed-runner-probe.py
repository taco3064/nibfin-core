"""Real fixture bytes shared with JS; only unchanged Core Node selection is mocked."""

import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
source, slot = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('shared_runtime', source)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
contract = json.loads((source.parent.parent / 'shared-platform.json').read_text())
identity = json.loads((slot / '.nibfin-runner-identity.json').read_text())
local = json.loads((slot / '.runner').read_text())
target = contract['targets'][identity['arch']]


def rejects(operation):
    try:
        operation()
    except (ValueError, OSError):
        return
    raise AssertionError('Expected rejection')


assert runtime.installed_runner_identity(slot, target) == identity
with patch.object(runtime, 'runtime_selection', return_value=('/fixed/node', target)):
    assert runtime.verify_worker(slot / 'bin') == '/fixed/node'

for change in ('arch', 'registration', 'artifact', 'digest'):
    changed = json.loads(json.dumps(identity))
    if change == 'arch':
        changed['arch'] = 'arm64' if identity['arch'] == 'amd64' else 'amd64'
    elif change == 'registration':
        changed['registration']['id'] += 1
    elif change == 'artifact':
        changed['artifact']['url'] = 'https://example.com/untrusted'
    else:
        changed['workerSha256'] = ''
    rejects(lambda: runtime.runner_identity_contract(changed, local, target))

worker = slot / 'bin/Runner.Worker.official'
original = worker.read_bytes()
try:
    worker.write_bytes(original + b'changed')
    with patch.object(runtime, 'runtime_selection', return_value=('/fixed/node', target)):
        rejects(lambda: runtime.verify_worker(slot / 'bin'))
finally:
    worker.write_bytes(original)

record = slot / '.nibfin-runner-identity.json'
original = record.read_bytes()
try:
    record.unlink()
    # Legacy fallback still demands the independently trusted bootstrap digests.
    assert runtime.installed_runner_identity(slot, target) == target
    with patch.object(runtime, 'runtime_selection', return_value=('/fixed/node', target)):
        rejects(lambda: runtime.verify_worker(slot / 'bin'))
finally:
    record.write_bytes(original)
