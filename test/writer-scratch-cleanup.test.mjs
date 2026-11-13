import test from 'node:test';
import assert from 'node:assert/strict';
import { stageHandlers } from '../src/stage-handlers.mjs';

test('Deliver cleans Writer scratch for blocked and interrupted executions', async () => {
  const proof = 'a'.repeat(64);
  const calls = [];
  const { deliver } = stageHandlers({
    store: { put: async () => proof },
    workspace: { discardWriterGit: async value => calls.push(value) },
  });
  const context = {
    execution: { id: 'writer' }, shape: { hash: 'shape' },
    issue: { url: 'https://example.com/issues/1' },
  };
  const thread = '29bfaeac-8760-43e8-a443-ac585d1cf667';
  const lastMessage = JSON.stringify({
    outcome: 'blocked', body: '', summary: 'Missing input', rootCause: 'Missing input',
    failureClass: 'external_failure', evidenceReferences: ['fixture:input'],
    blockingFindings: ['Missing input'], contractConflicts: [],
  });
  const stdout = [
    { type: 'thread.started', thread_id: thread },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: lastMessage } },
    { type: 'turn.completed' },
  ].map(event => JSON.stringify(event)).join('\n');
  const stopped = { executionId: 'writer', terminationHash: proof };
  const blocked = await deliver.readBack(context, { ...stopped, stdout, lastMessage });
  assert.equal(blocked.outcome, 'blocked');
  assert.deepEqual(blocked.findings, ['Missing input']);
  const interrupted = await deliver.readBack(context, {
    ...stopped, status: 'interrupted', code: 'CODEX_IDLE_TIMEOUT', artifacts: {},
  });
  assert.equal(interrupted.outcome, 'blocked');
  assert.deepEqual(interrupted.references, ['evidence:' + proof]);
  await assert.rejects(deliver.readBack(context, { executionId: 'writer' }),
    { code: 'AGENT_TERMINATION_UNPROVEN' });
  assert.deepEqual(calls, [proof, proof]);
});
