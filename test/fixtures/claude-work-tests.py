"""Native component regressions; Docker/host boundaries use separate doubles."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "src" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


protocol = load("claude-work-protocol")
files = load("claude-work-files")
worker = load("claude-work-worker")


def request(method, params=None):
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}


class ProtocolTests(unittest.TestCase):
    def test_roles_tools_and_closed_arguments(self):
        calls = []
        execute = lambda *args: calls.append(args) or "ok"
        for operations in (["read", "check"], ["read", "check", "write"]):
            result = protocol.dispatch(request("tools/list"), operations, execute)
            self.assertEqual([tool["name"] for tool in result["result"]["tools"]],
                             operations)
            for name, args in (
                    ("read", {"surface": "work", "path": "a"}),
                    ("check", {"command": "exit 0"}),
                    ("write", {"path": "a", "content": "hello"})):
                result = protocol.dispatch(request("tools/call", {
                    "name": name, "arguments": args}), operations, execute)
                self.assertEqual("result" in result, name in operations)
                for extra in ("role", "stage", "executionId", "socket", "executable"):
                    before = len(calls)
                    result = protocol.dispatch(request("tools/call", {
                        "name": name, "arguments": {**args, extra: "attacker"}}),
                        operations, execute)
                    self.assertIn("error", result)
                    self.assertEqual(len(calls), before)

    def test_malformed_and_bounds(self):
        for value in ([], None, "data", {"jsonrpc": "2.0", "id": {}},
                      request("tools/call", {"name": "shell", "arguments": {}}),
                      {**request("tools/list"), "role": "deliver"},
                      {**request("tools/list"), "id": "a" * 129},
                      request("tools/call", {"name": "check", "arguments": {
                          "command": "a" * 8193}})):
            result = protocol.dispatch(value, ["read", "check"],
                                       lambda *_: self.fail("must not dispatch"))
            self.assertIn("error", result)
        for line in (b'{"id":1,"id":2}\n', b"NaN\n", b"{}",
                     b"x" * (protocol.REQUEST_LIMIT + 1), b"\xff\n"):
            with self.assertRaises((ValueError, UnicodeError)):
                protocol.decode(line)
        with self.assertRaises(ValueError):
            protocol.encode({"text": "a" * protocol.RESPONSE_LIMIT})
        self.assertLess(len(protocol.encode(protocol.error(None))), 256)

    def test_initialize_and_errors_are_public(self):
        result = protocol.dispatch(request("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "simulated-model", "version": "1"}}),
            ["read", "check"], lambda *_: None)
        self.assertEqual(result["result"]["capabilities"], {"tools": {}})
        def denied(*_):
            raise OSError("secret /session/work-channel and credentials")
        result = protocol.dispatch(request("tools/call", {
            "name": "read", "arguments": {"surface": "work", "path": "a"}}),
            ["read"], denied)
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("/session", json.dumps(result))


class FilesystemTests(unittest.TestCase):
    def test_read_search_write_and_link_denials(self):
        with tempfile.TemporaryDirectory(prefix="work-files-") as root:
            base = Path(root)
            (base / "dir").mkdir()
            files.write(root, "dir/file", "one\ntwo needle\nthree")
            self.assertEqual(files.read(root, "dir/file"), "one\ntwo needle\nthree")
            self.assertEqual(files.read(root, "dir/file", "needle"), "2: two needle")
            (base / "link").symlink_to("/etc/passwd")
            (base / "escape").symlink_to("/tmp", target_is_directory=True)
            os.link(base / "dir/file", base / "hard")
            for path in ("../etc/passwd", "/etc/passwd", "dir/../../bad", "link",
                         "escape/outside", "hard", "dir/file", "dir//file"):
                with self.assertRaises((ValueError, OSError)):
                    files.read(root, path)
                with self.assertRaises((ValueError, OSError)):
                    files.write(root, path, "bad")
            (base / "large").write_bytes(b"x" * 65537)
            with self.assertRaises(ValueError):
                files.read(root, "large")
            with self.assertRaises(ValueError):
                files.write(root, "new", "x" * 65537)
            (base / "fifo").touch()
            (base / "fifo").unlink()
            os.mkfifo(base / "fifo")
            with self.assertRaises(ValueError):
                files.read(root, "fifo")
            self.assertEqual((base / "dir/file").read_text(), "one\ntwo needle\nthree")


class NativeTransportTests(unittest.TestCase):
    def test_real_peer_credentials_wrong_peer_then_valid_connection(self):
        with tempfile.TemporaryDirectory(prefix="work-socket-") as root:
            endpoint = str(Path(root) / "worker.sock")
            try:
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                probe.bind(endpoint)
                probe.close()
                os.unlink(endpoint)
            except PermissionError as error:
                self.skipTest(f"Unverified: Unix socket bind denied: {error.errno}")
            config = {"socket": endpoint, "peer": [os.getuid() + 1, os.getgid()],
                      "operations": ["read", "check"], "lifetime": 3}
            failures = []
            def serve():
                try:
                    worker.serve(config)
                except BaseException as error:
                    failures.append(error)
            thread = threading.Thread(target=serve)
            thread.start()
            try:
                deadline = time.monotonic() + 2
                while not Path(endpoint).exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                    peer.settimeout(1)
                    peer.connect(endpoint)
                    self.assertEqual(peer.recv(1), b"")
                config["peer"] = [os.getuid(), os.getgid()]
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                    peer.settimeout(1)
                    peer.connect(endpoint)
                    peer.sendall(protocol.encode(request("tools/list")))
                    response = json.loads(peer.recv(protocol.RESPONSE_LIMIT))
                    self.assertEqual([t["name"] for t in response["result"]["tools"]],
                                     ["read", "check"])
                    peer.sendall(b'{"jsonrpc":"2.0","id":1,"id":2}\n')
                    self.assertIn("error", json.loads(peer.recv(1024)))
            finally:
                thread.join(4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])

    def test_only_bridge_completion_is_orderly(self):
        completion = protocol.encode({
            "jsonrpc": "2.0", "method": protocol.LIMITS["completionMethod"]})
        for frame, expected in [(completion, True), (b"", False),
                                (b'{"id":', False),
                                (completion + b'{"id":1}\n', False)]:
            with self.subTest(frame=frame):
                with tempfile.TemporaryDirectory(prefix="work-complete-") as root:
                    endpoint = str(Path(root) / "worker.sock")
                    config = {"socket": endpoint,
                              "peer": [os.getuid(), os.getgid()],
                              "operations": ["read"], "lifetime": 3}
                    outcomes = []
                    failures = []
                    def serve():
                        try:
                            outcomes.append(worker.serve(config))
                        except BaseException as error:
                            failures.append(error)
                    thread = threading.Thread(target=serve)
                    thread.start()
                    try:
                        deadline = time.monotonic() + 2
                        while (not Path(endpoint).exists()
                               and time.monotonic() < deadline):
                            time.sleep(0.01)
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                            peer.settimeout(1)
                            peer.connect(endpoint)
                            if frame:
                                peer.sendall(frame)
                            peer.shutdown(socket.SHUT_WR)
                            while peer.recv(protocol.RESPONSE_LIMIT):
                                pass
                    finally:
                        thread.join(4)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(failures, [])
                    self.assertEqual(outcomes, [expected])



class CommandTests(unittest.TestCase):
    def test_clean_environment_and_exit_status(self):
        # Native subprocess only: this does not simulate a Docker boundary.
        original = dict(os.environ)
        try:
            os.environ["ANTHROPIC_API_KEY"] = "must-not-inherit"
            for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
                os.environ[name] = "http://127.0.0.1:3128"
            os.environ["NODE_USE_ENV_PROXY"] = "1"
            result = json.loads(worker.check(
                'test -z "$ANTHROPIC_API_KEY" && printf safe; exit 7',
                {"PATH": "/usr/bin:/bin"}, directory=str(ROOT)))
            self.assertEqual(result, {"exitCode": 7, "output": "safe"})
        finally:
            os.environ.clear()
            os.environ.update(original)

    def test_timeout_and_output_exhaustion_exit_worker(self):
        with tempfile.TemporaryDirectory(prefix="work-command-") as root:
            for kind in ("timeout", "output"):
                pid_path = Path(root) / kind
                command = f"echo $$ > {pid_path}; exec /bin/sleep 10"
                if kind == "output":
                    command = f"echo $$ > {pid_path}; exec /usr/bin/yes"
                script = (
                    "import importlib.util; "
                    f"s=importlib.util.spec_from_file_location('w',"
                    f"{str(ROOT / 'src/claude-work-worker.py')!r}); "
                    "w=importlib.util.module_from_spec(s); s.loader.exec_module(w); "
                    "w.protocol.TIMEOUT=0.1; "
                    f"w.check({command!r}, directory={root!r})")
                env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
                       "HTTP_PROXY": "http://127.0.0.1:3128",
                       "HTTPS_PROXY": "http://127.0.0.1:3128",
                       "ALL_PROXY": "http://127.0.0.1:3128", "NODE_USE_ENV_PROXY": "1"}
                try:
                    result = subprocess.run([sys.executable, "-B", "-c", script],
                                            env=env, capture_output=True, timeout=4)
                    self.assertEqual(result.returncode, 124 if kind == "timeout" else 125,
                                     result.stderr)
                finally:
                    if pid_path.exists():
                        try:
                            os.killpg(int(pid_path.read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_socket_interruption_terminates_command_worker(self):
        with tempfile.TemporaryDirectory(prefix="work-interrupt-") as root:
            pid_path = Path(root) / "command-pid"
            local, remote = socket.socketpair()
            command = f"echo $$ > {pid_path}; exec /bin/sleep 10"
            script = (
                "import importlib.util,socket; "
                f"s=importlib.util.spec_from_file_location('w',"
                f"{str(ROOT / 'src/claude-work-worker.py')!r}); "
                "w=importlib.util.module_from_spec(s); s.loader.exec_module(w); "
                f"w.CONNECTION=socket.socket(fileno={remote.fileno()}); "
                f"w.check({command!r}, directory={root!r})")
            child = subprocess.Popen([sys.executable, "-B", "-c", script],
                                     pass_fds=(remote.fileno(),))
            remote.close()
            try:
                deadline = time.monotonic() + 2
                while not pid_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(pid_path.exists())
                local.sendall(b'{"method":"notifications/cancelled"}\n')
                self.assertEqual(child.wait(timeout=3), 130)
            finally:
                local.close()
                if child.poll() is None:
                    child.kill()
                child.wait()
                if pid_path.exists():
                    try:
                        os.killpg(int(pid_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
