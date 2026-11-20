"""One explicit administrator rollout; no discovery, timer or background worker."""
import sys
sys.dont_write_bytecode = True

import base64
import contextlib
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess


ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "src/core-rollout-manager-entry.mjs"
LIVE_CLI = Path("/opt/nibfin/core/bin/nibfin-core.mjs")
RESULT_SPEC = importlib.util.spec_from_file_location("core_rollout_result",
    ROOT / "scripts/core_rollout_result.py")
RESULTS = importlib.util.module_from_spec(RESULT_SPEC)
RESULT_SPEC.loader.exec_module(RESULTS)


def node_path():
    metadata = ROOT.parent / "runtime.json"
    for path in (metadata, *metadata.parents):
        stat = path.lstat()
        if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise RuntimeError("Untrusted installed administrator runtime")
    value = json.loads(metadata.read_text())
    path = value.get("nodePath")
    if not isinstance(path, str) or not path.startswith("/opt/nibfin/tools/"):
        raise RuntimeError("Untrusted installed administrator runtime path")
    return path


def execute(*args, timeout=None, env=None):
    is_node = bool(args and args[0] == "node")
    if is_node:
        args = (node_path(), *args[1:])
    result = subprocess.run([str(value) for value in args], env=env,
                            capture_output=True)
    if is_node or result.returncode:
        value = RESULTS.read_result(result)
        if value["status"] in ("denied", "pending", "unsupported"):
            raise RESULTS.CoreRolloutFailure(value)
    return result.stdout


def bridge(*args, request=None):
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C"}
    if args and args[0] == "authorize-core-only" and "SUDO_UID" in os.environ:
        environment["SUDO_UID"] = os.environ["SUDO_UID"]
    result = subprocess.run([node_path(), str(ENTRY), *args],
                            input=json.dumps(request).encode() if request else None,
                            capture_output=True,
                            env=environment)
    value = RESULTS.read_result(result)
    if value["status"] in ("denied", "pending"):
        raise RESULTS.CoreRolloutFailure(value)
    return value


def load_runtime():
    path = ROOT / "scripts/host-auto-rollout.py"
    spec = importlib.util.spec_from_file_location("core_rollout_runtime", path)
    runtime = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime
    spec.loader.exec_module(runtime)
    runtime.CLI = ENTRY
    runtime.run = execute
    runtime.PROVIDER_FAILURES = (RESULTS.CoreRolloutFailure,)
    runtime.coordinator_cli = lambda plan=None: ENTRY
    runtime.gh = lambda *args: base64.b64decode(
        bridge("github", request=list(args))["bytes"])
    runtime.api = lambda path, *args: json.loads(runtime.gh("api", path, *args))
    runtime.pool_step = lambda operation: bridge("pool", operation)
    return runtime


def chosen_target(runtime, target, host):
    """Validate exactly the requested native artifact, without a discovery scan."""
    run_id, artifact_id = target["runId"], target["artifactId"]
    item = runtime.api(f"repos/{runtime.CORE}/actions/artifacts/{artifact_id}")
    match = re.fullmatch(r"nibfin-activate-([a-f0-9]{40})", item.get("name", ""))
    runtime.require(match and not item.get("expired") and
                    item.get("workflow_run", {}).get("id") == run_id,
                    "Explicit native CD artifact does not match the target run")
    selected = runtime.next_rollout(host["installation"]["pin"]["commit"],
                                    match[1], run_id)
    runtime.require(selected and any(record["id"] == artifact_id and
                    record["name"] == item["name"] for record in selected[2]),
                    "Verified native CD target is unavailable")
    return selected


def finish(runtime, services):
    """Read back installation, restore our listeners, then release our closure."""
    path = runtime.CONFIG / "rollout-plan.json"
    plan = json.loads(path.read_text())
    runtime.require(plan.get("apply", {}).get("completed"),
                    "Rollout apply is not complete")
    if plan["phase"] != "complete" and plan.get("mode") != "core-only":
        runtime.pool_step("restore")
    runtime.pool_step("release")
    plan = json.loads(path.read_text())
    receipt = {"target": plan["administratorTarget"], "pin": plan["pin"],
               "candidate": plan["candidate"], "runId": plan["runId"],
               "originalServices": plan["originalServices"]}
    runtime.write_config(runtime.CONFIG / "core-rollout-operation.json", receipt)
    for name in (*runtime.HOSTS.values(), runtime.E2E_HOST):
        (runtime.CONFIG / "rollout" / name).unlink(missing_ok=True)
    path.unlink()
    runtime.sync_directory(runtime.CONFIG)
    directory = runtime.CONFIG / "rollout"
    if directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()


