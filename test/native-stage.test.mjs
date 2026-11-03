import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeStageExecutor, runStageInput } from '../src/native-stage.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { evidenceBinding } from '../src/stages.mjs';

async function fixture(t) {
  const f = await nativeFixture(t); let effects = 0;
  const agent = { run: async (_stage, context) => {
    effects++;
    const lastMessage = JSON.stringify({ outcome: 'ready', body: f.context.shape.body,
      summary: 'Synthetic isolated execution', rootCause: '', failureClass: 'none',
      evidenceReferences: ['fixture:role'], blockingFindings: [], contractConflicts: [] });
    return { executionId: context.execution.id, terminationHash: 'a'.repeat(64), lastMessage,
      stdout: [{ type: 'thread.started', thread_id: context.execution.sessionId }, { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: lastMessage } },
        { type: 'turn.completed' }].map(JSON.stringify).join('\n') };
  } };
  const options = { ...f.adapters, agent, token: 'synthetic-token',
    workspace: { push: async () => { throw new Error('Unexpected push'); } },
    sandbox: { execute: async () => { throw new Error('Unexpected hook'); } } };
  return { ...f, options, agent, effects: () => effects };
}
const request = JSON.stringify({ schemaVersion: 1, stage: 'shape' });

test('native stage assembly connects fresh provider admission, role parser and durable bound evidence', async t => {
  const f = await fixture(t), executor = nativeStageExecutor(f.options);
  const result = await runStageInput(request, executor);
  assert.equal(result.status, 'completed'); assert.equal(f.effects(), 1);
  const observed = await f.observe('shape');
  const store = new EvidenceStore(f.root, evidenceBinding(observed));
  const receipts = await store.load();
  assert.equal(receipts.shape.execution.id, f.options.execution.id);
  assert.equal(await store.get(receipts.shape.artifacts.shapeHash), f.context.shape.body);
  assert.equal((await runStageInput(request, nativeStageExecutor(f.options))).code, 'REPLAYED_OPERATION');
  assert.equal(f.effects(), 1);
});

test('revoked authorization between host preparation and execution never reaches the Agent', async t => {
  const f = await fixture(t); let calls = 0;
  const inspect = f.options.inspectCaller;
  f.options.inspectCaller = async runner => {
    const value = await inspect(runner);
    if (++calls === 1) f.data['/collaborators/reviewer/permission'].permission = 'read';
    return value;
  };
  assert.equal((await runStageInput(request, nativeStageExecutor(f.options))).status, 'denied');
  assert.equal(f.effects(), 0);
});

test('an unknown Agent outcome remains fenced across new executor instances', async t => {
  const f = await fixture(t); let effects = 0;
  f.agent.run = async () => { effects++; throw new Error('Lost process result'); };
  assert.equal((await runStageInput(request, nativeStageExecutor(f.options))).status, 'pending');
  assert.equal((await runStageInput(request, nativeStageExecutor(f.options))).code, 'EXTERNAL_EFFECT_UNKNOWN');
  assert.equal(effects, 1);
});

test('transport rejects commands, authority overrides and oversized input before touching the host', async () => {
  let calls = 0;
  const executor = { run: async () => { calls++; throw new Error('private credential detail'); } };
  for (const input of ['null', '[]', '{', ' '.repeat(4097),
    '{"schemaVersion":1,"stage":"shape","token":"forged"}',
    '{"schemaVersion":1,"stage":"shape","adapter":"/work/evil.mjs"}',
    '{"schemaVersion":1,"stage":"constructor"}']) {
    assert.equal((await runStageInput(input, executor)).code, 'INVALID_STAGE_REQUEST');
  }
  assert.equal(calls, 0);
  const result = await runStageInput(request, executor);
  assert.equal(result.status, 'pending'); assert.equal(JSON.stringify(result).includes('credential'), false);
});
