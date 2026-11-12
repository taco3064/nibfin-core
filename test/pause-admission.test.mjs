import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeFixture } from './native-observer-fixture.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { decideStage } from '../src/stages.mjs';
import { digest } from '../src/identity.mjs';

function addNative(f, actorId, desired) {
  const events = f.data['/issues/2/events'];
  const id = events.length + 1;
  events.push({
    id,
    event: desired ? 'labeled' : 'unlabeled',
    actor: { id: actorId, login: actorId === 1 ? 'writer' : 'other', type: 'User' },
    label: { name: 'pause' },
    created_at: '2026-11-03T00:00:00Z',
    url: `https://api.github.com/repos/example/core/issues/events/${id}`,
  });
  f.issue.labels = f.issue.labels.filter((label) => label.name !== 'pause');
  if (desired) f.issue.labels.push({ name: 'pause' });
}

test('trusted observer blocks direct stages throughout the post-event repair gap',
  async t => {
  const f = await nativeFixture(t);
  addNative(f, 1, true);
  addNative(f, 9, false);
  assert.ok(!f.issue.labels.some((label) => label.name === 'pause'));
  const context = await f.observe('shape');
  assert.equal(context.pause.status, 'repair');
  assert.equal(context.pause.actorId, 1);
  assert.equal(decideStage('shape', context, now).code, 'PAUSE_NOT_PROVEN_CLEAR');
  f.data['/issues/2/events'] = null;
  const unknown = await f.observe('shape');
  assert.equal(unknown.pause.status, 'unknown');
  assert.equal(decideStage('shape', unknown, now).status, 'pending');
});

test('authorized Resume preserves other admission guards',
  async t => {
  const f = await nativeFixture(t);
  addNative(f, 1, true);
  addNative(f, 3, false);
  const context = await f.observe('shape');
  assert.equal(context.pause.status, 'clear');
  assert.equal(decideStage('shape', context, now).status, 'allowed');
  context.dependencies.ready = false;
  assert.equal(decideStage('shape', context, now).code, 'PREREQUISITES_NOT_READY');
  f.data['/collaborators/reviewer/permission'].permission = 'read';
  await assert.rejects(f.observe('shape'), /MEMBER_PERMISSION_REVOKED/);
});

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-pause-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = {},
    objects = new Map();
  const store = {
    load: async () => structuredClone(receipts),
    get: async (hash) => objects.get(hash),
    append: async (receipt) => {
      const hash = digest(receipt);
      objects.set(hash, receipt);
      receipts[receipt.stage] = receipt;
      return hash;
    },
  };
  const state = { paused: false, performed: [], reads: 0, changed: false };
  const journal = new OperationJournal(root, stageFixture().approval.record.issue);
  const runtime = new StageRuntime({
    clock: () => now,
    journal,
    receipts: store,
    observe: async (stage) => {
      const context = stageFixture(stage);
      state.reads++;
      if (state.paused) context.pause.status = 'paused';
      if (state.changed && state.reads > 1)
        context.pause.observationHash = 'b'.repeat(64);
      return context;
    },
    handlers: Object.fromEntries(
      ['shape', 'validate-shape'].map((stage) => [
        stage,
        {
          perform: async () => {
            state.performed.push(stage);
            state.paused = true;
          },
          readBack: async () => ({
            outcome: 'ready',
            findings: [],
            artifacts: { shapeHash: stageFixture().shape.hash },
            references: ['fixture:admitted-stage-settlement'],
          }),
        },
      ]),
    ),
  });
  return { state, runtime, store, journal };
}

test('an admitted stage settles after pause; same-invocation continuation cannot begin',
  async t => {
  const f = await runtimeFixture(t);
  const result = await continueStages({
    store: f.store,
    inspect: async () => {},
    execute: (stage) => f.runtime.run({ schemaVersion: 1, stage }),
  });
  assert.equal(result.stage, 'validate-shape');
  assert.equal(result.code, 'PAUSE_NOT_PROVEN_CLEAR');
  assert.deepEqual(f.state.performed, ['shape']);
  assert.equal((await f.store.load()).shape.outcome, 'ready');
  await f.journal.assertIdle();
});

test('a changed clear observation during fresh admission cannot start a stage',
  async t => {
  const f = await runtimeFixture(t);
  f.state.changed = true;
  const result = await f.runtime.run({ schemaVersion: 1, stage: 'shape' });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'PAUSE_OBSERVATION_CHANGED');
  assert.deepEqual(f.state.performed, []);
  await f.journal.assertIdle();
});

test('Resume cannot settle unknown external effects or authorize a second Writer',
  async t => {
  const f = await runtimeFixture(t);
  const request = { operation: 'shape', bindingHash: 'a'.repeat(64) };
  await f.journal.run(request, {
    admit: async () => request.bindingHash,
    perform: async () => {
      throw new Error('Unknown termination/effect');
    },
    readBack: async () => assert.fail('Unknown effect has no readback'),
  });
  const result = await f.runtime.run({ schemaVersion: 1, stage: 'shape' });
  assert.equal(result.code, 'EXTERNAL_EFFECT_UNKNOWN');
  assert.deepEqual(f.state.performed, []);
});
