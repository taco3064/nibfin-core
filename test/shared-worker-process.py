"""Exercise the real Linux descriptor and exec path without a registration."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
from unittest.mock import patch


WORKER = r"""import os
import sys
source, reply = map(int, sys.argv[2:])
assert os.read(source, 12) == bytes.fromhex('01000000040000007b007d00')
os.write(reply, f'{os.getpid()}\n'.encode())
assert os.read(source, 8) == bytes.fromhex('0200000000000000')
if os.environ['TEST_MODE'] == 'kill':
    os.read(source, 1)
sys.exit(100)
"""

LAUNCHER = """import importlib.util
import os
import sys
spec = importlib.util.spec_from_file_location('dispatch', sys.argv.pop(1))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def admit(source):
    frame = module.exact_read(source, 12)
    if os.environ['TEST_MODE'] == 'deny':
        raise ValueError('Denied by test policy')
    return frame
module.admit = admit
try:
    module.main()
except ValueError:
    sys.exit(1)
"""


def probe(directory, launch, dispatcher, mode):
    source, author = os.pipe()
    observer, reply = os.pipe()
    os.write(author, struct.pack("<ii", 1, 4) + "{}".encode("utf-16le"))
    cancellation = struct.pack("<ii", 2, 0)
    if mode == "pre-cancel":
        os.write(author, cancellation)
    try:
        with subprocess.Popen(
            [sys.executable, "-I", launch, dispatcher, "spawnclient",
             str(source), str(reply)],
            cwd=directory, pass_fds=[source, reply],
            env={**os.environ, "TEST_MODE": mode},
        ) as process:
            os.close(source)
            os.close(reply)
            try:
                assert select.select([observer], [], [], 3)[0]
                claimed = os.read(observer, 100)
                if mode in ("deny", "pre-cancel"):
                    assert claimed == b""
                    assert process.wait(timeout=3) == 1
                    return
                assert int(claimed) == process.pid
                os.write(author, cancellation)
                if mode == "kill":
                    process.kill()
                    assert process.wait(timeout=3) == -signal.SIGKILL
                    assert os.read(observer, 1) == b""
                else:
                    assert process.wait(timeout=3) == 100
            finally:
                if process.poll() is None:
                    process.kill()
    finally:
        os.close(author)
        os.close(observer)


def probe_diagnostics(dispatcher):
    spec = importlib.util.spec_from_file_location('dispatch', dispatcher)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    pending = {
        'status': 'pending', 'code': 'CORE_MANAGEMENT_OPERATION_PENDING',
        'token': 'private payload',
    }
    denied = {
        'status': 'denied', 'code': 'SHARED_WORKER_JOB_NOT_ASSIGNED',
        'githubApi': {'kind': 'http', 'httpStatus': 422, 'body': 'private payload'},
    }
    malformed = 'CORE_PRE_WORKER_BRIDGE_RESPONSE_UNAVAILABLE'
    cases = [
        (2, json.dumps(pending), 'CORE_MANAGEMENT_OPERATION_PENDING status=pending'),
        (1, json.dumps(denied), 'SHARED_WORKER_JOB_NOT_ASSIGNED status=denied '
         'github_http_status=422'),
        (2, 'private payload', malformed),
        (2, json.dumps({'status': 'admitted'}), malformed),
        (2, json.dumps({**pending, 'code': 'private payload'}), malformed),
    ]
    for code, output, expected in cases:
        result = subprocess.CompletedProcess([], code, stdout=output.encode())
        diagnostic = f'pre-worker admission code={expected}'
        stderr = io.StringIO()
        with patch.object(module, 'main', lambda: module.check_bridge_admission(result)):
            with patch.object(module.syslog, 'syslog') as log:
                with contextlib.redirect_stderr(stderr):
                    assert module.dispatch() == 1
                log.assert_called_once_with(module.syslog.LOG_WARNING, diagnostic)
        assert stderr.getvalue() == f'Nibfin did not admit the Runner job: {diagnostic}\n'
    admitted = subprocess.CompletedProcess([], 0, stdout=b'{"status":"admitted"}')
    module.check_bridge_admission(admitted)


probe_diagnostics(sys.argv[1])
with tempfile.TemporaryDirectory() as directory:
    temp = Path(directory)
    worker = temp / "Runner.Worker.official"
    worker.write_text(f"#!{sys.executable}\n" + WORKER, encoding="utf-8")
    worker.chmod(0o700)
    launch = temp / "launch.py"
    launch.write_text(LAUNCHER, encoding="utf-8")
    for case in ("deny", "pre-cancel", "allow", "kill"):
        probe(temp, launch, sys.argv[1], case)
