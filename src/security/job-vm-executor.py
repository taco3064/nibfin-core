#!/usr/bin/python3
"""Receive workspace copies and run the Codex executor or Claude shell in a VM."""

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
import time
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


def exercise_readiness(root):
    output = TOOL_OUTPUT.get("work")
    if not output or not output["path"].startswith(".nibfin-cache/"):
        raise ValueError("Readiness requires independently owned tool output")
    path = root / output["path"]
    if directory_identity(path) != {key: output["root"][key]
                                    for key in ("dev", "ino")}:
        raise ValueError("Tool output directory changed")
    with (path / "readiness-output").open("x", encoding="utf-8") as stream:
        stream.write("tool output must not be returned\n")
    return {"written": True}


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
            if name == "work" and "toolRoot" in request:
                result["toolOutput"] = {
                    "root": request["toolRoot"],
                    "directories": [directory for directory in request["toolDirectories"]
                                    if (root / directory).is_dir()],
                    "collection": "preserve-source-omit-owned-output",
                }
        elif request["operation"] == "collect":
            result = {"files": snapshot(Path("/work"), TOOL_OUTPUT.get("work"))}
        elif request == {"operation": "exercise-readiness"}:
            result = exercise_readiness(Path("/work"))
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


# Claude guest shell (Claude executions only). One connection carries one
# command; Codex's exec handler, port and serial listen() above stay unchanged.
class ShellRefused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


SHELL_PORT = 4023
SHELL_SESSIONS = 32
SHELL_OUTPUT = 8 * 1024 * 1024
SHELL_REQUEST = 4 * 1024 * 1024
SHELL_KILL_WAIT = 10
SHELL_WORK = "/work"
SHELL_CGROUP = Path("/sys/fs/cgroup/nibfin-shell")
SHELL_CWD_FILE = re.compile(r"/tmp/claude-[0-9a-f]{1,64}-cwd")
SHELL_LOCK = threading.Condition()
SHELL = {"closed": False, "live": set(),
         "slots": threading.BoundedSemaphore(SHELL_SESSIONS)}
# The Codex VM tool environment (forwardJobVmArguments and projectToolPaths).
SHELL_FIXED = {
    "PATH": ENV["PATH"], "LANG": "C.UTF-8", "NODE_USE_ENV_PROXY": "1",
    "NO_PROXY": "127.0.0.1,localhost", "HTTP_PROXY": ENV["HTTP_PROXY"],
    "HTTPS_PROXY": ENV["HTTPS_PROXY"], "DOCKER_HOST": ENV["DOCKER_HOST"],
}
SHELL_PATHS = ("HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
               "GOCACHE", "GOPATH", "PIP_CACHE_DIR", "npm_config_cache")
SHELL_PATTERNS = {"GOMAXPROCS": r"[1-9][0-9]{0,3}", "GOFLAGS": r"-p=[1-9][0-9]{0,3}"}
# The child joins its own cgroup before bash starts, so every descendant is in it.
SHELL_ENTRY = 'echo 0 > "$1/cgroup.procs" && exec /bin/bash -c "$2"'


def shell_environment(values):
    if not isinstance(values, dict):
        raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    environment = dict(ENV)
    for key, value in values.items():
        if not isinstance(value, str):
            allowed = False
        elif key in SHELL_FIXED:
            allowed = value == SHELL_FIXED[key]
        elif key in SHELL_PATHS:
            allowed = (value.startswith("/work/.nibfin-cache/")
                       and bool(safe_path(value[6:])))
        else:
            allowed = (key in SHELL_PATTERNS
                       and re.fullmatch(SHELL_PATTERNS[key], value) is not None)
        if not allowed:
            raise ShellRefused("JOB_VM_SHELL_ENVIRONMENT_REJECTED")
        environment[key] = value
    return environment


def shell_directory(value):
    if (not isinstance(value, str) or len(value) > 4096 or "\0" in value
            or "\n" in value or os.path.normpath(value) != value
            or not (value == SHELL_WORK or value.startswith(SHELL_WORK + "/"))):
        raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    # A directory the guest no longer has starts at the workspace root.
    return value if os.path.isdir(value) else SHELL_WORK


def create_leaf():
    SHELL_CGROUP.mkdir(exist_ok=True)
    leaf = SHELL_CGROUP / os.urandom(16).hex()
    leaf.mkdir()
    if not (leaf / "cgroup.kill").is_file():
        leaf.rmdir()
        raise ShellRefused("JOB_VM_SHELL_CGROUP_UNSUPPORTED")
    return leaf


def kill_leaf(leaf):
    (leaf / "cgroup.kill").write_text("1")
    deadline = time.monotonic() + SHELL_KILL_WAIT
    while "populated 0" not in (leaf / "cgroup.events").read_text().splitlines():
        if time.monotonic() > deadline:
            raise OSError("Shell cgroup still populated")
        time.sleep(0.05)
    leaf.rmdir()


class ShellSession:
    def __init__(self, leaf, process):
        self.leaf = leaf
        self.process = process
        self.lock = threading.Lock()
        self.state = "running"

    def stop(self):
        with self.lock:
            if self.state == "stopped":
                return
            if self.state == "failed":
                raise OSError("Shell cgroup still populated")
            try:
                # Before it joins its cgroup the child has no descendants.
                self.process.kill()
                self.process.wait()
                kill_leaf(self.leaf)
                self.state = "stopped"
            except OSError:
                self.state = "failed"
                raise


def send_frame(client, frame):
    client.sendall(json.dumps(frame, separators=(",", ":")).encode() + b"\n")


