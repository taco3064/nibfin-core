import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import {
  decideStage, evidenceBinding, issueRequirementsChanged,
} from '../src/stages.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { nativeWrites } from '../src/native-writes.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

const history = JSON.parse(await readFile(new URL(
  './fixtures/core-515-shape-recovery.json', import.meta.url,
), 'utf8'));
const revised = 'Use successful lifecycle callbacks and normal operation retry.\n' +
  '```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n';
const linux = { skip: process.platform !== 'linux' };

function message(context, stage, body, rejected) {
  const result = {
    outcome: rejected ? 'changes_required' : stage === 'shape' ? 'ready' : 'approved',
    body: stage === 'shape' ? body : '',
    summary: 'Controlled role adapter for the recorded Core #515 failure.',
    rootCause: rejected ? history.validation.rootCause : '',
    failureClass: rejected ? 'shape_defect' : 'none',
    blockingFindings: rejected ? history.validation.findings : [],
    evidenceReferences: [history.run],
    contractConflicts: [],
  };
  const text = JSON.stringify(result);
  return {
    executionId: context.execution.id,
    terminationHash: 'a'.repeat(64),
    lastMessage: text,
    result,
    stdout: [
      { type: 'thread.started', thread_id: context.execution.sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n'),
  };
}

async function replay(t, { changed = false, rejectFirst = false } = {}) {
  const prefix = fileURLToPath(new URL('../.shape-replay-', import.meta.url));
  const root = await mkdtemp(prefix);
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = stageFixture();
  const issue = structuredClone(initial.issue);
  issue.body = changed ? history.amendedBody : history.originalBody;
  issue.labels.push({ name: 'shaped' });
  const store = new EvidenceStore(root, evidenceBinding(initial));
  const calls = [], writes = [];
  let execution, validations = 0;
  const observe = async stage => {
    const context = stageFixture(stage);
    context.issue = structuredClone(issue);
    context.execution = execution;
    context.isolation.executionId = execution.id;
    context.receipts = await store.load();
    const hash = context.receipts.shape?.artifacts.shapeHash;
    if (hash) context.shape = { body: await store.get(hash), hash };
    return context;
  };
  const handlers = stageHandlers({
    store,
    agent: { run: async (stage, context) => {
      calls.push({ stage, context });
      const reject = stage === 'validate-shape' && rejectFirst && ++validations === 1;
      return message(context, stage, revised, reject);
    } },
    writerFor: (...args) => nativeWrites({
      token: 'fixture-token',
      observe,
      clock: () => now,
      workspace: { push: async () => assert.fail('No PR mutation in Shape') },
      reader: {
        get: async () => assert.fail('Unexpected GET'),
        repository: async () => ({
          id: 10, full_name: 'example/core', private: false,
        }),
        issue: async () => structuredClone(issue),
      },
      fetcher: async (url, options) => {
        if (url.endsWith('/user')) return Response.json({ type: 'User', id: 1 });
        writes.push({ method: options.method, body: JSON.parse(options.body) });
        assert.equal(options.method, 'PATCH');
        Object.assign(issue, JSON.parse(options.body));
        return { ok: true, json: async () => structuredClone(issue) };
      },
    }).writerFor(...args),
  });
  const runtime = new StageRuntime({
    observe, handlers, receipts: store, clock: () => now,
    journal: new OperationJournal(root, initial.approval.record.issue),
  });
  const execute = async stage => {
    if (stage === 'deliver')
      return { stage, status: 'pending', code: 'FIXTURE_DELIVER_BOUNDARY' };
    execution = {
      ...stageFixture(stage).execution, id: randomUUID(), sessionId: randomUUID(),
    };
    return runtime.run({ schemaVersion: 1, stage });
  };
  const seed = async (stage, body, outcome, requirementsBody = body) => {
    const receipt = structuredClone(stageFixture(stage).receipts[stage]);
    receipt.artifacts = { shapeHash: await store.put(body) };
    receipt.outcome = outcome;
    receipt.requirementsBody = requirementsBody;
    receipt.findings = outcome === 'changes_required' ? history.validation.findings : [];
    await store.append(receipt);
  };
  const run = () => continueStages({
    store, execute, inspect: async () => {}, wait: async () => {},
    refreshRequirements: receipts =>
      issueRequirementsChanged(issue, receipts, hash => store.get(hash)),
  });
  return { issue, store, calls, writes, execute, seed, run };
}

test('Core #515 changed published requirements invoke author and republish', linux,
  async t => {
    const f = await replay(t, { changed: true });
    await f.seed('shape', history.originalBody, 'ready');
    await f.seed('validate-shape', history.originalBody, 'approved');
    await f.seed('publish-shape', history.originalBody, 'published');
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.deepEqual(f.calls.map(call => call.stage), ['shape', 'validate-shape']);
    assert.equal(f.calls[0].context.issue.body, history.amendedBody);
    assert.equal(f.issue.body, revised);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.issue.labels.map(label => label.name), ['scope', 'shaped']);
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.equal(f.writes.length, 1);
    assert.equal(f.calls.length, 2);
  });

test('Core #515 recorded validation rejection re-enters author with findings', linux,
  async t => {
    const f = await replay(t, { changed: true });
    await f.seed('shape', history.amendedBody, 'ready');
    await f.seed('validate-shape', history.amendedBody, 'changes_required');
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.deepEqual(f.calls.map(call => call.stage), ['shape', 'validate-shape']);
    assert.deepEqual(f.calls[0].context.correctionFindings, history.validation.findings);
    const receipts = await f.store.load();
    assert.notEqual(receipts.shape.execution.id, receipts['validate-shape'].execution.id);
    assert.notEqual(receipts.shape.execution.sessionId,
      receipts['validate-shape'].execution.sessionId);
    assert.equal(receipts['validate-shape'].outcome, 'approved');
    assert.equal(receipts['publish-shape'].outcome, 'published');
  });

test('fresh Validate Shape rejection rewrites and validates before publication', linux,
  async t => {
    const f = await replay(t, { rejectFirst: true });
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.deepEqual(f.calls.map(call => call.stage),
      ['validate-shape', 'shape', 'validate-shape']);
    assert.deepEqual(f.calls[1].context.correctionFindings, history.validation.findings);
    assert.equal(f.writes.length, 1);
  });

test('unchanged published Shape is revalidated without author or body writes', linux,
  async t => {
    const f = await replay(t);
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.deepEqual(f.calls.map(call => call.stage), ['validate-shape']);
    assert.equal(f.writes.length, 0);
    assert.equal(f.issue.body, history.originalBody);
  });

test('concurrent requirement edit prevents publishing the reviewed draft', linux,
  async t => {
    const f = await replay(t, { changed: true });
    await f.seed('shape', history.originalBody, 'ready');
    assert.equal((await f.execute('shape')).status, 'completed');
    assert.equal((await f.execute('validate-shape')).status, 'completed');
    f.issue.body += '\nAnother Owner requirement.';
    const result = await f.execute('publish-shape');
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'CURRENT_SHAPE_REVALIDATION_CHANGED');
    assert.equal(f.writes.length, 0);
  });

