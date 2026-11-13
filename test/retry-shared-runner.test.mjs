import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, retrySharedRunner } from '../scripts/retry-shared-runner.mjs';

const repository = { id: 1, full_name: 'taco3064/nibfin-core', default_branch: 'main' };
const run = {
  id: 2, run_attempt: 1, repository, head_repository: repository,
  head_branch: 'main', path: '.github/workflows/shared-runner.yml',
  status: 'completed', conclusion: 'failure', event: 'workflow_dispatch',
  actor: { id: 3 },
};
const marker = '2026-11-13T00:00:00Z ' + JSON.stringify({
  schemaVersion: 1, status: 'pending', code: 'GITHUB_READ_RETRY_PENDING',
  stage: 'continue', retrySettled: true, retryRun: 2, retryAttempt: 1,
  retryAfterMs: 60000,
});

test('retry marker binds the settled result to this run and attempt', () => {
  assert.equal(retryDelay(marker, 2, 1), 60000);
  assert.equal(retryDelay(marker, 2, 2), null);
  assert.equal(retryDelay(marker + '\n' + marker, 2, 1), null);
  assert.equal(retryDelay(marker.replace('60000', '900001'), 2, 1), null);
});

test('a settled failure retries once and skips an already resumed attempt', async () => {
  for (const moved of [false, true]) {
    let current = { ...run };
    const reader = {
      get: async path => path === '/user' ? run.actor : current,
      list: async () => [{
        id: 4, name: 'shared-stage', conclusion: 'failure', status: 'completed',
        run_id: 2, run_attempt: 1,
      }],
    };
    let reruns = 0;
    const result = await retrySharedRunner(reader, { repository, workflow_run: run }, {
      logs: async () => marker,
      rerun: async id => { assert.equal(id, 2); reruns++; },
      wait: async delay => {
        assert.equal(delay, 60000);
        if (moved) current = { ...run, run_attempt: 2 };
      },
    });
    assert.equal(result, !moved);
    assert.equal(reruns, moved ? 0 : 1);
  }
});
