import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanClosedWorkspace } from '../src/closed-workspace.mjs';

const linux = { skip: process.platform !== 'linux' };

async function fixture(t) {
  await mkdir('.npm', { recursive: true });
  const root = await mkdtemp(resolve('.npm/closed-work-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const agent = join(root, 'agent');
  for (const path of [workspaceRoot, agent]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(workspaceRoot, 'repository.git'));
  await mkdir(join(workspaceRoot, 'artifacts'));
  await writeFile(join(workspaceRoot, 'artifacts', 'generated'), 'disposable');
  await writeFile(join(agent, 'context.json'), 'disposable');
  const receipt = join(root, 'closure.json');
  await writeFile(receipt, 'native closure reference');
  const issue = { id: 'I_fixture', number: 1, repository: 'example/core',
    repositoryId: 10 };
  const receipts = { merge: { outcome: 'merged' }, close: { outcome: 'closed' },
    'publish-shape': { requirementsBody: 'Delivered Shape' } };
  const live = { node_id: issue.id, number: 1, state: 'closed',
    labels: [{ name: 'delivered' }] };
  const config = {
    progress: { workspaceRoot, marker: { directory: workspaceRoot },
      store: { load: async () => receipts, get: async () => ({}) } },
    approval: { record: { issue } }, reader: { issue: async () => live },
  };
  return { config, receipts, live, workspaceRoot, agent, receipt };
}

test('settled closure removes Git/artifacts/agent data and tolerates a cleanup retry',
  linux, async t => {
    const f = await fixture(t);
    await cleanClosedWorkspace(f.config);
    await cleanClosedWorkspace(f.config);
    for (const path of [f.workspaceRoot, f.agent])
      await assert.rejects(access(path), { code: 'ENOENT' });
    assert.equal(await readFile(f.receipt, 'utf8'), 'native closure reference');
  });

for (const state of ['open', 'not-delivered', 'unsettled']) {
  test(`closure cleanup preserves ${state} work`, linux, async t => {
    const f = await fixture(t);
    if (state === 'open') f.live.state = 'open';
    if (state === 'not-delivered') f.live.labels = [];
    if (state === 'unsettled') f.receipts.merge.outcome = 'pending';
    await cleanClosedWorkspace(f.config);
    await access(f.workspaceRoot);
    await access(f.agent);
  });
}
