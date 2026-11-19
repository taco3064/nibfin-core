#!/usr/bin/python3
"""Receive workspace copies and run the Codex executor inside a disposable VM."""

import base64
import selectors
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import threading
from pathlib import Path

WORKSPACE_PORT = 4020
EXEC_PORT = 4021
EGRESS_PORT = 4022
PROXY_PORT = 3128
MAX_FRAME = 96 * 1024 * 1024
MAX_TREE = 64 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_ENTRIES = 10000
CODEX = "/usr/local/bin/codex"
ROOTS = ("work", "main", "input")
TOOL_OUTPUT = {}
ENV = {
    "HOME": "/tmp/tool-home",
    "PATH": "/opt/nibfin/project/bin:/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "DOCKER_HOST": "tcp://127.0.0.1:2375",
    "HTTP_PROXY": "http://127.0.0.1:3128",
    "HTTPS_PROXY": "http://127.0.0.1:3128",
}


def safe_path(value):
    return re.fullmatch(r"[A-Za-z0-9_.-][A-Za-z0-9_./-]*", value) and all(
        part.lower() not in ("", ".", "..", ".git") for part in value.split("/")
    )


def restore(root, files):
    size = 0
    if not isinstance(files, list) or len(files) > MAX_ENTRIES:
        raise ValueError("Invalid workspace")
    for item in files:
        name = item["path"]
        if not safe_path(name):
            raise ValueError("Invalid workspace path")
        data = base64.b64decode(item["content"], validate=True)
        size += len(data)
        if size > MAX_TREE or len(data) > MAX_FILE:
            raise ValueError("Workspace too large")
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
        target.chmod(0o755 if item["executable"] else 0o644)


def snapshot(root, excluded=None):
    excluded_path = None
    if excluded:
        for observed in (excluded["parent"], excluded["root"]):
            path = root / observed["path"]
            try:
                actual = directory_identity(path)
            except FileNotFoundError:
                # Removed scratch has no contents to omit from collection.
                break
            if (actual["dev"], actual["ino"]) != (observed["dev"], observed["ino"]):
                raise ValueError("Tool output directory changed")
        else:
            excluded_path = excluded["path"]
    files = []
    size = 0
    entries = 0
    for directory, dirs, names in os.walk(root, followlinks=False):
        if excluded_path:
            dirs[:] = [name for name in dirs
                       if (Path(directory, name).relative_to(root).as_posix()
                           != excluded_path)]
        for name in sorted(dirs + names):
            entries += 1
            path = Path(directory, name)
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if not safe_path(relative) or entries > MAX_ENTRIES:
                raise ValueError("Invalid workspace path")
            if stat.S_ISDIR(info.st_mode):
                continue
            size += info.st_size
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > MAX_FILE
                or size > MAX_TREE
            ):
                raise ValueError("Invalid workspace file")
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
                data = stream.read(info.st_size + 1)
            if len(data) != info.st_size:
                raise ValueError("Workspace changed during transfer")
            files.append({
                "path": relative,
                "executable": bool(info.st_mode & 0o111),
                "content": base64.b64encode(data).decode("ascii"),
            })
    return files


def directory_identity(path):
    observed = path.lstat()
    if not stat.S_ISDIR(observed.st_mode) or path.resolve() != path:
        raise ValueError("Tool output directory changed")
    return {"dev": observed.st_dev, "ino": observed.st_ino}


def prepare_tool_output(root, temporary, directories):
    if not safe_path(temporary) or not isinstance(directories, list):
        raise ValueError("Invalid tool output")
    if any(not safe_path(directory) or not directory.startswith(temporary + "/")
           for directory in directories):
        raise ValueError("Invalid tool directory")
    owned = not (root / temporary).exists()
    for directory in directories:
        (root / directory).mkdir(parents=True, exist_ok=True)
    if not owned:
        return None
    parent = Path(temporary).parent.as_posix()
    return {"path": temporary,
            "parent": {"path": parent, **directory_identity(root / parent)},
            "root": {"path": temporary, **directory_identity(root / temporary)}}


def workspace(client):
    with client.makefile("rb") as stream:
        frame = stream.readline(MAX_FRAME + 1)
    if not frame.endswith(b"\n") or len(frame) > MAX_FRAME:
        return
    try:
        request = json.loads(frame)
        if request["operation"] == "prepare":
            name = request["name"]
            if name not in ROOTS:
                raise ValueError("Unsupported workspace root")
            root = Path("/") / name
            if root.exists():
                shutil.rmtree(root)
            root.mkdir()
            restore(root, request["files"])
            TOOL_OUTPUT.pop(name, None)
            if name == "work" and "toolRoot" in request:
                # Exclude only a new execution-owned directory. Existing source
                # files never become disposable just because of their name.
                TOOL_OUTPUT[name] = prepare_tool_output(
                    root, request["toolRoot"], request["toolDirectories"])
            Path(ENV["HOME"]).mkdir(parents=True, exist_ok=True)
            result = {"ready": True}
        elif request["operation"] == "collect":
            result = {"files": snapshot(Path("/work"), TOOL_OUTPUT.get("work"))}
        else:
            raise ValueError("Unsupported workspace operation")
    except (ValueError, OSError, KeyError, TypeError):
        result = {"error": "JOB_VM_WORKSPACE_TRANSFER_FAILED"}
    client.sendall(json.dumps(result, separators=(",", ":")).encode() + b"\n")


def execute(client):
    subprocess.run(
        [CODEX, "exec-server", "--listen", "stdio"],
        stdin=client,
        stdout=client,
        cwd="/session",
        env=ENV,
        check=False,
    )


def relay(client, family, address):
    with client, socket.socket(family, socket.SOCK_STREAM) as upstream:
        upstream.settimeout(15)
        upstream.connect(address)
        client.settimeout(15)
        with selectors.DefaultSelector() as selector:
            selector.register(client, selectors.EVENT_READ, upstream)
            selector.register(upstream, selectors.EVENT_READ, client)
            while True:
                for event, _ in selector.select():
                    chunk = event.fileobj.recv(65536)
                    if not chunk:
                        return
                    event.data.sendall(chunk)


def loopback(port, family, address):
    with socket.create_server(("127.0.0.1", port)) as server:
        slots = threading.BoundedSemaphore(32)
        while True:
            client, _ = server.accept()
            if not slots.acquire(blocking=False):
                client.close()
                continue

            def forward(connection):
                try:
                    relay(connection, family, address)
                except OSError:
                    pass
                finally:
                    slots.release()

            threading.Thread(target=forward, args=(client,), daemon=True).start()


def listen(port, handler):
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as server:
        server.bind((socket.VMADDR_CID_ANY, port))
        server.listen(1)
        while True:
            client, (cid, _) = server.accept()
            with client:
                if cid != socket.VMADDR_CID_HOST:
                    continue
                try:
                    handler(client)
                except OSError:
                    continue


if __name__ == "__main__":
    os.umask(0o077)
    Path("/session").mkdir(exist_ok=True)
    threading.Thread(target=listen, args=(EXEC_PORT, execute), daemon=True).start()
    for port, family, address in (
        (PROXY_PORT, socket.AF_VSOCK, (socket.VMADDR_CID_HOST, EGRESS_PORT)),
        (2375, socket.AF_UNIX, "/run/nibfin-docker/docker.sock"),
    ):
        threading.Thread(
            target=loopback, args=(port, family, address), daemon=True
        ).start()
    listen(WORKSPACE_PORT, workspace)
