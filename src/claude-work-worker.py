"""Linux worker PID 1. Admission is mounted read-only by Core, never MCP input."""
import importlib.util
import json
import os
import selectors
import signal
import socket
import stat
import struct
import subprocess
import time
from pathlib import Path


def sibling(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


protocol = sibling("claude-work-protocol")
files = sibling("claude-work-files")
ENV = {}
CONNECTION = None
PENDING = None


def check(command, environment=None, directory="/work"):
    # PID 1 exits on any interrupted/oversized command. Docker then kills the
    # entire PID namespace, including detached descendants. Core must still
    # reconcile the container before accepting any workspace or role result.
    env = dict(ENV if environment is None else environment)
    if PENDING is not None and PENDING.buffer:
        os._exit(130)
    child = subprocess.Popen(["/bin/sh", "-c", command], cwd=directory, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    chunks = []
    size = 0
    deadline = time.monotonic() + protocol.TIMEOUT
    selector = selectors.DefaultSelector()
    for stream in (child.stdout, child.stderr):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    if CONNECTION is not None:
        selector.register(CONNECTION, selectors.EVENT_READ)
    try:
        while any(key.fileobj is not CONNECTION for key in selector.get_map().values()):
            if time.monotonic() >= deadline:
                os._exit(124)
            for key, _ in selector.select(0.1):
                if key.fileobj is CONNECTION:
                    # Cancellation, another request or EOF interrupts execution.
                    # Core still has to observe container settlement independently.
                    os._exit(130)
                data = os.read(key.fd, 8192)
                if not data:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                else:
                    size += len(data)
                    if size > protocol.OUTPUT_LIMIT:
                        os._exit(125)
                    chunks.append(data)
        remaining = max(0.01, deadline - time.monotonic())
        try:
            status = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os._exit(124)
        return json.dumps({"exitCode": status,
                           "output": b"".join(chunks).decode("utf-8", "replace")})
    finally:
        selector.close()


def execute(operation, args):
    if operation == "read":
        return files.read("/" + args["surface"], args["path"], args.get("search"))
    if operation == "write":
        return files.write("/work", args["path"], args["content"])
    if operation == "check":
        return check(args["command"])
    raise ValueError("DENIED_OPERATION")


class Frames:
    def __init__(self, peer):
        self.peer = peer
        self.buffer = bytearray()

    def readline(self):
        while b"\n" not in self.buffer:
            if len(self.buffer) > protocol.REQUEST_LIMIT:
                raise ValueError("REQUEST_LIMIT")
            data = self.peer.recv(8192)
            if not data:
                if self.buffer:
                    raise ValueError("INCOMPLETE_REQUEST")
                return b""
            self.buffer.extend(data)
        index = self.buffer.index(10) + 1
        line = bytes(self.buffer[:index])
        del self.buffer[:index]
        return line


def _serve(config):
    global CONNECTION, PENDING
    endpoint = config["socket"]
    directory = Path(endpoint).parent
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or directory.resolve() != directory:
        raise ValueError("UNSAFE_SOCKET_DIRECTORY")
    # The containing host parent is private to this execution; model admission
    # supplies a distinct remapped UID/GID. Worker workloads cannot setuid to it.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(endpoint)
        os.chmod(endpoint, 0o666)
        listener.listen(4)
        listener.settimeout(1)
        deadline = time.monotonic() + config["lifetime"]
        while time.monotonic() < deadline:
            try:
                peer, _ = listener.accept()
            except socket.timeout:
                continue
            with peer:
                _, uid, gid = struct.unpack("3i", peer.getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if [uid, gid] != config["peer"]:
                    continue
                peer.settimeout(protocol.TIMEOUT + 2)
                CONNECTION = peer
                PENDING = Frames(peer)
                while time.monotonic() < deadline:
                    try:
                        line = PENDING.readline()
                        if not line:
                            return False
                        request = protocol.decode(line)
                        if request == {"jsonrpc": "2.0",
                                       "method": protocol.LIMITS["completionMethod"]}:
                            return not PENDING.buffer
                        if (type(request) is dict and "id" not in request
                                and request.get("jsonrpc") == "2.0"
                                and request.get("method") == "notifications/cancelled"):
                            return False
                        response = protocol.dispatch(
                            request, config["operations"], execute)
                        if response is not None:
                            peer.sendall(protocol.encode(response))
                    except (ValueError, OSError, RecursionError):
                        peer.sendall(protocol.encode(protocol.error(None)))
                        break
                CONNECTION, PENDING = None, None
            # A disconnected bridge cancels the worker. Reconnection/replay must
            # be a new trusted launch after this container is confirmed absent.
            return False
    return False


def serve(config):
    global CONNECTION, PENDING
    try:
        return _serve(config)
    finally:
        CONNECTION, PENDING = None, None


def main():
    signal.signal(signal.SIGTERM, lambda *_: os._exit(143))
    signal.signal(signal.SIGINT, lambda *_: os._exit(130))
    with open("/session/work-admission.json", "rb") as source:
        config = json.load(source)
    if (config["peer"][0] == os.getuid()
            or config["peer"][1] == os.getgid()):
        raise ValueError("INVALID_ADMISSION")
    ENV.update(config["environment"])
    if not serve(config):
        os._exit(1)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No exception text or private transport details cross this boundary.
        os._exit(1)
