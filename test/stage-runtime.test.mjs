import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = stageFixture(),
    saved = [];
  let performed = 0;
  const adapters = {
    observe: async () => structuredClone(context),
    clock: () => now,
    journal: new OperationJournal(root, context.approval.record.issue),
    receipts: {
      append: async (value) => {
        saved.push(value);
        return digest(value);
      },
    },
    handlers: {
      shape: {
        perform: async () => {
          performed++;
          return { body: context.shape.body };
        },
        readBack: async () => ({
          outcome: 'ready',
          findings: [],
          references: ['trusted-session:1'],
          artifacts: { shapeHash: context.shape.hash },
        }),
      },
    },
  };
  return { context, adapters, saved, performed: () => performed };
}
const request = { schemaVersion: 1, stage: 'shape' };

test('Deliver integrates an adopted PR with current main before Accept', async () => {
  const context = stageFixture();
  const pin = { number: 15 };
  const old = { base: '1'.repeat(40) };
  const rebased = { base: '2'.repeat(40) };
  context.adoptedCandidate = pin;
  context.rebaseTarget = rebased.base;
  let restored = false;
  const handler = stageHandlers({
    agent: { run: async () => assert.fail('Equivalent rebase needs no Writer') },
    workspace: {
      restoreAdoptedCandidate: async (value, shape) => {
        assert.deepEqual(value, pin);
        assert.equal(shape, context.shape.body);
        restored = true;
        return old;
      },
      rebase: async (candidate, shape, base) => {
        assert.ok(restored);
        assert.equal(candidate, old);
        assert.equal(shape, context.shape.body);
        assert.equal(base, rebased.base);
        return { status: 'rebased', candidate: rebased, contentChanged: false };
      },
    },
  }).deliver;
  const outcome = await handler.perform(context);
  assert.deepEqual(outcome.retainedCandidate, rebased);
  assert.match(outcome.reference, /\/pulls\/15$/);
});

test('Deliver receives independent Accept findings for its Candidate', async () => {
  const context = stageFixture();
  const candidateHash = digest(context.candidate);
  const findings = ['Fix the installation instructions.'];
  context.receipts.deliver = { artifacts: { candidateHash } };
  context.receipts.accept = {
    outcome: 'changes_required',
    artifacts: { candidateHash, shapeHash: context.shape.hash },
    findings,
  };
  const handler = stageHandlers({
    agent: { run: async (stage, input) => {
      assert.equal(stage, 'deliver');
      assert.deepEqual(input.correctionFindings, findings);
      return { status: 'completed' };
    } },
  }).deliver;
  assert.equal((await handler.perform(context)).status, 'completed');
});

test('a published Shape is loaded verbatim without starting Author', async t => {
  const f = await fixture(t);
  const body = f.context.shape.body;
  f.context.issue.body = body;
  f.context.issue.labels.push({ name: 'shaped' });
  let stored;
  f.adapters.handlers = stageHandlers({
    agent: { run: async () => assert.fail('Published Shape needs no new Author') },
    store: { put: async value => {
      stored = value;
      return digest(value);
    } },
  });
  const outcome = await new StageRuntime(f.adapters).run(request);
  assert.equal(outcome.status, 'completed');
  assert.equal(stored, body);
  assert.equal(f.saved[0].artifacts.shapeHash, digest(body));
  assert.deepEqual(f.saved[0].references, [f.context.issue.url]);
});

test('a finished Author with invalid obligations writes a blocked receipt', async t => {
  const f = await fixture(t);
  const { execution } = f.context;
  const message = JSON.stringify({
    outcome: 'ready', body: 'Missing the required block', summary: 'Draft',
    rootCause: '', failureClass: 'none', evidenceReferences: [f.context.issue.url],
    blockingFindings: [], contractConflicts: [],
  });
  f.adapters.handlers = stageHandlers({
    agent: { run: async () => ({
      executionId: execution.id, terminationHash: 'a'.repeat(64), lastMessage: message,
      stdout: [
        { type: 'thread.started', thread_id: execution.sessionId },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: message } },
        { type: 'turn.completed' },
      ].map(JSON.stringify).join('\n'),
    }) },
  });
  const runtime = new StageRuntime(f.adapters);
  assert.equal((await runtime.run(request)).code, 'STAGE_REQUIRES_CORRECTION');
  assert.match(f.saved[0].findings[0], /invalid candidate obligations/);
  assert.equal(f.saved[0].requirementsBody, f.context.issue.body);
  assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
});

