#!/usr/bin/python3
"""Admit a GitHub Runner 2.338.2 message before exec'ing its official Worker."""

import ctypes
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys

CORE = Path("/opt/nibfin/core")
PR_SET_PDEATHSIG = 1


def exact_read(source, size):
    data = bytearray()
    while len(data) < size:
        chunk = os.read(source, min(65536, size - len(data)))
        if not chunk:
            raise ValueError("Incomplete Runner frame")
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
        raise ValueError("Invalid Runner frame")
    body = exact_read(source, length)
    version = (CORE / ".node-version").read_text(encoding="utf-8").strip()
    if len(version.split(".")) != 3 or not all(x.isascii() and x.isdigit()
                                               for x in version.split(".")):
        raise ValueError("Invalid Core runtime pin")
    node = f"/opt/nibfin/tools/node-v{version}-linux-x64/bin/node"
    parent = os.getpid()
    subprocess.run(
        [node, str(CORE / "src/security/shared-worker-entry.mjs")],
        input=body, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=45,
        preexec_fn=lambda: exit_with_parent(parent),
    )
    return header + body


def main():
    command, source_pipe, reply_pipe = sys.argv[1:]
    source, reply = int(source_pipe), int(reply_pipe)
    if command != "spawnclient" or min(source, reply) < 3 or source == reply:
        raise ValueError("Invalid Runner invocation")
    frame = admit(source)
    if select.select([source], [], [], 0)[0]:
        raise ValueError("Runner was cancelled during admission")
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
    os.execv(worker, [str(worker), "spawnclient", str(receiver), str(reply)])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Nibfin did not admit the Runner job.", file=sys.stderr)
        sys.exit(1)
