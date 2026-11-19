"""Controlled native provider/filesystem ports; all fixtures stay in this repo."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "rollout_coordinator", ROOT / "scripts/core_rollout_coordinator.py")
COORDINATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COORDINATOR)
ADMIN_SPEC = importlib.util.spec_from_file_location(
    "rollout_admin", ROOT / "scripts/core-rollout-admin.py")
ADMIN = importlib.util.module_from_spec(ADMIN_SPEC)
ADMIN_SPEC.loader.exec_module(ADMIN)


def require(value, message):
    if not value:
        raise RuntimeError(message)


class CoordinatorReplay(unittest.TestCase):
    def setUp(self):
        base = ROOT / ".deliver-test-tmp"
        base.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name)
        self.path = self.config / "rollout-plan.json"
        self.pins = {"core": {"commit": "a" * 40},
                     "action": {"commit": "b" * 40}}
        self.merged = set()
        self.writes = []
        self.fail = None
        self.observe_error = False
        self.runtime = SimpleNamespace(
            CONFIG=self.config, ACTION="action", E2E="e2e", CLI="fixed-manager",
            LAST_PR_CLEANUP=self.config / "cleanup", require=require,
            main_sha=lambda repo: "c" * 40,
            content=lambda *args: (json.dumps(self.pins["core"]).encode(), None),
            api=lambda path: {"status": "ahead", "permissions": {"push": True}},
            stage_package=lambda *args: {"commit": "a" * 40},
            stage_bindings=lambda *args, **kwargs: None,
            close_superseded_rollouts=lambda *args: None,
            write_config=self.save, pool_step=self.pool,
            runner_services=lambda hosts: [], read_consumer=self.consumer,
            gh=self.merge, run=self.apply, finish=self.finish)

    def save(self, path, value):
        path.write_text(json.dumps(value))

    def consumer(self, repo, *args):
        if self.observe_error:
            raise OSError("provider observation unavailable")
        if repo in self.merged:
            return "main", None
        return "main", {"number": 7, "headRefOid": "d" * 40}

    def pool(self, operation):
        plan = json.loads(self.path.read_text())
        if operation == "prepare":
            plan["binding"] = {}
        if operation == "close":
            plan["phase"] = "draining"
        if operation == "stop":
            plan["phase"] = "applying"
        self.save(self.path, plan)
        return {"status": operation}

    def merge(self, *args):
        repo = args[3]
        if self.fail == "before":
            self.fail = None
            raise OSError("request not sent")
        self.merged.add(repo)
        self.writes.append(("merge", repo))
        if self.fail == "after":
            self.fail = None
            raise OSError("write response lost")

    def apply(self, *args):
        self.writes.append(("apply", "core"))
        return json.dumps({"status": "installed"})

    def finish(self, services):
        self.writes.append(("release", "pool"))
        self.path.unlink()

    def replay(self):
        COORDINATOR.rollout(self.runtime, {"core": {}}, (123, self.pins, []))

    def test_lost_merge_response_reuses_confirmed_native_write(self):
        self.fail = "after"
        with self.assertRaises(OSError):
            self.replay()
        self.replay()
        self.assertEqual(self.writes.count(("merge", "core")), 1)
        self.assertEqual(self.writes.count(("merge", "e2e")), 1)
        self.assertEqual(self.writes.count(("apply", "core")), 1)

    def test_successful_read_without_merge_reenters_native_merge(self):
        self.fail = "before"
        with self.assertRaises(OSError):
            self.replay()
        self.replay()
        self.assertEqual(self.writes.count(("merge", "core")), 1)
        self.assertFalse(self.path.exists())

    def test_failed_observation_is_not_absent_result(self):
        self.observe_error = True
        with self.assertRaises(OSError):
            self.replay()
        self.assertEqual(self.writes, [])
        self.observe_error = False
        self.replay()
        self.assertEqual(self.writes.count(("apply", "core")), 1)

    def test_not_ready_consumers_have_no_stop_or_apply_effect(self):
        self.runtime.read_consumer = lambda *args: ("main", False)
        self.replay()
        self.assertEqual(self.writes, [])
        self.assertFalse(self.path.exists())

    def test_preflight_pending_is_not_reported_as_installed(self):
        self.runtime.CORE = "core"
        self.runtime.HOSTS = {"core": "host.json"}
        self.runtime.rollout = lambda *args: {"status": "pending"}
        self.save(self.config / "host.json", {"installation": {
            "pin": self.pins["core"]}})
        with patch.object(ADMIN, "chosen_target", return_value=(123, self.pins, [])), \
                patch.object(ADMIN, "bridge", return_value={
                    "status": "observed", "pin": self.pins["core"]}), \
                patch.object(ADMIN, "continuation") as complete:
            result = ADMIN.operation(self.runtime, {"runId": 123, "artifactId": 456})
        self.assertEqual(result["installation"], "pending")
        complete.assert_not_called()

    def test_completed_installation_retries_only_pending_or_paused_continuation(self):
        target = {"runId": 123, "artifactId": 456}
        pin = self.pins["core"]
        self.runtime.CORE = "core"
        self.runtime.HOSTS = {"core": "host.json"}
        self.save(self.config / "host.json", {"installation": {"pin": pin}})
        self.assertFalse((self.config / "core-rollout-operation.json").exists())
        self.assertFalse(self.path.exists())
        self.merged = {"core", "e2e"}
        for status in ("pending", "paused", "dispatched"):
            with patch.object(ADMIN, "bridge", return_value={
                    "status": "observed", "pin": pin}), \
                    patch.object(ADMIN, "chosen_target", return_value=(
                        123, self.pins, [])), \
                    patch.object(ADMIN, "continuation", return_value={
                        "status": status, "results": []}):
                result = ADMIN.operation(self.runtime, target)
            self.assertEqual(result["installation"], "complete")
            self.assertEqual(result["continuation"]["status"], status)
        self.assertEqual(self.writes, [])

    def test_read_failure_never_reenters_installation_as_absence(self):
        self.runtime.CORE = "core"
        self.runtime.HOSTS = {"core": "host.json"}
        self.runtime.rollout = lambda *args: self.writes.append("unexpected rollout")
        self.save(self.config / "host.json", {"installation": {
            "pin": self.pins["core"]}})
        with patch.object(ADMIN, "chosen_target", return_value=(123, self.pins, [])), \
                patch.object(ADMIN, "bridge", side_effect=OSError("read unavailable")):
            with self.assertRaises(OSError):
                ADMIN.operation(self.runtime, {"runId": 123, "artifactId": 456})
        self.assertEqual(self.writes, [])

    def test_successful_read_of_different_installed_target_reenters_coordinator(self):
        self.runtime.CORE = "core"
        self.runtime.HOSTS = {"core": "host.json"}
        self.save(self.config / "host.json", {"installation": {
            "pin": {"commit": "c" * 40}}})

        def rollout(*args):
            self.writes.append("normal coordinator")
            return {"status": "pending"}

        self.runtime.rollout = rollout
        with patch.object(ADMIN, "chosen_target", return_value=(123, self.pins, [])), \
                patch.object(ADMIN, "bridge", return_value={
                    "status": "observed", "pin": {"commit": "c" * 40}}):
            result = ADMIN.operation(self.runtime, {"runId": 123, "artifactId": 456})
        self.assertEqual(result["installation"], "pending")
        self.assertEqual(self.writes, ["normal coordinator"])

    def test_exact_native_artifact_is_required(self):
        self.runtime.CORE = "core"
        target = {"runId": 123, "artifactId": 456}
        self.runtime.api = lambda path: {"name": "nibfin-activate-" + "a" * 40,
                                        "expired": False, "workflow_run": {"id": 123}}
        self.runtime.next_rollout = lambda *args: (123, self.pins, [
            {"id": 456, "name": "nibfin-activate-" + "a" * 40}])
        host = {"installation": {"pin": {"commit": "c" * 40}}}
        self.assertIsNotNone(ADMIN.chosen_target(self.runtime, target, host))
        self.runtime.next_rollout = lambda *args: (123, self.pins, [
            {"id": 789, "name": "nibfin-activate-" + "a" * 40}])
        with self.assertRaises(RuntimeError):
            ADMIN.chosen_target(self.runtime, target, host)


if __name__ == "__main__":
    unittest.main()
