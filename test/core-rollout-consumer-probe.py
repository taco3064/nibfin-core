"""Actual unchanged load_runtime/read_consumer with production Node provider adapter."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("rollout_admin",
    ROOT / "scripts/core-rollout-admin.py")
ADMIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADMIN)
node, kind = sys.argv[1:]
base = ROOT / ".deliver-test-tmp"
base.mkdir(exist_ok=True)
native_run = subprocess.run
with tempfile.TemporaryDirectory(dir=base) as directory:
    state_path = Path(directory) / "provider.json"
    state_path.write_text(json.dumps({"behind": kind == "behind", "calls": []}))

    def provider_run(args, **kwargs):
        kwargs["env"] = {**kwargs.get("env", {}),
                         "CORE_PROVIDER_FIXTURE": str(state_path)}
        return native_run(args, **kwargs)

    with patch.object(ADMIN, "node_path", return_value=node), \
            patch.object(ADMIN, "ENTRY", ROOT / "test/core-rollout-provider-probe.mjs"), \
            patch.object(ADMIN.subprocess, "run", side_effect=provider_run):
        runtime = ADMIN.load_runtime()
        pins = {"core": {"commit": "a"*40}, "action": {"commit": "b"*40}, "artifact": {}}
        config = {"repository": {"runner": {
            "actionCoreCommit": "c"*40, "actionCommit": "d"*40}}}
        first = runtime.read_consumer(runtime.CORE, config, pins)
        if kind in ("ready", "merged"):
            assert first[1]["number"] == 1
            if kind == "merged":
                try:
                    runtime.gh("pr", "merge", "-R", runtime.CORE, "1", "--rebase",
                               "--match-head-commit", first[1]["headRefOid"])
                    raise AssertionError("Lost response was treated as confirmed")
                except ADMIN.RESULTS.CoreRolloutFailure as error:
                    assert error.result["code"] == "PROCESS_FAILED"
                    assert "githubApi" not in error.result
                assert runtime.read_consumer(runtime.CORE, config, pins)[1] is None
        else:
            assert first[1] is False
            assert runtime.read_consumer(runtime.CORE, config, pins)[1] is False
    state = json.loads(state_path.read_text())
    lists = [call for call in state["calls"] if isinstance(call, list) and call[:2]
             == ["pr", "list"]]
    assert len(lists) == (2 if kind == "behind" else 1), state
    writes = [call for call in state["calls"]
              if isinstance(call, list) and call[0] == "api"]
    assert len(writes) == (1 if kind == "behind" else 0), state
    if kind == "behind":
        assert any(isinstance(call, str) and call.endswith("1"*40)
                   for call in state["calls"]), "Updated head was not read back"
    merges = [call for call in state["calls"] if isinstance(call, list)
              and call[:2] == ["pr", "merge"]]
    assert len(merges) == (1 if kind == "merged" else 0), state