def read_request(client):
    data = b""
    while b"\n" not in data:
        chunk = client.recv(65536)
        if not chunk:
            return None
        data += chunk
        if len(data) > SHELL_REQUEST:
            raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    if not data.endswith(b"\n"):
        raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    return json.loads(data)


def read_cwd(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        data = stream.read(4098)
    os.unlink(path)
    try:
        value = data.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError:
        return None
    if (len(value) > 4096 or not value.startswith("/") or "\0" in value
            or "\n" in value):
        return None
    return value


def stream_command(client, session, cwd_file):
    process = session.process
    total, pipes, exited = 0, 2, False
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        selector.register(client, selectors.EVENT_READ, None)
        while pipes or not exited:
            if not exited and process.poll() is not None:
                exited = True
                # Completion retires every remaining descendant of the command.
                session.stop()
            for key, _ in selector.select(0.1):
                if key.data is None:
                    # Disconnect or unexpected input: the caller's cleanup kills.
                    client.recv(1)
                    return
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    pipes -= 1
                    continue
                total += len(chunk)
                if total > SHELL_OUTPUT:
                    session.stop()
                    send_frame(client, {"type": "error",
                                        "code": "JOB_VM_SHELL_OUTPUT_LIMIT"})
                    return
                send_frame(client, {"type": key.data,
                                    "data": base64.b64encode(chunk).decode("ascii")})
    code = process.returncode
    cwd = read_cwd(cwd_file) if cwd_file else None
    if cwd:
        send_frame(client, {"type": "cwd", "path": cwd})
    send_frame(client, {"type": "exit", "code": code if code >= 0 else 128 - code})


def quiesce():
    with SHELL_LOCK:
        SHELL["closed"] = True
        sessions = list(SHELL["live"])
    for session in sessions:
        try:
            session.stop()
        except OSError:
            pass
    with SHELL_LOCK:
        if not SHELL_LOCK.wait_for(lambda: not SHELL["live"], SHELL_KILL_WAIT):
            raise ShellRefused("JOB_VM_SHELL_QUIESCE_FAILED")
    return {"quiesced": True}


def run_command(client, request):
    if set(request) - {"operation", "script", "cwd", "env", "cwdFile"}:
        raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    script, cwd_file = request["script"], request.get("cwdFile")
    if (not isinstance(script, str) or not script or "\0" in script
            or cwd_file is not None and (not isinstance(cwd_file, str)
                                         or not SHELL_CWD_FILE.fullmatch(cwd_file))):
        raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    environment = shell_environment(request["env"])
    directory = shell_directory(request["cwd"])
    if not SHELL["slots"].acquire(blocking=False):
        raise ShellRefused("JOB_VM_SHELL_BUSY")
    try:
        if cwd_file:
            Path(cwd_file).unlink(missing_ok=True)
        with SHELL_LOCK:
            if SHELL["closed"]:
                raise ShellRefused("JOB_VM_SHELL_CLOSED")
            leaf = create_leaf()
            try:
                process = subprocess.Popen(
                    ["/bin/sh", "-c", SHELL_ENTRY, "nibfin-shell", str(leaf), script],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, cwd=directory, env=environment,
                    start_new_session=True)
            except OSError:
                leaf.rmdir()
                raise
            session = ShellSession(leaf, process)
            SHELL["live"].add(session)
        try:
            stream_command(client, session, cwd_file)
        finally:
            try:
                # A cgroup that cannot be emptied stays live and blocks quiesce.
                session.stop()
                with SHELL_LOCK:
                    SHELL["live"].discard(session)
                    SHELL_LOCK.notify_all()
            finally:
                process.stdout.close()
                process.stderr.close()
    finally:
        SHELL["slots"].release()


def shell(client):
    try:
        request = read_request(client)
        if request is None:
            return
        if request == {"operation": "quiesce"}:
            send_frame(client, quiesce())
        elif isinstance(request, dict) and request.get("operation") == "run":
            run_command(client, request)
        else:
            raise ShellRefused("JOB_VM_SHELL_REQUEST_INVALID")
    except ShellRefused as error:
        send_frame(client, {"type": "error", "code": error.code})
    except (ValueError, KeyError, TypeError):
        send_frame(client, {"type": "error", "code": "JOB_VM_SHELL_REQUEST_INVALID"})


def admit_shell(client, connections):
    # One spare connection beyond the command cap keeps quiesce reachable.
    if not connections.acquire(blocking=False):
        with client:
            send_frame(client, {"type": "error", "code": "JOB_VM_SHELL_BUSY"})
        return None

    def serve():
        try:
            with client:
                shell(client)
        except OSError:
            pass
        finally:
            connections.release()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return thread


def listen_shell(port):
    connections = threading.BoundedSemaphore(SHELL_SESSIONS + 1)
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as server:
        server.bind((socket.VMADDR_CID_ANY, port))
        server.listen(SHELL_SESSIONS)
        while True:
            client, (cid, _) = server.accept()
            if cid != socket.VMADDR_CID_HOST:
                client.close()
                continue
            try:
                admit_shell(client, connections)
            except OSError:
                continue


if __name__ == "__main__":
    os.umask(0o077)
    Path("/session").mkdir(exist_ok=True)
    threading.Thread(target=listen, args=(EXEC_PORT, execute), daemon=True).start()
    threading.Thread(target=listen_shell, args=(SHELL_PORT,), daemon=True).start()
    for port, family, address in (
        (PROXY_PORT, socket.AF_VSOCK, (socket.VMADDR_CID_HOST, EGRESS_PORT)),
        (2375, socket.AF_UNIX, "/run/nibfin-docker/docker.sock"),
    ):
        threading.Thread(
            target=loopback, args=(port, family, address), daemon=True
        ).start()
    listen(WORKSPACE_PORT, workspace)
