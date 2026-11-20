import importlib.util
from contextlib import nullcontext
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load_bridge():
    path = Path(__file__).resolve().parent.parent / 'scripts/core-maintenance-bridge.py'
    spec = importlib.util.spec_from_file_location('upgrade_bridge_test', path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


BRIDGE = load_bridge()
ACTIVATION = {'runId': 7, 'artifactId': 8}


class ContinuationBoundary(unittest.TestCase):
    def setUp(self):
        self.promotions = 0
        self.dispatches = 0
        self.queries = []
        self.observation = None
        self.retirement = [{'status': 'retained', 'code': 'PACKAGE_GATE_PENDING'}]
        self.progress = {'operationId': 'upgrade-operation', 'installation': 'installed',
                         'readiness': 'pending',
                         'readinessCause': {'code': 'JOB_VM_HOST_MEMORY_PRESSURE'}}
        self.admin = SimpleNamespace(continue_installed=self.dispatch,
                                     RESULTS=SimpleNamespace(result_exit=lambda _: 0))

    def manager(self, payload, _kind):
        # Normal Core target readback prevents a second completed promotion.
        if not self.promotions:
            self.promotions += 1
        return {'status': 'installed', 'installation': 'complete',
                'completion': {'status': 'observed'}}, 0

    def upgrade(self, **request):
        self.queries.append(request)
        if request['kind'] == 'upgrade-installed':
            if self.observation is not None:
                return self.observation
            if request['activation'] != ACTIVATION:
                return {'upgradeOperations': []}
            return {'upgradeOperations': [self.progress]}
        if request['kind'] == 'upgrade-settle':
            return {'upgrade': {**self.progress, 'continuation': 'dispatched'}}
        raise AssertionError(request)

    def dispatch(self, value):
        self.dispatches += 1
        return {**value, 'continuation': {'status': 'dispatched', 'results': []}}

    def run_bridge(self, activation=ACTIVATION):
        with (
            patch.object(BRIDGE, 'fresh_manager_result', self.manager),
            patch.object(BRIDGE, 'retire_packages', lambda: self.retirement),
            patch.object(BRIDGE, 'normal_installer', lambda: {'status': 'installed'}),
            patch.object(BRIDGE, 'manager_package',
                         lambda: nullcontext(Path('/manager'))),
            patch.object(BRIDGE, 'module_at', lambda *_: self.admin),
            patch.object(BRIDGE, 'upgrade_request', self.upgrade),
        ):
            request = json.dumps({'kind': 'maintenance', 'target': activation}).encode()
            return BRIDGE.run(request, 'maintenance')[0]

    def test_pending_then_ready_preserves_completed_promotion(self):
        pending = self.run_bridge()
        self.assertEqual(pending['installation'], 'complete')
        self.assertEqual(pending['cleanup'], self.retirement)
        self.assertEqual(pending['completion'], {'status': 'observed'})
        self.assertEqual(pending['continuation']['code'], 'JOB_VM_HOST_MEMORY_PRESSURE')
        self.assertEqual(self.dispatches, 0)
        self.progress.update(readiness='ready', continuationEligible=True)
        succeeded = self.run_bridge()
        self.assertEqual(succeeded['continuation']['status'], 'dispatched')
        self.assertEqual(succeeded['cleanup'], self.retirement)
        self.assertEqual(succeeded['upgradeOperations'][0]['continuation'], 'dispatched')
        self.assertEqual(self.promotions, 1)
        self.assertEqual(self.dispatches, 1)

    def test_pending_installation_and_unsupported_runtime_do_not_dispatch(self):
        for phase, code in [('installation', 'ADOPTION_UNVERIFIED'),
                            ('readiness', 'JOB_VM_TOOL_OUTPUT_UNAVAILABLE')]:
            self.progress = {'operationId': 'upgrade-operation',
                             phase: 'maintenance-required',
                             phase + 'Cause': {'code': code}}
            self.assertEqual(self.run_bridge()['continuation']['code'], code)
        self.assertEqual(self.dispatches, 0)

    def test_unrelated_cd_continues_despite_another_pending_operation(self):
        result = self.run_bridge({'runId': 10, 'artifactId': 11})
        self.assertEqual(result['continuation']['status'], 'dispatched')
        self.assertEqual(self.dispatches, 1)

    def test_unknown_observation_preserves_provider_cause(self):
        self.observation = {'status': 'pending', 'code': 'GITHUB_API_RETRY_PENDING',
                            'githubApi': {'kind': 'http', 'httpStatus': 429}}
        status = self.run_bridge()['continuation']
        self.assertEqual(status['code'], self.observation['code'])
        self.assertEqual(status['githubApi'], self.observation['githubApi'])
        self.assertEqual(self.dispatches, 0)


if __name__ == '__main__':
    unittest.main()
