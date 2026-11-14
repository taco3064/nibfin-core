import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardSharedWake, readForwardedWake } from '../src/shared-wake.mjs';
import { people, pauseIdentity } from './pause-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';

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

test('shared wake uses the configured GitHub identity and default branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shared-wake-destination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'event.json');
  await writeFile(path, JSON.stringify({
    action: 'edited',
    repository: { id: 10, full_name: 'example/target' },
    issue: { number: 2, node_id: 'I_target' },
  }));
  const result = { status: 'resolved', issue_number: '2' };
  const env = {
    GITHUB_EVENT_PATH: path,
    GITHUB_RUN_ID: '80',
    GITHUB_RUN_ATTEMPT: '1',
    NIBFIN_WAKE_TOKEN: 'fixture-token',
    NIBFIN_SHARED_RUNNER_DESTINATION: JSON.stringify({
      repository: 'example/execution', repositoryId: 20,
    }),
  };
  const rootUrl = 'https://api.github.com/repos/example/execution';
  const workflowPath = '.github/workflows/shared-runner.yml';
  const bytes = await readFile(new URL(`../${workflowPath}`, import.meta.url));
  const head = 'a'.repeat(40);
  const registered = rootUrl + '/actions/workflows/shared-runner.yml';
  const contents = `${rootUrl}/contents/${workflowPath}?ref=${head}`;
  const repo = {
    id: 20, full_name: 'example/execution', private: false,
    archived: false, disabled: false, default_branch: 'stable',
  };
  const calls = [];
  await forwardSharedWake(result, env, async (url, options) => {
    calls.push(url);
    if (url === rootUrl) return Response.json(repo);
    if (url === rootUrl + '/branches/stable')
      return Response.json({ protected: true, commit: { sha: head } });
    if (url === registered)
      return Response.json({ id: 5, path: workflowPath, state: 'active' });
    if (url === contents) return Response.json({
      type: 'file', path: workflowPath, sha: gitBlob(bytes),
      encoding: 'base64', content: bytes.toString('base64'), size: bytes.length,
    });
    assert.equal(url, registered + '/dispatches');
    const request = JSON.parse(options.body);
    assert.equal(request.ref, 'stable');
    assert.equal(request.inputs.repository_id, '10');
    return Response.json({
      workflow_run_id: 81,
      html_url: 'https://github.com/example/execution/actions/runs/81',
    });
  });
  assert.deepEqual(calls, [rootUrl, rootUrl + '/branches/stable',
    registered, contents, registered + '/dispatches']);
  await assert.rejects(forwardSharedWake(result, env, async url => {
    assert.equal(url, rootUrl);
    return Response.json({ ...repo, id: 21 });
  }), { code: 'SHARED_WAKE_DESTINATION_CHANGED' });
  await assert.rejects(forwardSharedWake(result, env, async url => {
    if (url === rootUrl) return Response.json(repo);
    if (url === rootUrl + '/branches/stable')
      return Response.json({ protected: false, commit: { sha: head } });
    assert.equal(url, registered);
    return Response.json({ id: 5, path: workflowPath, state: 'active' });
  }), { code: 'SHARED_WAKE_BRANCH_UNPROTECTED' });
  await assert.rejects(forwardSharedWake(result, env, async url => {
    if (url === rootUrl) return Response.json(repo);
    if (url === rootUrl + '/branches/stable')
      return Response.json({ protected: true, commit: { sha: head } });
    if (url === registered)
      return Response.json({ id: 5, path: workflowPath, state: 'active' });
    assert.equal(url, contents);
    return Response.json({ type: 'file', path: workflowPath, sha: 'b'.repeat(40) });
  }), { code: 'PINNED_FILE_UNAVAILABLE' });
});
