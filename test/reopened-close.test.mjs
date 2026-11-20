import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { nativeWrites } from '../src/native-writes.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

test('retained native delivery re-closes a reopened Issue through real write guards',
  { skip: process.platform !== 'linux' }, async t => {
    for (const paused of [false, true]) {
      const parent = fileURLToPath(new URL('../.nibfin-cache/', import.meta.url));
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'reopened-close-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const initial = stageFixture('close');
      const issue = structuredClone(initial.issue);
      const store = new EvidenceStore(root, evidenceBinding(initial));
      await store.put(initial.shape.body);
      await store.put(initial.candidate);
      for (const entry of Object.values(initial.receipts)) await store.append(entry);
      const oldClose = { ...initial.receipts.merge, stage: 'close', outcome: 'closed',
        execution: { ...initial.execution, runId: 1 } };
      await store.append(oldClose);
      const execution = { ...initial.execution, runId: 2, jobId: 22,
        id: '00000000-0000-4000-8000-000000000022',
        sessionId: '11111111-0000-4000-8000-000000000022' };
      const writes = [], calls = [];
      const observe = async () => {
        const context = stageFixture('close');
        context.issue = structuredClone(issue);
        context.execution = execution;
        context.runner.runId = execution.runId;
        context.runner.jobId = execution.jobId;
        context.isolation.executionId = execution.id;
        context.receipts = await store.load();
        if (paused) context.pause.status = 'paused';
        return context;
      };
      const reader = { get: async () => assert.fail('Unexpected provider read'),
        issue: async () => structuredClone(issue),
        repository: async () => ({ id: 10, full_name: 'example/core', private: false }) };
      const workspace = { push: async () => assert.fail('No new source publication') };
      const fetcher = async (url, options) => {
        if (url.endsWith('/user')) return Response.json({ type: 'User', id: 1 });
        const body = JSON.parse(options.body);
        writes.push({ method: options.method, body });
        if (options.method === 'POST') {
          assert.deepEqual(body, { labels: ['delivered'] });
          issue.labels.push({ name: 'delivered' });
        } else {
          assert.equal(options.method, 'PATCH');
          Object.assign(issue, body);
        }
        return Response.json(structuredClone(issue));
      };
      const handlers = stageHandlers({ store, workspace,
        ...nativeWrites({ reader, observe, token: 'fixture-token', workspace,
          fetcher, clock: () => now }) });
      const runtime = new StageRuntime({ observe, handlers, receipts: store,
        journal: new OperationJournal(root, initial.approval.record.issue),
        clock: () => now });
      const result = await continueStages({ store, resumeClosed: async () => true,
        inspect: async () => {}, wait: async () => {},
        execute: stage => {
          calls.push(stage);
          return runtime.run({ schemaVersion: 1, stage });
        } });
      assert.deepEqual(calls, ['close']);
      if (paused) {
        assert.equal(result.code, 'ISSUE_PAUSED');
        assert.equal(writes.length, 0);
        assert.equal(issue.state, 'open');
      } else {
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.equal(issue.state, 'closed');
        assert.deepEqual(writes.map(value => value.method), ['POST', 'PATCH']);
        assert.equal((await store.load()).close.execution.runId, 2);
      }
    }
  });
