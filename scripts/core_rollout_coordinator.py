"""One-target coordinator; discovery and privileged entry are callers."""
import json


def rollout(runtime, hosts, selected):
    run_id, pins, artifacts = selected
    path = runtime.CONFIG / "rollout-plan.json"
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    action_main = runtime.main_sha(runtime.ACTION)
    path_compare = f"repos/{runtime.ACTION}/compare/{action}...{action_main}"
    comparison = runtime.api(path_compare)["status"]
    runtime.require(comparison in ("identical", "ahead") and
            json.loads(runtime.content(runtime.ACTION,
                       "core-source.json", action)[0]) == pins["core"],
            "Action main does not contain the verified Core pin")
    consumers = {repo: runtime.read_consumer(repo, config, pins, run_id)
                 for repo, config in hosts.items()}
    consumers[runtime.E2E] = runtime.read_consumer(runtime.E2E, None, pins, run_id)
    if any(pr is False for _, pr in consumers.values()):
        return {"status": "pending", "code": "CORE_ROLLOUT_CONSUMER_PENDING"}
    for repo in (*hosts, runtime.E2E):
        permissions = runtime.api(f"repos/{repo}").get("permissions", {})
        runtime.require(permissions.get("push") is True,
                f"{repo} consumer promotion permission is unavailable")
    source = runtime.stage_package(pins, artifacts)
    previous = json.loads(path.read_text()) if path.exists() else None
    # Minimal legacy plans may already have stopped services. Never treat their
    # target commit as completion. Rebind and observe before any further effect.
    if not previous or previous.get("schemaVersion") != 2:
        wanted = {"schemaVersion": 2, "pin": pins["core"], "actionCommit": action,
                  "candidate": pins, "runId": run_id, "phase": "prepared",
                  "pending": "ROLLOUT_PREFLIGHT_REQUIRED", "mergeIntents": {}}
        if hasattr(runtime, "prepare_plan"):
            wanted = runtime.prepare_plan(wanted)
        runtime.write_config(path, wanted)
    plan = json.loads(path.read_text())
    runtime.require(plan["candidate"] == pins and plan["runId"] == run_id,
            "Rollout target changed after drain began")
    if plan["phase"] == "prepared":
        # Validate prospective bindings and permissions before closing admission.
        runtime.stage_bindings(hosts, consumers, pins, source, preflight=True)
        if (not runtime.LAST_PR_CLEANUP.exists() or
                json.loads(runtime.LAST_PR_CLEANUP.read_text()) != run_id):
            runtime.close_superseded_rollouts(core)
            runtime.write_config(runtime.LAST_PR_CLEANUP, run_id)
        preparation = runtime.pool_step("prepare")
        if preparation.get("status") == "unsupported":
            return preparation
        prepared = json.loads(path.read_text())
        if prepared.get("apply", {}).get("completed"):
            runtime.finish(runtime.runner_services(hosts))
            return {"status": "installed"}
        runtime.pool_step("close")
    runtime.pool_step("settle" if plan.get("mode") == "core-only" else "stop")
    plan = json.loads(path.read_text())
    for repo, (_, pr) in consumers.items():
        if not pr:
            continue
        # A successful current read has found this PR unfinished. Re-enter its
        # native exact-head merge; a missing earlier response is not a gate.
        # The validated PR is read again immediately before the effect.
        _, fresh = runtime.read_consumer(repo, hosts.get(repo), pins, run_id)
        runtime.require(fresh and fresh["headRefOid"] == pr["headRefOid"],
                f"{repo} rollout head or checks changed")
        plan["mergeIntents"][repo] = {
            "number": pr["number"], "head": pr["headRefOid"]}
        runtime.write_config(path, plan)
        runtime.gh("pr", "merge", "-R", repo, str(pr["number"]), "--rebase",
           "--match-head-commit", pr["headRefOid"])
    current_consumers = {repo: runtime.read_consumer(repo, hosts.get(repo), pins)
                         for repo in (*hosts, runtime.E2E)}
    runtime.require(all(pr is None for _, pr in current_consumers.values()),
            "Consumer merge has not been read back")
    runtime.stage_bindings(hosts, current_consumers, pins, source)
    result = json.loads(runtime.run("node", runtime.CLI, "promote-host"))
    runtime.require(result["status"] == "installed", "Host promotion failed")
    print(f"CD {run_id} installed Core {core} with Action {action}", flush=True)
    runtime.finish(runtime.runner_services(hosts))
    return {"status": "installed"}