def continuation():
    # Only after release: execute the new installed Core in a separate process.
    observed = bridge("observe-installed")
    runtime = observed.get("runtime", {}).get("nodePath")
    if (observed.get("status") != "observed" or not isinstance(runtime, str)
            or not runtime.startswith("/opt/nibfin/tools/")):
        raise RuntimeError("Installed pool runtime observation needs normal retry")
    result = subprocess.run([runtime, str(LIVE_CLI),
                             "complete-installed-lifecycle"], capture_output=True,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    value = RESULTS.read_result(result)
    if value["status"] in ("denied", "pending"):
        raise RESULTS.CoreRolloutFailure(value)
    if value.get("status") not in ("dispatched", "paused", "pending"):
        raise RuntimeError("Installed lifecycle returned an invalid result")
    if not isinstance(value.get("results"), list):
        raise RuntimeError("Installed lifecycle omitted continuation results")
    expected_exit = 2 if value["status"] == "pending" else 0
    if result.returncode != expected_exit:
        raise RuntimeError("Installed lifecycle observation needs normal retry")
    return value


def operation(runtime, target, core_only=False, provenance=None,
              defer_continuation=False, promote_gate=None):
    path = runtime.CONFIG / "rollout-plan.json"
    hosts = {repo: json.loads((runtime.CONFIG / name).read_text())
             for repo, name in runtime.HOSTS.items()}
    plan = json.loads(path.read_text()) if path.exists() else None
    if plan and plan.get("administratorTarget") != target:
        raise RESULTS.CoreRolloutFailure({"status": "denied",
            "code": "CORE_MAINTENANCE_TARGET_CHANGED"})
    runtime.require(not plan or (plan.get("mode") == "core-only") == core_only,
                    "Another rollout mode owns the current operation")
    closure = runtime.CONFIG / "rollout-admission.json"
    if promote_gate and (closure.exists() or
                         plan and (plan.get("phase") != "prepared" or
                                   plan.get("apply"))):
        promote_gate()
        promote_gate = None
    if (core_only and plan and plan.get("phase") == "prepared"
            and not plan.get("apply") and not closure.exists()):
        # Before admission closes there are no installation effects. Retire
        # only this operation's planning record, then observe the actual result.
        # Verified staged bytes and provider effects retain their normal readback.
        path.unlink()
        runtime.sync_directory(runtime.CONFIG)
        plan = None
    def prepare(value):
        result = {**value, "administratorTarget": target}
        if core_only:
            result["mode"] = "core-only"
            if provenance:
                result["maintenanceInvocation"] = provenance
        return result
    runtime.prepare_plan = prepare
    if plan and provenance:
        plan["maintenanceInvocation"] = provenance
        runtime.write_config(path, plan)
    runtime.finish = lambda services: finish(runtime, services)
    if plan and plan.get("apply"):
        if not plan["apply"].get("completed"):
            result = bridge("promote-host")
            runtime.require(result["status"] == "installed", "Apply remains pending")
        finish(runtime, runtime.runner_services(hosts))
    else:
        # Native target discovery and current installed observation do not depend
        # on old local receipts. Neither missing bookkeeping nor old manager code
        # means that the installed package must be installed again.
        selected = chosen_target(runtime, target, hosts[runtime.CORE])
        complete = False
        if not plan:
            current = bridge("observe-installed")
            runtime.require(current.get("status") == "observed",
                            "Installed state observation is incomplete")
            if current.get("pin") == selected[1]["core"]:
                observed = [runtime.read_consumer(repo, hosts.get(repo),
                            selected[1], selected[0])
                            for repo in (*hosts, runtime.E2E)]
                complete = all(pr is None for _, pr in observed)
        if not complete:
            if promote_gate and hosts[runtime.CORE]["installation"]["pin"] == \
                    selected[1]["core"]:
                # Same-source recovery can write release/verification state.
                promote_gate()
                promote_gate = None
            runtime.promote_gate = promote_gate
            outcome = runtime.rollout(hosts, selected)
            if outcome and outcome.get("status") == "unsupported":
                # No installation or closure exists yet. A prepared local record
                # must not block a later compatible target or an explicit mode.
                pending = json.loads(path.read_text()) if path.exists() else None
                closure = runtime.CONFIG / "rollout-admission.json"
                runtime.require(not pending or pending.get("phase") == "prepared"
                                and not pending.get("apply") and not closure.exists()
                                and pending.get("administratorTarget") == target,
                                "Unsupported operation has unresolved effects")
                if pending:
                    path.unlink()
                    runtime.sync_directory(runtime.CONFIG)
                return {**outcome, "installation": "unsupported"}
            if not outcome or outcome.get("status") != "installed" or path.exists():
                return {"status": "pending", "installation": "pending",
                        "code": "CORE_ROLLOUT_STAGE_PENDING"}
    if defer_continuation:
        result = {"status": "installed", "installation": "complete",
                  "continuation": {"status": "pending", "results": [],
                                   "code": "INSTALLED_CONTINUATION_PENDING"}}
        try:
            observed = bridge("observe-installed")
            if observed.get("status") != "observed":
                raise RuntimeError("Installed observation is incomplete")
            result["completion"] = observed
        except (OSError, ValueError, RuntimeError) as error:
            result["continuation"] = RESULTS.failure_result(error, continuation=True)
        return result
    try:
        result = continuation()
    except (OSError, ValueError, RuntimeError) as error:
        result = RESULTS.failure_result(error, continuation=True)
    return {"status": "installed", "installation": "complete",
            "continuation": result}


def operation_gate(config):
    # The fixed Root bridge may pass its existing directory open-description in
    # fd 3. Reopening the directory while its parent holds the exclusive flock
    # would contend with the operation itself. No public path/flag selects this.
    try:
        inherited = os.fstat(3)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise
        return os.open(config, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), False
    expected = config.lstat()
    if (inherited.st_dev != expected.st_dev or inherited.st_ino != expected.st_ino
            or inherited.st_uid != 0 or expected.st_uid != 0
            or not stat.S_ISDIR(inherited.st_mode) or not stat.S_ISDIR(expected.st_mode)
            or (inherited.st_mode | expected.st_mode) & 0o022):
        raise RuntimeError("Inherited rollout gate does not match fixed configuration")
    return 3, True


def continue_after_gate(result, handle):
    # flock conversion is not assumed atomic. Only a successful shared lock
    # permits fresh observation; old completion facts never select executable code.
    completed = {**result}
    completed.pop("completion", None)
    try:
        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        completed["continuation"] = continuation()
    except (OSError, ValueError, RuntimeError) as error:
        completed["continuation"] = RESULTS.failure_result(error, continuation=True)
    return completed


def claim_promotion(handle):
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        value = {"status": "pending", "code": "CORE_MANAGEMENT_OPERATION_PENDING"}
        raise RESULTS.CoreRolloutFailure(value) from error


def main():
    values = sys.argv[1:]
    core_only = bool(values and values[0] == "--core-only")
    if core_only:
        values = values[1:]
    if len(values) != 2 or not all(re.fullmatch(r"[1-9][0-9]*", value)
                                  for value in values):
        raise RuntimeError("Expected one native CD run ID and activation artifact ID")
    bridge("admit")
    groups = Path("/proc/self/cgroup").read_text()
    in_pool = re.search(r"nibfin-shared-runner@(?:1|2)\.service", groups)
    target = {"runId": int(values[0]), "artifactId": int(values[1])}
    provenance = None
    request = sys.stdin.buffer.read() if core_only else b""
    if request:
        supplied = json.loads(request)
        if supplied.get("target") != target:
            raise RESULTS.CoreRolloutFailure({"status": "denied",
                "code": "CORE_MAINTENANCE_TARGET_CHANGED"})
        authorization = bridge("authorize-core-only", request=supplied)
        if authorization.get("status") != "authorized":
            raise RuntimeError("Native maintenance authorization is unavailable")
        provenance = authorization["provenance"]
    if in_pool and not (core_only and provenance):
        raise RESULTS.CoreRolloutFailure({"status": "denied",
            "code": "CORE_MAINTENANCE_IDENTITY_REQUIRED"})
    runtime = load_runtime()
    handle, inherited = operation_gate(runtime.CONFIG)
    try:
        def promote_gate():
            claim_promotion(handle)

        # The signed serving Job is serialized by the fixed GitHub workflow.
        # The inherited shared source lease excludes direct administrators,
        # while permitting ordinary Worker admission during staging/inspection.
        shared_preflight = inherited and provenance is not None
        if not shared_preflight:
            promote_gate()
        with contextlib.redirect_stdout(sys.stderr):
            result = operation(runtime, target, core_only, provenance,
                               defer_continuation=True,
                               promote_gate=promote_gate if shared_preflight else None)
            if result.get("installation") == "complete" and not inherited:
                result = continue_after_gate(result, handle)
        print(json.dumps(result))
        sys.exit(RESULTS.result_exit(result))
    finally:
        os.close(handle)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        result = {**RESULTS.failure_result(error), "installation": "pending"}
        print(json.dumps(result))
        sys.exit(RESULTS.result_exit(result))
