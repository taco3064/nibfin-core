import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageRuntime } from '../src/stage-runtime.mjs';
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
