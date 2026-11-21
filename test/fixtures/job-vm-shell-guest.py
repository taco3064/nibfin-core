"""Controlled Claude guest shell: the maintained executor handler on a Unix socket.

Simulated: no VM or vsock. The guest's /work is relocated into a fixture
directory, and a fixture cgroup directory with a process-group kill stands in
for cgroup v2 (see test/job-vm-shell.test.py).
argv: <socket> <guest work directory> <cgroup directory> <request log>
"""
import sys
sys.dont_write_bytecode = True

import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import threading

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'executor', ROOT / 'src/security/job-vm-executor.py')
EXECUTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXECUTOR)
path, work, cgroup, log = sys.argv[1:5]
directory, cwd = EXECUTOR.shell_directory, EXECUTOR.read_cwd


def relocated_directory(value):
    if isinstance(value, str) and (value == "/work" or value.startswith("/work/")):
        value = work + value[5:]
    return directory(value)


def relocated_cwd(name):
    value = cwd(name)
    if value and (value == work or value.startswith(work + "/")):
        value = "/work" + value[len(work):]
    return value


def create_leaf():
    EXECUTOR.SHELL_CGROUP.mkdir(exist_ok=True)
    leaf = EXECUTOR.SHELL_CGROUP / os.urandom(4).hex()
    leaf.mkdir()
    for name in ("cgroup.kill", "cgroup.procs"):
        (leaf / name).write_text("")
    return leaf


def kill_leaf(leaf):
    for session in list(EXECUTOR.SHELL["live"]):
        if session.leaf == leaf:
            try:
                os.killpg(session.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


shell = EXECUTOR.shell


class Logged:
    """Socket wrapper recording the request line before the handler sees it."""

    def __init__(self, client):
        self.client = client
        self.logged = False
        self.data = b""

    def recv(self, size):
        chunk = self.client.recv(size)
        if not self.logged:
            self.data += chunk
            if b"\n" in self.data or not chunk:
                self.logged = True
                with open(log, "ab") as stream:
                    stream.write(self.data.split(b"\n")[0] + b"\n")
        return chunk

    def __getattr__(self, name):
        return getattr(self.client, name)


EXECUTOR.SHELL_WORK = work
EXECUTOR.SHELL_CGROUP = Path(cgroup)
EXECUTOR.shell_directory = relocated_directory
EXECUTOR.read_cwd = relocated_cwd
EXECUTOR.create_leaf = create_leaf
EXECUTOR.kill_leaf = kill_leaf
EXECUTOR.shell = lambda client: shell(Logged(client))
connections = threading.BoundedSemaphore(EXECUTOR.SHELL_SESSIONS + 1)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
    server.bind(path)
    server.listen(EXECUTOR.SHELL_SESSIONS)
    print("ready", flush=True)
    while True:
        client, _ = server.accept()
        EXECUTOR.admit_shell(client, connections)
