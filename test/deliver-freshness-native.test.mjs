import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './native-observer-fixture.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { evidenceBinding } from '../src/stages.mjs';

for (const outcome of ['blocked', 'changes_required'])
  test(`observer preserves ${outcome} handoff work ahead of its PR`, async t => {
    const prior = stageFixture('deliver');
    const f = await nativeFixture(t, prior.approval.record);
    f.data['/pulls/7'].merged_by = { id: 1, login: 'writer', type: 'User' };
    f.data['/rulesets/rule-suites/60'].actor_id = 1;
    f.data['/collaborators/writer/permission'].permission = 'admin';
    const approved = await f.observe('shape');
    const binding = evidenceBinding(approved);
    const store = new EvidenceStore(f.root, binding);
    await store.put(prior.shape.body);
    await store.put(prior.candidate);
    const retained = { ...prior.candidate, base: '9'.repeat(40) };
    const candidateHash = await store.put(retained);
    for (const stage of ['shape', 'validate-shape', 'publish-shape', 'commit-pr'])
      await store.append({ ...prior.receipts[stage], binding });
    await store.append({ ...prior.receipts.deliver, binding, outcome,
      findings: ['Main handoff requires retry'], artifacts: {
        shapeHash: prior.shape.hash, candidateHash,
      } });
    f.issue.body = prior.shape.body;
    f.issue.labels.push({ name: 'shaped' });
    f.data['/git/ref/heads/main'].object.sha = retained.base;
    const pr = prior.pr;
    f.data['/pulls/1'] = { node_id: pr.id, number: pr.number, state: 'open',
      merged: false, merge_commit_sha: pr.mergePreview,
      head: { sha: pr.head, ref: 'delivery', repo: { id: 10 } },
      base: { sha: retained.base, ref: 'main', repo: { id: 10 } },
    };
    f.data['/git/commits/' + pr.head] = { sha: pr.head,
      tree: { sha: prior.candidate.tree }, parents: [{ sha: prior.candidate.base }] };
    const context = await f.observe('deliver');
    assert.deepEqual(context.candidate, retained);
    assert.equal(context.rebaseTarget, retained.base);
    assert.equal(context.pr.id, pr.id);
    assert.equal(context.pr.number, pr.number);
  });
