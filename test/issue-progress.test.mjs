import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { digest } from '../src/identity.mjs';
import { issueProgress } from '../src/issue-progress.mjs';

const issue = { repository: 'example/core', repositoryId: 123, id: 'I_test', number: 9 };
const approval = version => ({
  record: { issue, source: { commit: version }, roles: { author: 7, writer: 7 } },
  scopeBinding: digest(issue),
  approvalHash: digest(version),
});

async function issueDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-issue-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'receipts'), { mode: 0o700 });
  return root;
}

test('new Issue progress keeps the same workspace and receipts across Core versions',
  { skip: process.platform === 'win32' }, async t => {
    const root = await issueDirectory(t);
    const first = await issueProgress(root, approval('first'));
    assert.equal(first.workspaceRoot, join(root, 'workspace'));
    await mkdir(first.workspaceRoot, { mode: 0o700 });
    await first.store.put(first.marker);
    const next = await issueProgress(root, approval('next'));
    assert.equal(next.workspaceRoot, first.workspaceRoot);
    assert.deepEqual(next.binding, first.binding);
    assert.deepEqual(await next.store.get(digest(next.marker)), first.marker);
  });

test('existing workspace and immutable receipts remain readable after rollout',
  { skip: process.platform === 'win32' }, async t => {
    const root = await issueDirectory(t);
    const old = approval('first');
    const binding = {
      issueId: issue.id, approvalHash: old.approvalHash, scopeHash: old.scopeBinding,
      sourceHash: digest(old.record.source),
    };
    const workspaceRoot = join(root, `workspace-${binding.sourceHash}`);
    await mkdir(workspaceRoot, { mode: 0o700 });
    const store = new EvidenceStore(join(root, 'receipts'), binding);
    await store.put({ kind: 'host-workspace', directory: workspaceRoot, binding });
    const shape = {
      schemaVersion: 1, stage: 'shape', binding, outcome: 'ready',
      execution: { runId: 18, actorId: 7 },
    };
    const original = await store.append(shape);
    const next = await issueProgress(root, approval('next'));
    assert.equal(next.workspaceRoot, workspaceRoot);
    assert.deepEqual(await next.store.get(original), shape);
    assert.deepEqual((await next.store.load()).shape, shape);
  });
