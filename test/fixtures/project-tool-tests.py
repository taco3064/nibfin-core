"""Native subprocess and VM workspace checks, without Docker or host mutation."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys


ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


worker = load("work", "src/claude-work-worker.py")
vm = load("vm", "src/security/job-vm-executor.py")
supplied = json.load(sys.stdin)
root = Path(supplied["root"])
environment = supplied["environment"]
for directory in environment.values():
    Path(directory).mkdir(parents=True, exist_ok=True)
environment.update(PATH=os.environ["PATH"])
code = """
import json,os,pathlib,tempfile
paths=[]
for name in ['HOME','TMPDIR','XDG_CACHE_HOME','GOCACHE','GOPATH',
             'PIP_CACHE_DIR','npm_config_cache']:
 p=pathlib.Path(os.environ[name])/(name+'.output')
 p.write_text(name); paths.append(str(p))
paths.append(tempfile.mkdtemp())
print(json.dumps(paths))
"""
command = shlex.quote(sys.executable) + " -B -c " + shlex.quote(code)
observed = json.loads(worker.check(command, environment, directory=str(root)))
assert observed["exitCode"] == 0, observed
assert all(Path(p).is_relative_to(root) for p in json.loads(observed["output"]))

work = root / "guest"
work.mkdir()
(work / "maintained.txt").write_text("Candidate")
temporary = ".nibfin-cache/new-execution"
excluded = vm.prepare_tool_output(work, temporary, [temporary + "/tmp"])
assert excluded["path"] == temporary
# An active Core runtime artifact under its own new scratch is not source.
artifact = work / temporary / "tmp" / ".git"
artifact.mkdir()
(artifact / "runtime-file").write_text("Core-owned")
files = vm.snapshot(work, excluded)
assert [item["path"] for item in files] == ["maintained.txt"]
assert (artifact / "runtime-file").exists()

# Neither a new directory at the same name nor a replacement parent is owned.
old = work / temporary
preserved = work / "preserved-runtime"
old.rename(preserved)
old.mkdir()
(old / "candidate-source.txt").write_text("do not omit")
try:
    vm.snapshot(work, excluded)
except ValueError as error:
    assert str(error) == "Tool output directory changed"
else:
    raise AssertionError("Replaced cache root was silently omitted")
assert (old / "candidate-source.txt").read_text() == "do not omit"

parent = old.parent
saved_parent = work / "saved-parent"
parent.rename(saved_parent)
parent.symlink_to(preserved, target_is_directory=True)
try:
    vm.snapshot(work, excluded)
except ValueError as error:
    assert str(error) == "Tool output directory changed"
else:
    raise AssertionError("Replaced cache parent was followed")
parent.unlink()
saved_parent.rename(parent)
(old / "candidate-source.txt").unlink()
old.rmdir()
preserved.rename(old)

original = work / ".nibfin-cache/existing-source"
original.mkdir()
(original / "required.txt").write_text("Maintained")
assert vm.prepare_tool_output(work, ".nibfin-cache/existing-source",
                              [".nibfin-cache/existing-source/tmp"]) is None
assert ".nibfin-cache/existing-source/required.txt" in {
    item["path"] for item in vm.snapshot(work, excluded)}
try:
    vm.prepare_tool_output(work, "../outside", ["../outside/tmp"])
except ValueError:
    pass
else:
    raise AssertionError("Tool preparation accepted an escaping directory")
print("Native Claude child and VM prepare/collect passed")

# Exercise the actual workspace protocol, not only its preparation helper.
protocol_root = root / "protocol"
protocol_root.mkdir()
original_path = vm.Path
vm.Path = lambda value: protocol_root if value == "/" else original_path(value)
vm.ENV = {"HOME": str(protocol_root / "home")}


class Client:
    def makefile(self, mode):
        return io.BytesIO(json.dumps({
            "operation": "prepare", "name": "work", "files": [],
            "toolRoot": temporary, "toolDirectories": [temporary + "/tmp"],
        }).encode() + b"\n")

    def sendall(self, data):
        self.result = json.loads(data)


client = Client()
vm.workspace(client)
assert client.result == {"ready": True, "toolOutput": {
    "root": temporary, "directories": [temporary + "/tmp"],
    "collection": "preserve-source-omit-owned-output",
}}, client.result
assert (protocol_root / "work" / temporary / "tmp").is_dir()
print("VM readiness reports actual tool-directory and collection capability")
