import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';

const fixtureParent = resolve('.deliver-test-tmp');
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(resolve(fixtureParent, 'rollout-timer-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const pythonOptions = {
  encoding: 'utf8',
  env: { ...process.env, TMPDIR: fixtureRoot, TMP: fixtureRoot, TEMP: fixtureRoot,
    PYTHONDONTWRITEBYTECODE: '1' },
};

// Controlled Python coordinator, not a live systemd/GitHub rollout. All effects
// use the same maintained coordinator functions called by the explicit administrator.
test('one-target coordinator closes admission and reconciles unknown merges', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("rollout_fixture", sys.argv[1])
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
module = vars(runtime)
rollout = module["rollout"]
g = rollout.__globals__
g["CLI"] = Path(sys.argv[1]).resolve().parent.parent / "bin/nibfin-core.mjs"
core, action, e2e = g["CORE"], g["ACTION"], g["E2E"]
pins = {"core": {"repository": core, "commit": "a" * 40},
        "action": {"repository": action, "commit": "b" * 40}, "artifact": {}}
pr = {"number": 1, "headRefOid": "c" * 40}
hosts = {core: {}, action: {}, "taco3064/gh-nibfin": {}}
effects, state = [], dict(busy=True, merged=False, posts=0, read_error=False)
g["main_sha"] = lambda repo: "d" * 40
g["content"] = lambda *args: (json.dumps(pins["core"]).encode(), "blob")
g["stage_package"] = lambda *args: {}
g["close_superseded_rollouts"] = lambda *args: None
g["stage_bindings"] = lambda *args, **kwargs: effects.append("bindings")
g["api"] = lambda path: ({"status": "ahead"} if "/compare/" in path else
                         {"permissions": {"push": True}})
def read_consumer(*args):
    if state["read_error"]:
        raise OSError("native observation unavailable")
    return "base", None if state["merged"] else pr

g["read_consumer"] = read_consumer

def pool_step(step):
    path = g["CONFIG"] / "rollout-plan.json"
    plan = json.loads(path.read_text())
    effects.append(step)
    if step == "close":
        plan.update(phase="draining", binding={"pool": "original"})
    if step == "stop":
        assert "close" in effects
        if state["busy"]:
            raise RuntimeError("active lease")
        plan["phase"] = "applying"
    g["write_config"](path, plan)
    return {"status": {"prepare": "prepared", "close": "closed",
                       "stop": "stopped", "verify": "verified",
                       "release": "complete"}[step]}

def gh(*args):
    state["posts"] += 1
    raise RuntimeError("lost merge response")

g["pool_step"], g["gh"] = pool_step, gh
def run(*args):
    assert args[-1] == "promote-host"
    effects.append("apply")
    return b'{"status":"installed"}'

g["run"] = run
g["finish"] = lambda *args: effects.append("finish")
with tempfile.TemporaryDirectory() as directory:
    g["CONFIG"] = Path(directory)
    g["LAST_PR_CLEANUP"] = Path(directory) / "cleanup"
    selected = (10, pins, [])
    try:
        rollout(hosts, selected)
        raise AssertionError("active work must hold drain")
    except RuntimeError as error:
        assert str(error) == "active lease"
    path = g["CONFIG"] / "rollout-plan.json"
    saved = json.loads(path.read_text())
    assert saved["phase"] == "draining" and saved["candidate"] == pins
    assert state["posts"] == 0 and "apply" not in effects
    state["busy"] = False
    try:
        rollout(hosts, selected)
        raise AssertionError("lost response must be pending")
    except RuntimeError as error:
        assert str(error) == "lost merge response"
    assert state["posts"] == 1
    try:
        rollout(hosts, selected)
        raise AssertionError("an unfinished native PR must retry its merge")
    except RuntimeError as error:
        assert str(error) == "lost merge response"
    assert state["posts"] == 2
    state["read_error"] = True
    before = list(effects)
    try:
        rollout(hosts, selected)
        raise AssertionError("a failed observation cannot establish absence")
    except OSError as error:
        assert str(error) == "native observation unavailable"
    assert effects == before and state["posts"] == 2
    assert json.loads(path.read_text())["candidate"] == pins
    assert json.loads(path.read_text())["runId"] == 10
    state["read_error"] = False
    state["merged"] = True
    assert rollout(hosts, selected) == {"status": "installed"}
    assert effects[-1] == "finish"
    assert effects.count("apply") == 1 and state["posts"] == 2
`, resolve('scripts/host-auto-rollout.py')], pythonOptions);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

// The exact saved run remains authoritative after newer CD runs fill discovery.
test('explicit CD retry revalidates its native origin and activation', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import json, runpy, sys
module = runpy.run_path(sys.argv[1])
select = module["next_rollout"]
g = select.__globals__
core, action = g["CORE"], g["ACTION"]
current, target = "a" * 40, "b" * 40
pins = {"core": {"repository": core, "commit": target},
        "action": {"repository": action, "commit": "c" * 40}}
saved = dict(id=100, path=".github/workflows/cd.yml", head_branch="main",
             event="workflow_run", status="completed", conclusion="success",
             head_repository={"full_name": core})
record = dict(saved)
artifacts = [{"name": "nibfin-activate-" + target, "expired": False}]
requests, checked = [], []

def api(path):
    requests.append(path)
    if path == f"repos/{core}/actions/runs/100":
        return record
    if "/workflows/cd.yml/runs?" in path:
        return {"workflow_runs": [{**saved, "id": n} for n in range(115, 100, -1)]}
    if path == f"repos/{core}/actions/runs/100/artifacts":
        return {"artifacts": artifacts}
    if path == f"repos/{core}/compare/{current}...{target}":
        return {"status": "ahead"}
    raise AssertionError(path)

def artifact(items, name, files):
    checked.append(name)
    assert items == artifacts and files == ["activation.json"]
    return {"activation.json": json.dumps(pins).encode()}

g.update(api=api, artifact=artifact, has_main_ci=lambda commit: commit == target)
assert select(current, target, 100) == (100, pins, artifacts)
assert requests[0] == f"repos/{core}/actions/runs/100"
assert not any("/workflows/" in path for path in requests)
assert checked == ["nibfin-activate-" + target]
for key, value in (("id", 101), ("path", ".github/workflows/ci.yml"),
                   ("head_branch", "other"), ("event", "pull_request"),
                   ("status", "in_progress"), ("conclusion", "failure"),
                   ("head_repository", {"full_name": "someone/fork"})):
    record = {**saved, key: value}
    requests.clear()
    assert select(current, target, 100) is None, key
    assert requests == [f"repos/{core}/actions/runs/100"], key
record = {**saved, "event": "workflow_dispatch"}
assert select(current, target, 100) == (100, pins, artifacts)
record = dict(saved)
artifacts[0]["expired"] = True
assert select(current, target, 100) is None
artifacts[0]["expired"] = False
assert select(current, "d" * 40, 100) is None
g["has_main_ci"] = lambda commit: False
try:
    select(current, target, 100)
    raise AssertionError("main CI must still be required")
except RuntimeError as error:
    assert "main CI" in str(error)
`, resolve('scripts/host-auto-rollout.py')], pythonOptions);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('retired discovery entry cannot start a scan or installation', () => {
  const result = spawnSync('python3', [resolve('scripts/host-auto-rollout.py')],
    pythonOptions);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /installed fixed Core administrator/);
  assert.equal(result.stdout, '');
});
