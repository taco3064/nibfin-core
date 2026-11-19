import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

for (const scenario of ['success', 'docs', 'get-422', 'get-json', 'post-422',
  'network', 'lost', 'post-json', 'foreign']) {
  test(`actual maintenance selector retains native dispatch outcome: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
      'test/core-maintenance-dispatch-fixture.mjs', scenario], { encoding: 'utf8' });
    const noWrite = ['docs', 'get-422', 'get-json'].includes(scenario);
    assert.ok(result.stderr.includes(`fixture-posts=${noWrite ? 0 : 1}`));
    assert.ok(!/secret-/.test(result.stdout + result.stderr));
    if (scenario === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { status: 'dispatched',
        cdRunId: 31, artifactId: 44, maintenance: { runId: 99,
          url: 'https://github.com/taco3064/nibfin-core/actions/runs/99' } });
    } else if (scenario === 'docs') {
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).status, 'unavailable');
    } else {
      assert.equal(result.status, 2, result.stderr);
      const diagnostic = JSON.parse(result.stderr.split('\n')[0]);
      assert.equal(diagnostic.code, 'GITHUB_API_RETRY_PENDING');
      assert.deepEqual(diagnostic.githubApi, scenario.endsWith('422') ?
        { kind: 'http', httpStatus: 422 } :
        { kind: scenario === 'network' ? 'network' : 'invalid-response' });
    }
  });
}
