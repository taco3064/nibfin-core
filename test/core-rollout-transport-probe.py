"""Controlled provider ports; real Node publisher and Python coordinator transport."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("coordinator_tests",
    ROOT / "test/core_rollout_coordinator_test.py")
TESTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TESTS)
ADMIN = TESTS.ADMIN
node, kind = sys.argv[1:]
secret = "DO-NOT-PUBLISH-provider-token-url-body"
error = {"message": secret, "body": secret, "url": secret, "token": secret}
if kind in ("422", "network", "invalid-response", "installed-422"):
    error["githubApiRead"] = True
    if kind.endswith("422"):
        error["status"] = 422
    else:
        error["githubReadFailure"] = kind
elif kind in ("uid", "signature"):
    error["code"] = ("CORE_MAINTENANCE_INVOKER_CHANGED" if kind == "uid"
                     else "OIDC_SIGNATURE_INVALID")
publisher = (ROOT / "src/command-result.mjs").as_uri()
producer = (ROOT / "src/core-rollout-result.mjs").as_uri()
value = ({"status": "unsupported", "code": "CORE_ONLY_MAINTENANCE_REQUIRED",
          "reasons": ["installed-runtime-or-service-change"]}
         if kind == "unsupported" else None)
script = ("import {writeCommandResult} from " + json.dumps(publisher) + "; "
          "import {rolloutFailure} from " + json.dumps(producer) + "; "
          "writeCommandResult(" + (json.dumps(value) if value else
                                    "rolloutFailure(" + json.dumps(error) + ")") + ");")
if kind == "mixed":
    mixed = (ROOT / "test/core-rollout-mixed-fixture.mjs").as_uri()
    script = ("import {writeCommandResult} from " + json.dumps(publisher) + "; "
              "import {mixedResult} from " + json.dumps(mixed) + "; "
              "writeCommandResult(await mixedResult());")
if kind.startswith("authority-"):
    authority = (ROOT / "test/core-rollout-authority-fixture.mjs").as_uri()
    script = ("import {writeCommandResult} from " + json.dumps(publisher) + "; "
              "import {authorityResult} from " + json.dumps(authority) + "; "
              "writeCommandResult(await authorityResult(" +
              json.dumps(kind.removeprefix("authority-")) + "));")
published = subprocess.run([node, "--input-type=module", "-e", script],
                           capture_output=True)
if kind == "malformed":
    published = subprocess.CompletedProcess([], 0, secret.encode(), b"")
fixture = TESTS.CoordinatorReplay(methodName="runTest")
fixture.setUp()
runtime = fixture.runtime
runtime.CORE, runtime.HOSTS = "core", {"core": "host.json"}
runtime.sync_directory = lambda path: None
runtime.rollout = lambda hosts, selected: TESTS.COORDINATOR.rollout(
    runtime, hosts, selected)
fixture.save(fixture.config / "host.json", {"installation": {"pin": {"commit": "c"*40}}})
real_bridge = ADMIN.bridge
calls = []


def bridge(operation, *args, **kwargs):
    calls.append(operation)
    if operation == "observe-installed":
        return {"status": "observed", "pin": {"commit": "c"*40}}
    return real_bridge(operation, *args, **kwargs)


try:
    with patch.object(ADMIN, "node_path", return_value=node), \
            patch.object(ADMIN.subprocess, "run", return_value=published):
        if kind == "mixed":
            result = ADMIN.RESULTS.read_result(published)
        elif kind == "installed-422":
            fixture.merged = {"core", "e2e"}
            fixture.save(fixture.config / "host.json", {"installation": {
                "pin": fixture.pins["core"]}})

            def observed(operation, *args, **kwargs):
                return {"status": "observed", "pin": fixture.pins["core"]}

            with patch.object(ADMIN, "chosen_target",
                              return_value=(123, fixture.pins, [])), \
                    patch.object(ADMIN, "bridge", side_effect=observed):
                def continuation():
                    real_bridge("observe-installed")

                with patch.object(ADMIN, "continuation", side_effect=continuation):
                    result = ADMIN.operation(runtime, {"runId": 123, "artifactId": 456})
        elif kind == "unsupported":
            runtime.pool_step = lambda operation: bridge("pool", operation)
            with patch.object(ADMIN, "chosen_target",
                              return_value=(123, fixture.pins, [])), \
                    patch.object(ADMIN, "bridge", side_effect=bridge):
                result = ADMIN.operation(runtime, {"runId": 123, "artifactId": 456},
                                         core_only=True)
            assert not fixture.path.exists(), "Unsupported preparation left a plan"
            assert calls == ["observe-installed", "pool"], calls
        else:
            try:
                real_bridge("pool", "prepare")
                raise AssertionError("Failure was accepted as successful work")
            except ADMIN.RESULTS.CoreRolloutFailure as error:
                result = ADMIN.RESULTS.failure_result(error)
    assert fixture.writes == [], fixture.writes
    print(json.dumps(result))
    sys.exit(ADMIN.RESULTS.result_exit(result))
finally:
    fixture.doCleanups()
