import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { continueStages } from '../src/stage-continuation.mjs';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { stages, evidenceBinding } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

test(
  'bounded lifecycle composes stage gates, handlers, ' +
    'persistent artifacts and journal through verified ' +
    'closure',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-lifecycle-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const initial = stageFixture(),
      store = new EvidenceStore(root, evidenceBinding(initial));
    const issue = structuredClone(initial.issue);
    let merged = false,
      publications = 0;
    const workspace = {
      work: '/safe/work',
      hookBaseline: async () => '/safe/baseline',
      capture: async () => structuredClone(initial.candidate),
      commit: async () => ({
        head: initial.pr.head,
        base: initial.pr.base,
        tree: initial.pr.tree,
      }),
    };
    const agent = {
      run: async (stage, context) => {
        const outcome =
          stage === 'accept'
            ? 'accepted'
            : ['validate-shape', 'review-pr'].includes(stage)
              ? 'approved'
              : 'ready';
        const message = JSON.stringify({
          outcome,
          body: stage === 'shape' ? initial.shape.body : '',
          summary: 'Synthetic bounded evidence',
          rootCause: '',
          failureClass: 'none',
          evidenceReferences: ['fixture:isolated-role'],
          blockingFindings: [],
          contractConflicts: [],
        });
        return {
          executionId: context.execution.id,
          terminationHash: 'a'.repeat(64),
          lastMessage: message,
          stdout: [
            { type: 'thread.started', thread_id: context.execution.sessionId },
            { type: 'turn.started' },
            { type: 'item.completed', item: { type: 'agent_message', text: message } },
            { type: 'turn.completed' },
          ]
            .map(JSON.stringify)
            .join('\n'),
        };
      },
    };
    const handlers = stageHandlers({
      agent,
      workspace,
      store,
      sandbox: {
        execute: async () => {
          throw new Error('Empty hook inventory');
        },
      },
      clock: () => now,
      writerFor: () => ({
        publishShape: async ({ body }) => {
          publications++;
          issue.body = body;
          issue.labels.push({ name: 'shaped' });
          return { bodyHash: initial.shape.hash, reference: issue.url };
        },
        merge: async () => {
          merged = true;
          return { mergeCommit: '8'.repeat(40), reference: 'fixture:merged-pr' };
        },
        closeDelivered: async () => {
          assert.equal(merged, true);
          issue.state = 'closed';
          issue.labels.push({ name: 'delivered' });
          return { bodyHash: initial.shape.hash, reference: issue.url };
        },
      }),
      publishCommit: async () => ({
        id: initial.pr.id,
        number: initial.pr.number,
        head: initial.pr.head,
        base: initial.pr.base,
        reference: 'fixture:published-pr',
      }),
    });
    const observe = async (stage) => {
      const context = stageFixture(stage);
      context.issue = structuredClone(issue);
      context.receipts = await store.load();
      if (context.receipts.shape?.outcome === 'ready')
        context.shape.body = await store.get(context.receipts.shape.artifacts.shapeHash);
      if (context.receipts.deliver?.outcome === 'ready')
        context.candidate = await store.get(
          context.receipts.deliver.artifacts.candidateHash,
        );
      return context;
    };
    const runtime = new StageRuntime({
      observe,
      handlers,
      receipts: store,
      journal: new OperationJournal(root, initial.approval.record.issue),
      clock: () => now,
    });
    assert.equal(
      (await runtime.run({ schemaVersion: 1, stage: 'deliver' })).status,
      'denied',
    );
    const continuation = () =>
      continueStages({
        store,
        execute: (stage) => runtime.run({ schemaVersion: 1, stage }),
        inspect: async () => {},
        wait: async () => {
          throw new Error('No CI latency in fixture');
        },
      });
    assert.equal((await continuation()).status, 'completed');
    assert.equal((await continuation()).code, 'DELIVERY_ALREADY_RECORDED');
    assert.equal(publications, 1);
    assert.equal(issue.state, 'closed');
    assert.ok(issue.labels.some((label) => label.name === 'delivered'));
    const receipts = await store.load();
    assert.equal(Object.keys(receipts).length, Object.keys(stages).length);
    assert.equal(
      receipts.close.artifacts.mergeCommit,
      receipts.merge.artifacts.mergeCommit,
    );
    assert.equal(
      (await runtime.run({ schemaVersion: 1, stage: 'merge' })).status,
      'denied',
    );
  },
);
