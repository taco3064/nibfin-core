#!/usr/bin/python3
"""Admit a GitHub Runner 2.338.2 message before exec'ing its official Worker."""
import sys
sys.dont_write_bytecode = True


import ctypes
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import syslog

CORE = Path("/opt/nibfin/core")
BRIDGE = Path('/usr/local/libexec/nibfin/core-rollout/bridge.py')
PR_SET_PDEATHSIG = 1


class AdmissionFailure(ValueError):
    def __init__(self, code, status=None, api_status=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.api_status = api_status


def check_bridge_admission(result):
    # This pipe belongs to the installed bridge. Log neither raw output nor frame data.
    invalid = 'CORE_PRE_WORKER_BRIDGE_RESPONSE_UNAVAILABLE'
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise AdmissionFailure(invalid) from None
    if not isinstance(value, dict):
        raise AdmissionFailure(invalid)
    status = value.get('status')
    if result.returncode == 0 and status == 'admitted':
        return
    code = value.get('code')
    if ((status, result.returncode) not in (('pending', 2), ('denied', 1))
            or not isinstance(code, str) or not re.fullmatch('[A-Z][A-Z0-9_]*', code)):
        raise AdmissionFailure(invalid)
    api = value.get('githubApi')
    http = api.get('httpStatus') if isinstance(api, dict) else None
    if type(http) is not int or not 400 <= http <= 599 or api.get('kind') != 'http':
        http = None
    raise AdmissionFailure(code, status, http)


def report_failure(failure):
    diagnostic = f'pre-worker admission code={failure.code}'
    if failure.status is not None:
        diagnostic += f' status={failure.status}'
    if failure.api_status is not None:
        diagnostic += f' github_http_status={failure.api_status}'
    try:
        syslog.openlog('nibfin-worker-dispatch', syslog.LOG_PID)
        syslog.syslog(syslog.LOG_WARNING, diagnostic)
    except OSError:
        pass
    print(f'Nibfin did not admit the Runner job: {diagnostic}', file=sys.stderr)


def exact_read(source, size):
    data = bytearray()
    while len(data) < size:
        chunk = os.read(source, min(65536, size - len(data)))
        if not chunk:
            raise AdmissionFailure('SHARED_WORKER_FRAME_INCOMPLETE')
        data.extend(chunk)
    return data


def exit_with_parent(parent):
    libc = ctypes.CDLL(None)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        os._exit(1)
    if os.getppid() != parent:
        os._exit(1)


def forward(source, destination, frame, parent):
    exit_with_parent(parent)
    try:
        with os.fdopen(destination, "wb", buffering=0) as channel:
            write_all(channel, frame)
            while chunk := os.read(source, 65536):
                write_all(channel, chunk)
    except OSError:
        os._exit(1)
    os._exit(0)


def write_all(channel, bytes_):
    view = memoryview(bytes_)
    while view:
        view = view[channel.write(view):]


def admit(source):
    header = exact_read(source, 8)
    message_type, length = struct.unpack("<ii", header)
    if message_type != 1 or length <= 0 or length > 50_000_000 or length % 2:
        raise AdmissionFailure('SHARED_WORKER_FRAME_INVALID')
    body = exact_read(source, length)
    if BRIDGE.exists() or BRIDGE.is_symlink():
        parent = os.getpid()
        result = subprocess.run(
            ['/usr/bin/sudo', '-n', '--', str(BRIDGE)],
            input=json.dumps({'kind': 'pre-worker',
                              'frame': base64.b64encode(body).decode()}).encode(),
            stdout=subprocess.PIPE, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
            preexec_fn=lambda: exit_with_parent(parent),
        )
        check_bridge_admission(result)
        return header + body
    # Fresh installation may register the official slots before adopting the
    # pool and installing its administrator bridge. Ordinary admission keeps its
    # existing path; no maintenance job gains authority through this fallback.
    path = CORE / 'src/security/shared-runtime.py'
    spec = importlib.util.spec_from_file_location('shared_runtime', path)
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    node = runtime.verify_worker(Path.cwd())
    parent = os.getpid()
    subprocess.run(
        [node, str(CORE / "src/security/shared-worker-entry.mjs")],
        input=body, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdout=subprocess.DEVNULL, check=True,
        preexec_fn=lambda: exit_with_parent(parent),
    )
    return header + body


def main():
    command, source_pipe, reply_pipe = sys.argv[1:]
    source, reply = int(source_pipe), int(reply_pipe)
    if command != "spawnclient" or min(source, reply) < 3 or source == reply:
        raise AdmissionFailure('SHARED_WORKER_INVOCATION_INVALID')
    drain = Path('/etc/nibfin/managed-pool-drain.json')
    if drain.exists() or drain.is_symlink():
        raise AdmissionFailure('SHARED_WORKER_POOL_DRAINING')
    frame = admit(source)
    if drain.exists() or drain.is_symlink():
        raise AdmissionFailure('SHARED_WORKER_POOL_DRAINING')
    if select.select([source], [], [], 0)[0]:
        raise AdmissionFailure('SHARED_WORKER_CANCELLED_DURING_ADMISSION')
    worker = Path.cwd() / "Runner.Worker.official"
    receiver, sender = os.pipe()
    wrapper_pid = os.getpid()
    if os.fork() == 0:
        os.close(receiver)
        os.close(reply)
        for fd in (0, 1, 2):
            os.close(fd)
        forward(source, sender, frame, wrapper_pid)
    os.close(sender)
    os.close(source)
    os.set_inheritable(receiver, True)
    os.set_inheritable(reply, True)
    # The Listener continues to supervise the same PID after Worker starts.
    if drain.exists() or drain.is_symlink():
        raise AdmissionFailure('SHARED_WORKER_POOL_DRAINING')
    os.execv(worker, [str(worker), "spawnclient", str(receiver), str(reply)])


def dispatch():
    try:
        main()
    except AdmissionFailure as error:
        report_failure(error)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError):
        report_failure(AdmissionFailure('SHARED_WORKER_ADMISSION_UNAVAILABLE'))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(dispatch())
