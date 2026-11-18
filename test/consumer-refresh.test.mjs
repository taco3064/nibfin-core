import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Simulated provider reads/effects exercise the maintained reader, not a live host.
test('consumer refresh validates heads and waits for fresh native checks', () => {
  const script = new URL('../scripts/host-auto-rollout.py', import.meta.url);
  const result = spawnSync('python3', ['-B', '-c', `
import copy
import io
import json
import runpy
import sys
from contextlib import redirect_stdout

module = runpy.run_path(sys.argv[1])
read = module["read_consumer"]
g = read.__globals__
repo = module["E2E"]
issue = module["ISSUE"]
pins = {"core": {"commit": "a" * 40}, "action": {"commit": "b" * 40},
        "artifact": {"id": 1}}
branch = "cd/consumers-" + "a" * 12 + "-" + "b" * 12
passed = {"name": "verify", "conclusion": "SUCCESS"}
original = {"number": 173, "headRefOid": "old", "isDraft": False,
            "isCrossRepository": False, "mergeStateStatus": "BEHIND",
            "files": [{"path": issue}], "statusCheckRollup": [passed]}
pr = copy.deepcopy(original)
identity = {"number": 173, "state": "open", "draft": False,
            "base": {"ref": "main", "repo": {"full_name": repo}},
            "head": {"ref": branch, "sha": "old", "repo": {"full_name": repo}},
            "mergeable": True, "mergeable_state": "behind"}
current = copy.deepcopy(identity)
effects = []
reads = []
base = "main-1"
invalid = False
uncertain = False

def content(repository, path, head):
    reads.append((path, head))
    return (b"previous" if head.startswith("main-") else
            b"invalid" if invalid else b"selected-recipe", "blob")

def api(path, *options):
    if options:
        effects.append((path, options))
        if uncertain:
            raise RuntimeError("response lost")
        return {"message": "Updating pull request branch"}
    return copy.deepcopy(current)

g["main_sha"] = lambda _: base
g["e2e_issue_recipe"] = lambda _: b"selected-recipe"
g["content"] = content
g["gh"] = lambda *args: json.dumps([pr])
g["api"] = api

def observe():
    output = io.StringIO()
    with redirect_stdout(output):
        result = read(repo, {}, pins, 42)
    return result, output.getvalue()

result, message = observe()
assert result == (base, False)
assert "refresh requested" in message
assert effects == [(f"repos/{repo}/pulls/173/update-branch",
                    ("--method", "PUT", "-f", "expected_head_sha=old"))]
assert (issue, "old") in reads
_, message = observe()
assert "awaiting read-back/checks" in message
assert len(effects) == 1

# A new head has no authority from the old successful checks.
base = "main-2"
pr["headRefOid"] = "refreshed"
pr["mergeStateStatus"] = "CLEAN"
for checks in ([], [{"name": "verify", "status": "IN_PROGRESS"}],
               [{"name": "verify", "conclusion": "FAILURE"}]):
    pr["statusCheckRollup"] = checks
    assert observe()[0] == (base, False)
assert (issue, "main-2") in reads and (issue, "refreshed") in reads
pr["statusCheckRollup"] = [passed]
assert observe()[0] == (base, pr)
assert len(effects) == 1

# Revalidation rejects both unexpected files and changed selected contents.
for bad_files in (True, False):
    pr["files"] = [{"path": issue}, {"path": "unrelated"}] if bad_files else [
        {"path": issue}]
    invalid = not bad_files
    try:
        observe()
        raise AssertionError("invalid consumer accepted")
    except RuntimeError as error:
        assert "unexpected" in str(error)
assert len(effects) == 1
invalid = False

# Immediate pre-effect identity/head changes and conflicts cannot mutate.
for field, value in (("state", "closed"), ("draft", True),
                     ("number", 174), ("mergeable", False),
                     ("mergeable_state", "unknown"),
                     ("head", {**identity["head"], "sha": "concurrent"}),
                     ("head", {**identity["head"], "ref": "other"}),
                     ("head", {**identity["head"], "repo": None}),
                     ("base", {**identity["base"], "ref": "other"})):
    g["REFRESH_ATTEMPTS"].clear()
    pr = copy.deepcopy(original)
    current = {**copy.deepcopy(identity), field: value}
    result, message = observe()
    assert result == (base, False), (field, message)
    assert len(effects) == 1, (field, message)

current = copy.deepcopy(identity)
g["REFRESH_ATTEMPTS"].clear()
uncertain = True
_, message = observe()
assert "provider uncertainty" in message
assert len(effects) == 2
observe()
assert len(effects) == 2
# An ambiguous effect is reconciled through the normal exact-head reader.
pr["headRefOid"] = "reconciled"
pr["mergeStateStatus"] = "CLEAN"
assert observe()[0] == (base, pr)
assert (issue, "reconciled") in reads

# Native conflict states and ineligible listed PRs never request updates.
g["REFRESH_ATTEMPTS"].clear()
pr = copy.deepcopy(original)
pr["mergeStateStatus"] = "DIRTY"
assert "merge conflict" in observe()[1]
for field in ("isDraft", "isCrossRepository"):
    pr = {**copy.deepcopy(original), field: True}
    try:
        observe()
        raise AssertionError("ineligible consumer accepted")
    except RuntimeError as error:
        assert "not eligible" in str(error)
assert len(effects) == 2

# The shared validator preserves producer and CLI installer pin checks.
g["consumer_workflows"] = lambda *_: (issue, module["WAKE"])
config = {"repository": {"runner": {"actionCoreCommit": "c" * 40,
                                     "actionCommit": "d" * 40}}}
old_pins = {"core": {"commit": "c" * 40}, "action": {"commit": "d" * 40},
            "artifact": {"id": 0}}
for target in (module["CORE"], module["ACTION"], "taco3064/gh-nibfin"):
    old_files = {issue: b"core " + b"c" * 40,
                 module["WAKE"]: b"core " + b"c" * 40 + b" action " + b"d" * 40,
                 module["PIN_PATH"]: json.dumps(old_pins).encode(),
                 "internal/cli/producers.json": json.dumps(old_pins).encode()}
    g["content"] = lambda repository, path, head: (old_files[path], "blob")
    expected = module["replacements"](target, config, pins, base,
                                       (issue, module["WAKE"]))
    head_files = {path: value if isinstance(value, bytes) else
                  json.dumps(value).encode() for path, value in expected.items()}
    def pin_content(repository, path, head):
        return ((old_files if head == base else head_files)[path], "blob")
    g["content"] = pin_content
    pr = {**copy.deepcopy(original), "mergeStateStatus": "CLEAN",
          "files": [{"path": path} for path in expected]}
    assert read(target, config, pins) == (base, pr)
    for path in expected:
        saved = head_files[path]
        head_files[path] = b"{}" if not isinstance(expected[path], bytes) else b"bad"
        try:
            read(target, config, pins)
            raise AssertionError("invalid pin accepted")
        except RuntimeError as error:
            assert "unexpectedly" in str(error)
        head_files[path] = saved
assert len(effects) == 2
`, script.pathname], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