test('an unapproved rewrite cannot be published', () => {
  const context = stageFixture('publish-shape');
  context.issue.body = history.amendedBody;
  context.issue.labels.push({ name: 'shaped' });
  context.receipts.shape.requirementsBody = history.amendedBody;
  context.receipts['validate-shape'].outcome = 'changes_required';
  assert.equal(decideStage('publish-shape', context, now).status, 'denied');
});

test('changed raw requirements need no candidate block before Shape', linux,
  async t => {
    const f = await replay(t, { changed: true });
    f.issue.body = 'Owner requests event-driven continuation without a timer.';
    await f.seed('shape', history.originalBody, 'ready');
    await f.seed('validate-shape', history.originalBody, 'approved');
    await f.seed('publish-shape', history.originalBody, 'published');
    assert.equal((await f.run()).code, 'FIXTURE_DELIVER_BOUNDARY');
    assert.deepEqual(f.calls.map(call => call.stage), ['shape', 'validate-shape']);
    assert.equal(f.issue.body, revised);
    assert.equal(f.writes.length, 1);
  });

test('open requirements can evolve after a merge; closed Issues cannot restart',
  async () => {
    const context = stageFixture('shape');
    context.issue.body = history.amendedBody;
    assert.equal(await issueRequirementsChanged(context.issue,
      { shape: { requirementsBody: history.originalBody }, merge: {} },
      () => assert.fail('Unpublished requirements need no artifact read')), true);
    context.issue.state = 'closed';
    assert.equal(decideStage('shape', context, now).code, 'ISSUE_CHANGED');
  });

test('already-shaped rewrite passes native per-write authorization', async () => {
  const context = stageFixture('publish-shape');
  context.issue.body = history.amendedBody;
  context.issue.labels.push({ name: 'shaped' });
  context.receipts.shape.requirementsBody = history.amendedBody;
  const calls = [];
  const live = structuredClone(context.issue);
  const assembly = nativeWrites({
    token: 'fixture-token', clock: () => now,
    workspace: { push: async () => assert.fail('No PR writes') },
    observe: async () => ({ ...context, issue: structuredClone(live) }),
    reader: {
      get: async () => assert.fail('Unexpected reader GET'),
      repository: async () => ({ id: 10, full_name: 'example/core', private: false }),
      issue: async () => structuredClone(live),
    },
    fetcher: async (url, options) => {
      if (url.endsWith('/user')) return Response.json({ type: 'User', id: 1 });
      calls.push(options.method);
      Object.assign(live, JSON.parse(options.body));
      return Response.json(live);
    },
  });
  const decision = decideStage('publish-shape', context, now);
  assert.equal(decision.status, 'allowed', decision.code);
  const writer = assembly.writerFor('publish-shape', context, decision);
  const result = await writer.publishShape({
    issue: context.approval.record.issue,
    expectedBodyHash: digest(context.issue.body),
    expectedLabels: context.issue.labels.map(label => label.name),
    body: context.shape.body,
  });
  assert.equal(result.bodyHash, context.shape.hash);
  assert.deepEqual(calls, ['PATCH']);
});

test('changed and rejected published plans invoke the author handler', async () => {
  for (const rejected of [false, true]) {
    const context = stageFixture('shape');
    context.issue.body = history.amendedBody;
    context.issue.labels.push({ name: 'shaped' });
    const body = rejected ? history.amendedBody : history.originalBody;
    const hash = digest(body);
    context.receipts = {
      shape: { artifacts: { shapeHash: hash }, requirementsBody: body },
      'publish-shape': { artifacts: { shapeHash: hash }, requirementsBody: body },
      ...(rejected ? { 'validate-shape': {
        outcome: 'changes_required', artifacts: { shapeHash: hash },
        findings: history.validation.findings,
      } } : {}),
    };
    const calls = [];
    const handlers = stageHandlers({
      store: { get: async () => body },
      agent: { run: async (stage, input) => {
        calls.push({ stage, input });
        return { executionId: input.execution.id };
      } },
    });
    await handlers.shape.perform(context, { artifacts: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stage, 'shape');
    if (rejected)
      assert.deepEqual(calls[0].input.correctionFindings, history.validation.findings);
  }
});
