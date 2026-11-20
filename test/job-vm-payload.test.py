"""Exercise runtime authority and archive confinement with controlled archives."""
import sys
sys.dont_write_bytecode = True

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('payload', ROOT / 'src/job-vm-payload.py')
PAYLOAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAYLOAD)


def file(name, content=b'tool'):
    entry = tarfile.TarInfo(name)
    entry.size = len(content)
    return entry, content


def link(name, target, hard=False):
    entry = tarfile.TarInfo(name)
    entry.type = tarfile.LNKTYPE if hard else tarfile.SYMTYPE
    entry.linkname = target
    return entry, None


class PayloadTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.deliver-test-tmp'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='payload-', dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, entries):
        path = self.root / 'project.tar'
        with tarfile.open(path, 'w') as output:
            for entry, data in entries:
                output.addfile(entry, None if data is None else io.BytesIO(data))
        return path

    def build(self, entries=None, executor=b'fixed executor'):
        project = None if entries is None else self.archive(entries)
        path = self.root / 'runtime.tar'
        PAYLOAD.build(executor, project, path)
        return tarfile.open(path)

    def test_runtime_only_and_independent_snapshots(self):
        first_path = self.root / 'first.tar'
        PAYLOAD.build(b'first', None, first_path)
        with self.build(executor=b'second') as second:
            self.assertEqual(second.getnames(), ['job-vm-executor.py'])
            self.assertEqual(second.extractfile('job-vm-executor.py').read(), b'second')
        with tarfile.open(first_path) as first:
            self.assertEqual(first.extractfile('job-vm-executor.py').read(), b'first')

    def test_safe_relative_tool_links_and_long_names(self):
        name = 'project/lib/' + 'x' * 120
        entries = [file(name), link('project/bin/tool', '../lib/' + 'x' * 120),
                   link('project/lib/hard', name, hard=True),
                   link('project/deep', 'lib/deeper'),
                   link('project/safe', 'deep/../..')]
        with self.build(entries) as output:
            self.assertEqual(output.extractfile(name).read(), b'tool')
            self.assertEqual(output.extractfile('project/lib/hard').read(), b'tool')
            self.assertEqual(output.getmember('job-vm-executor.py').mode, 0o755)

    def test_supported_extraction_replaces_only_private_old_executor(self):
        guest = self.root / 'private-root'
        guest.mkdir()
        old = guest / 'job-vm-executor.py'
        old.write_bytes(b'old executor')
        with self.build([file('project/bin/tool')]) as archive:
            archive.extractall(guest, filter='data')
        self.assertEqual(old.read_bytes(), b'fixed executor')
        self.assertEqual((guest / 'project/bin/tool').read_bytes(), b'tool')

    def test_reject_runtime_override_paths_duplicates_and_special_entries(self):
        special = tarfile.TarInfo('project/device')
        special.type = tarfile.CHRTYPE
        cases = [[file('job-vm-executor.py')], [file('/project/file')],
                 [file('project/../job-vm-executor.py')],
                 [file('project/a'), file('project/a')],
                 [file('project/a'), file('project/a/b')], [(special, None)],
                 [file('project/./alias')]]
        for entries in cases:
            with self.subTest(entries=[entry.name for entry, _ in entries]):
                with self.assertRaises(PAYLOAD.InvalidPayload):
                    self.build(entries)

    def test_reject_escaping_links_chains_cycles_and_ancestor_links(self):
        cases = [[link('project/a', '../../escape')],
                 [link('project/a', '/opt/nibfin/job-vm-executor.py')],
                 [link('project/a', 'b'), link('project/b', '../escape')],
                 [link('project/a', 'b'), link('project/b', 'a')],
                 [link('project/a', 'b'), file('project/a/file')],
                 [link('project/a', 'job-vm-executor.py', hard=True)],
                 [link('project/a', 'project/missing', hard=True)],
                 [link('project/d/b', '../c'),
                  link('project/d/a', 'b/../..')]]
        for entries in cases:
            with self.subTest(entries=[entry.linkname for entry, _ in entries]):
                with self.assertRaises(PAYLOAD.InvalidPayload):
                    self.build(entries)


if __name__ == '__main__':
    unittest.main()
