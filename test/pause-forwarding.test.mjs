import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardSharedWake, readForwardedWake } from '../src/shared-wake.mjs';
import { people, pauseIdentity } from './pause-fixture.mjs';

test('shared forwarding keeps pause qualification fields and discards unrelated labels',
  async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pause-forward-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'event.json');
  await writeFile(
    path,
    JSON.stringify({
      action: 'labeled',
      label: { name: 'pause' },
      sender: people.assignee,
      repository: { id: 10, full_name: 'example/core' },
      issue: {
        number: 2,
        node_id: 'I_target',
        state: 'open',
        updated_at: '2026-11-12T00:00:00Z',
        body: 'Do not forward this body',
        assignees: [people.assignee],
        labels: [
          { name: 'pause' },
          ...Array.from({ length: 2000 }, (_, i) => ({ name: `unrelated-${i}` })),
        ],
      },
    }),
  );
  let request;
  await forwardSharedWake(
    { status: 'resolved', issue_number: '2' },
    {
      GITHUB_EVENT_PATH: path,
      GITHUB_RUN_ID: '80',
      GITHUB_RUN_ATTEMPT: '1',
      NIBFIN_WAKE_TOKEN: 'fixture-token',
    },
    async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({
        workflow_run_id: 81,
        html_url: 'https://github.com/taco3064/nibfin-core/actions/runs/81',
      });
    },
  );
  const forwarded = readForwardedWake(JSON.stringify(request), pauseIdentity);
  assert.deepEqual(forwarded.event.sender, people.assignee);
  assert.deepEqual(forwarded.event.issue.assignees, [people.assignee]);
  assert.deepEqual(forwarded.event.issue.labels, [{ name: 'pause' }]);
  assert.equal(forwarded.event.issue.state, 'open');
  assert.equal(forwarded.event.issue.body, undefined);
  assert.ok(request.inputs.wake_event.length < 4096);
});