test('confirmed startup and idle failures report the reason', async t => {
  for (const [code, finding] of [
    ['CODEX_IDLE_TIMEOUT', /without progress/],
    ['SUBSCRIPTION_LOGIN_UNAVAILABLE', /before the role ran/],
  ]) {
    const f = await fixture(t);
    const interrupted = {
      status: 'interrupted',
      executionId: f.context.execution.id,
      terminationHash: 'a'.repeat(64),
      code,
    };
    f.adapters.handlers = stageHandlers({
      agent: { run: async () => interrupted },
      store: { put: async value => digest(value) },
    });
    const runtime = new StageRuntime(f.adapters);
    assert.equal((await runtime.run(request)).code, code);
    assert.equal(f.saved[0].outcome, 'blocked');
    assert.match(f.saved[0].findings[0], finding);
    assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
  }
});

test('runtime persists a trusted receipt after read-back', async (t) => {
  const f = await fixture(t),
    runtime = new StageRuntime(f.adapters);
  const outcome = await runtime.run(request);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.receiptHash, digest(f.saved[0]));
  assert.equal(f.saved[0].execution.actorId, 1);
  assert.equal(
    f.saved[0].binding.scopeHash,
    f.context.approval.record.scope.hash,
  );
  assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
  assert.equal(f.performed(), 1);
});

test('revocation before admission prevents execution', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const c = structuredClone(f.context);
    if (++reads > 1) c.approval.record.operations = [];
    return c;
  };
  assert.equal(
    (await new StageRuntime(f.adapters).run(request)).status,
    'denied',
  );
  assert.equal(f.performed(), 0);
  assert.equal(f.saved.length, 0);
});

test('unknown effects and lost receipts stay Pending', async (t) => {
  for (const fail of ['perform', 'readBack', 'append']) {
    const f = await fixture(t);
    const unavailable = async () => {
      throw new Error('Unknown provider result');
    };
    if (fail === 'append') f.adapters.receipts.append = unavailable;
    else f.adapters.handlers.shape[fail] = unavailable;
    const runtime = new StageRuntime(f.adapters);
    assert.equal((await runtime.run(request)).status, 'pending');
    assert.equal((await runtime.run(request)).code, 'EXTERNAL_EFFECT_UNKNOWN');
  }
});

test('untrusted requests cannot select arbitrary commands', async (t) => {
  const f = await fixture(t),
    runtime = new StageRuntime(f.adapters);
  for (const invalid of [
    { ...request, authorized: true },
    { ...request, command: 'anything' },
    { ...request, schemaVersion: 2 },
    { ...request, stage: '__proto__' },
    { ...request, stage: 'constructor' },
  ]) {
    assert.equal((await runtime.run(invalid)).code, 'INVALID_STAGE_REQUEST');
  }
  assert.equal(
    (await runtime.run({ ...request, stage: 'deliver' })).code,
    'UNSUPPORTED_STAGE_ADAPTER',
  );
  assert.equal(f.performed(), 0);
});

test('an authorized Issue edit during admission requires a fresh decision', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const c = structuredClone(f.context);
    if (++reads > 1) c.issue.body += 'New acceptance criteria';
    return c;
  };
  assert.equal(
    (await new StageRuntime(f.adapters).run(request)).status,
    'denied',
  );
  assert.equal(f.performed(), 0);
});

test('an admitted stage settles after pause; its next invocation cannot begin',
  async t => {
  const f = await fixture(t);
  const perform = f.adapters.handlers.shape.perform;
  f.adapters.handlers.shape.perform = async () => {
    const result = await perform();
    f.context.pause = { ...f.context.pause, status: 'paused', effective: true,
      visible: true };
    f.context.issue.labels.push({ name: 'pause' });
    return result;
  };
  const runtime = new StageRuntime(f.adapters);
  const settled = await runtime.run(request);
  assert.equal(settled.status, 'completed');
  assert.equal(f.saved.length, 1);
  assert.equal((await runtime.run(request)).code, 'ISSUE_PAUSED');
  assert.equal(f.performed(), 1);
});

test('pause observation changes between stage admission reads prevent execution',
  async t => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const value = structuredClone(f.context);
    if (++reads > 1) value.pause.observationHash = 'b'.repeat(64);
    return value;
  };
  assert.notEqual((await new StageRuntime(f.adapters).run(request)).status, 'completed');
  assert.equal(f.performed(), 0);
});
