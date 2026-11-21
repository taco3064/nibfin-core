"""Exercise the Claude guest shell endpoint of the job VM executor.

Simulated: no VM, vsock or real cgroup v2 is used. A temporary directory stands
in for the cgroup hierarchy and the fake cgroup.kill kills the command's
process group, which bash shares with every non-detaching descendant. A real
cgroup also catches descendants that leave the group; the live guest is not
exercised here.
"""
import sys
sys.dont_write_bytecode = True

import ast
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src/security/job-vm-executor.py'
SPEC = importlib.util.spec_from_file_location('executor', SOURCE)
EXECUTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXECUTOR)

# Captured from the executor before the Claude shell was added.
CODEX_HANDLERS = {
    'execute': '44636d93895e90ab203d8eb70dfa8fa995908c49d04839229a84dd0a4aacd7bc',
    'listen': 'cecbdc7f9c27372c11f6e6821dd38a4939d06820fdcf2dcc12ef9a83d1fd6cb6',
    'workspace': '19ea2df6e7b20de7f1b1462f7e13bb0fdf6e1e73b97ae2e09596bc2298d0bbe9',
    'loopback': '8e611e6909b0db38de1175cfb5cff6140d6543e00de8b6146073e663e242e29f',
    'relay': '23dcf44888aca07fb81ea5b4e1c8c3a3f90f46fce86a0931293f1ed8f862ae2c',
}


class Connection:
    """The host side of one guest shell connection."""

    def __init__(self, request):
        self.client, server = socket.socketpair()
        self.errors = []

        def serve():
            try:
                with server:
                    EXECUTOR.shell(server)
            except OSError as error:
                self.errors.append(error)

        self.thread = threading.Thread(target=serve, daemon=True)
        self.thread.start()
        payload = request if isinstance(request, bytes) else (
            json.dumps(request).encode() + b'\n')
        self.client.sendall(payload)
        self.stream = self.client.makefile('rb')

    def frame(self):
        line = self.stream.readline()
        return json.loads(line) if line else None

    def frames(self):
        result = []
        while (frame := self.frame()) is not None:
            result.append(frame)
        self.close()
        return result

    def close(self):
        self.stream.close()
        self.client.close()
        self.thread.join(10)
        assert not self.thread.is_alive()


def output(frames, kind='stdout'):
    return b''.join(base64.b64decode(frame['data']) for frame in frames
                    if frame['type'] == kind).decode()


def gone(pid):
    # Killed orphans may stay visible until init reaps them.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


class ShellTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.deliver-test-tmp'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='shell-', dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.work = self.root / 'work'
        self.work.mkdir()
        self.killed, self.pids = [], []
        self.cwd_file = '/tmp/claude-%s-cwd' % os.urandom(8).hex()
        self.addCleanup(lambda: Path(self.cwd_file).unlink(missing_ok=True))
        saved = {name: getattr(EXECUTOR, name) for name in (
            'SHELL_WORK', 'SHELL_CGROUP', 'SHELL_OUTPUT', 'SHELL_REQUEST',
            'SHELL_KILL_WAIT', 'create_leaf', 'kill_leaf')}
        self.addCleanup(lambda: [setattr(EXECUTOR, key, value)
                                 for key, value in saved.items()])
        self.addCleanup(self.reset)
        self.reset()
        EXECUTOR.SHELL_WORK = str(self.work)
        EXECUTOR.SHELL_CGROUP = self.root / 'cgroup'
        EXECUTOR.create_leaf = self.create_leaf
        EXECUTOR.kill_leaf = self.kill_leaf

    def reset(self):
        EXECUTOR.SHELL['closed'] = False
        EXECUTOR.SHELL['live'].clear()
        EXECUTOR.SHELL['slots'] = threading.BoundedSemaphore(EXECUTOR.SHELL_SESSIONS)

    def create_leaf(self):
        EXECUTOR.SHELL_CGROUP.mkdir(exist_ok=True)
        leaf = EXECUTOR.SHELL_CGROUP / os.urandom(4).hex()
        leaf.mkdir()
        for name in ('cgroup.kill', 'cgroup.procs'):
            (leaf / name).write_text('')
        return leaf

    def kill_leaf(self, leaf):
        # Simulated cgroup.kill: the command's whole process group.
        for session in list(EXECUTOR.SHELL['live']):
            if session.leaf == leaf:
                self.pids.append(session.process.pid)
                try:
                    os.killpg(session.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.killed.append(leaf)

    def run_request(self, script, env=None, cwd=None, cwd_file=None):
        request = {'operation': 'run', 'script': script, 'env': env or {},
                   'cwd': cwd or str(self.work)}
        if cwd_file:
            request['cwdFile'] = cwd_file
        return request

    def test_codex_handlers_ports_and_environment_are_unchanged(self):
        source = SOURCE.read_text()
        tree = ast.parse(source)
        actual = {node.name: hashlib.sha256(
            ast.get_source_segment(source, node).encode()).hexdigest()
            for node in tree.body if isinstance(node, ast.FunctionDef)
            and node.name in CODEX_HANDLERS}
        self.assertEqual(actual, CODEX_HANDLERS)
        self.assertEqual((EXECUTOR.WORKSPACE_PORT, EXECUTOR.EXEC_PORT,
                          EXECUTOR.EGRESS_PORT, EXECUTOR.SHELL_PORT),
                         (4020, 4021, 4022, 4023))
        self.assertEqual(EXECUTOR.ENV['PATH'],
                         '/opt/nibfin/project/bin:/usr/local/bin:/usr/bin:/bin')
        self.assertIn('target=listen, args=(EXEC_PORT, execute)', source)

    def test_streams_stdout_stderr_and_exit_code(self):
        frames = Connection(self.run_request(
            'echo out; echo err >&2; exit 3')).frames()
        self.assertEqual(output(frames), 'out\n')
        self.assertEqual(output(frames, 'stderr'), 'err\n')
        self.assertEqual(frames[-1], {'type': 'exit', 'code': 3})
        self.assertEqual(len(self.killed), 1)
        self.assertFalse(EXECUTOR.SHELL['live'])

    def test_only_allowlisted_environment_reaches_the_command(self):
        os.environ['ANTHROPIC_API_KEY'] = 'container-secret'
        self.addCleanup(os.environ.pop, 'ANTHROPIC_API_KEY')
        env = {'GOFLAGS': '-p=1', 'GOMAXPROCS': '2', 'NODE_USE_ENV_PROXY': '1',
               'NO_PROXY': '127.0.0.1,localhost',
               'HTTP_PROXY': 'http://127.0.0.1:3128',
               'DOCKER_HOST': 'tcp://127.0.0.1:2375', 'LANG': 'C.UTF-8',
               'HOME': '/work/.nibfin-cache/x/home'}
        frames = Connection(self.run_request(
            'echo "$GOFLAGS|$HTTP_PROXY|$HOME|${ANTHROPIC_API_KEY-unset}"',
            env)).frames()
        self.assertEqual(output(frames),
                         '-p=1|http://127.0.0.1:3128|/work/.nibfin-cache/x/home|unset\n')
        marker = self.work / 'ran'
        for env in ({'CLAUDE_CODE_OAUTH_TOKEN': 'sk-ant-oat01-x'},
                    {'HTTP_PROXY': 'http://203.0.113.1:3128'},
                    {'HOME': '/root'}, {'HOME': '/work/.nibfin-cache/../x'},
                    {'GOFLAGS': '-p=1 -toolexec=/tmp/x'}, {'PATH': '/tmp'},
                    {'LD_PRELOAD': '/tmp/x.so'}, {'GOMAXPROCS': 2}):
            frames = Connection(self.run_request('touch ran', env)).frames()
            self.assertEqual(frames, [{'type': 'error',
                                       'code': 'JOB_VM_SHELL_ENVIRONMENT_REJECTED'}])
        self.assertFalse(marker.exists())
        # Only the allowed command got a cgroup.
        self.assertEqual(len(self.killed), 1)

    def test_cwd_file_reports_the_final_guest_directory(self):
        record = ' && pwd -P >| ' + self.cwd_file
        frames = Connection(self.run_request(
            'mkdir d && cd d' + record, cwd_file=self.cwd_file)).frames()
        self.assertEqual(frames, [{'type': 'cwd', 'path': str(self.work / 'd')},
                                  {'type': 'exit', 'code': 0}])
        self.assertFalse(Path(self.cwd_file).exists())
        frames = Connection(self.run_request(
            'pwd', cwd=str(self.work / 'd'))).frames()
        self.assertEqual(output(frames), str(self.work / 'd') + '\n')
        frames = Connection(self.run_request(
            'cd /tmp' + record, cwd_file=self.cwd_file)).frames()
        self.assertEqual(frames[0], {'type': 'cwd', 'path': '/tmp'})
        # A stale file from an earlier command is never reported again.
        Path(self.cwd_file).write_text(str(self.work / 'stale'))
        frames = Connection(self.run_request(
            'false' + record, cwd_file=self.cwd_file)).frames()
        self.assertEqual(frames, [{'type': 'exit', 'code': 1}])
        frames = Connection(self.run_request(
            'pwd', cwd=str(self.work / 'removed'))).frames()
        self.assertEqual(output(frames), str(self.work) + '\n')

    def test_invalid_requests_run_nothing(self):
        invalid = {'type': 'error', 'code': 'JOB_VM_SHELL_REQUEST_INVALID'}
        requests = [
            self.run_request('touch ran', cwd='/etc'),
            self.run_request('touch ran', cwd=str(self.work) + '/../x'),
            self.run_request('touch ran', cwd_file='/tmp/other'),
            {**self.run_request('touch ran'), 'extra': True},
            {**self.run_request('touch ran'), 'env': ['A=1']},
            self.run_request(''), {'operation': 'unknown'}, b'not json\n',
            json.dumps(self.run_request('touch ran')).encode() + b'\nextra',
        ]
        for request in requests:
            self.assertEqual(Connection(request).frames(), [invalid], request)
        EXECUTOR.SHELL_REQUEST = 64
        self.assertEqual(Connection(self.run_request('touch ran' + ' ' * 80)).frames(),
                         [invalid])
        self.assertFalse((self.work / 'ran').exists())

    def test_output_beyond_the_cap_kills_the_command(self):
        EXECUTOR.SHELL_OUTPUT = 1000
        started = time.monotonic()
        frames = Connection(self.run_request(
            'head -c 5000 /dev/zero; sleep 30')).frames()
        self.assertEqual(frames[-1], {'type': 'error',
                                      'code': 'JOB_VM_SHELL_OUTPUT_LIMIT'})
        self.assertLessEqual(len(output(frames)), 1000)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(len(self.killed), 1)
        self.assertTrue(gone(self.pids[0]))

    def test_disconnect_kills_the_command_cgroup(self):
        connection = Connection(self.run_request('echo started; sleep 30'))
        self.assertEqual(output([connection.frame()]), 'started\n')
        started = time.monotonic()
        connection.close()
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(len(self.killed), 1)
        self.assertTrue(gone(self.pids[0]))
        self.assertFalse(EXECUTOR.SHELL['live'])

    def test_completion_kills_remaining_descendants(self):
        started = time.monotonic()
        frames = Connection(self.run_request('sleep 30 & echo done')).frames()
        self.assertEqual(output(frames), 'done\n')
        self.assertEqual(frames[-1], {'type': 'exit', 'code': 0})
        self.assertLess(time.monotonic() - started, 10)
        self.assertTrue(gone(self.pids[0]))

    def test_concurrent_commands_are_bounded(self):
        EXECUTOR.SHELL['slots'] = threading.BoundedSemaphore(1)
        first = Connection(self.run_request('echo started; sleep 30'))
        self.assertEqual(output([first.frame()]), 'started\n')
        self.assertEqual(Connection(self.run_request('echo second')).frames(),
                         [{'type': 'error', 'code': 'JOB_VM_SHELL_BUSY'}])
        first.close()
        self.assertEqual(output(Connection(self.run_request('echo third')).frames()),
                         'third\n')
        connections = threading.BoundedSemaphore(1)
        connections.acquire()
        client, server = socket.socketpair()
        self.assertIsNone(EXECUTOR.admit_shell(server, connections))
        with client, client.makefile('rb') as stream:
            self.assertEqual(json.loads(stream.readline()),
                             {'type': 'error', 'code': 'JOB_VM_SHELL_BUSY'})
        connections.release()
        client, server = socket.socketpair()
        thread = EXECUTOR.admit_shell(server, connections)
        with client, client.makefile('rb') as stream:
            client.sendall(json.dumps(self.run_request('echo admitted')).encode()
                           + b'\n')
            frames = [json.loads(line) for line in stream]
        thread.join(10)
        self.assertEqual(output(frames), 'admitted\n')
        self.assertTrue(connections.acquire(blocking=False))

    def test_quiesce_kills_live_commands_and_refuses_new_ones(self):
        running = Connection(self.run_request('echo started; sleep 30'))
        self.assertEqual(output([running.frame()]), 'started\n')
        self.assertEqual(Connection({'operation': 'quiesce'}).frames(),
                         [{'quiesced': True}])
        self.assertTrue(gone(self.pids[0]))
        self.assertEqual(running.frames(), [{'type': 'exit', 'code': 137}])
        self.assertFalse(EXECUTOR.SHELL['live'])
        self.assertEqual(Connection(self.run_request('touch ran')).frames(),
                         [{'type': 'error', 'code': 'JOB_VM_SHELL_CLOSED'}])
        self.assertFalse((self.work / 'ran').exists())

    def test_quiesce_fails_while_a_cgroup_cannot_be_emptied(self):
        EXECUTOR.SHELL_KILL_WAIT = 0.2
        kill = self.kill_leaf

        def stuck(leaf):
            kill(leaf)
            raise OSError('Shell cgroup still populated')

        EXECUTOR.kill_leaf = stuck
        running = Connection(self.run_request('echo started; sleep 30'))
        self.assertEqual(output([running.frame()]), 'started\n')
        self.assertEqual(Connection({'operation': 'quiesce'}).frames(),
                         [{'type': 'error', 'code': 'JOB_VM_SHELL_QUIESCE_FAILED'}])
        running.frames()
        self.assertEqual(len(EXECUTOR.SHELL['live']), 1)

    def test_commands_require_cgroup_kill(self):
        EXECUTOR.create_leaf = type(self).saved_create_leaf
        self.assertEqual(Connection(self.run_request('touch ran')).frames(),
                         [{'type': 'error', 'code': 'JOB_VM_SHELL_CGROUP_UNSUPPORTED'}])
        self.assertFalse((self.work / 'ran').exists())
        self.assertEqual(list(EXECUTOR.SHELL_CGROUP.iterdir()), [])

    def test_kill_leaf_writes_cgroup_kill_and_waits_until_empty(self):
        class Leaf:
            def __init__(self, path):
                self.path, self.removed = path, False

            def __truediv__(self, name):
                return self.path / name

            def rmdir(self):
                self.removed = True

        kill = type(self).saved_kill_leaf
        leaf = Leaf(self.root)
        (self.root / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
        kill(leaf)
        self.assertEqual((self.root / 'cgroup.kill').read_text(), '1')
        self.assertTrue(leaf.removed)
        (self.root / 'cgroup.events').write_text('populated 1\n')
        EXECUTOR.SHELL_KILL_WAIT = 0.1
        busy = Leaf(self.root)
        with self.assertRaises(OSError):
            kill(busy)
        self.assertFalse(busy.removed)


ShellTests.saved_create_leaf = staticmethod(EXECUTOR.create_leaf)
ShellTests.saved_kill_leaf = staticmethod(EXECUTOR.kill_leaf)


if __name__ == '__main__':
    unittest.main()
