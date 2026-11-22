import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

function setup() {
  const context = stageFixture('accept');
  const reports = [], stored = [];
  const handlers = stageHandlers({ agent: {},
    workspace: { discardWriterGit: async () => {},
      capture: async () => context.candidate },
    store: { put: async value => { stored.push(value); return digest(value); } },
    persistReport: async report => { reports.push(report); },
  });
  return { context, reports, stored, read: handlers.accept.readBack };
}

const roleResult = (passed = true) => ({ outcome: passed ? 'accepted' : 'blocked',
  body: '', summary: 'Fixture', rootCause: passed ? '' : 'Missing input',
  failureClass: passed ? 'none' : 'external_failure',
  evidenceReferences: ['fixture:role'],
  blockingFindings: passed ? [] : ['Missing input'], contractConflicts: [] });

function codexExecution(context, result) {
  const message = JSON.stringify(result);
  return { executionId: context.execution.id, terminationHash: 'a'.repeat(64),
    lastMessage: message, result, expectedThread: context.execution.sessionId,
    stdout: [{ type: 'thread.started', thread_id: context.execution.sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: message } },
      { type: 'turn.completed' }].map(JSON.stringify).join('\n') };
}

// A Claude role returns its terminal envelope and no Codex message.
function claudeExecution(context, result) {
  return { executionId: context.execution.id, terminationHash: 'a'.repeat(64),
    result, stdout: JSON.stringify({ type: 'result', subtype: 'success',
      is_error: false, session_id: context.execution.sessionId,
      structured_output: result }) };
}

test('a Codex execution keeps its read-back outcome', async () => {
  const f = setup();
  // Captured from the base branch, which re-parsed the Codex stream.
  assert.deepEqual(await f.read(f.context, codexExecution(f.context, roleResult())), {
    outcome: 'accepted', report: undefined, rootCause: '', failureClass: 'none',
    findings: [], references: ['fixture:role'], artifacts: {
      shapeHash: '2bf4ce31c15540e0238239ee7c18a64fb433a4058ccbf001488909193a0e8d5c',
      candidateHash: '7be1deed9d126eae3dac5df2f85491449c8462393c3ae9df67ae0a805acb3381',
    } });
  const blocked = await f.read(f.context,
    codexExecution(f.context, roleResult(false)));
  assert.equal(blocked.outcome, 'blocked');
  assert.deepEqual(blocked.findings, ['Missing input']);
  assert.equal(f.reports.length, 1);
});

test('a Claude execution is adopted from its provider-neutral result', async () => {
  for (const passed of [true, false]) {
    const codex = setup(), claude = setup();
    const expected = await codex.read(codex.context,
      codexExecution(codex.context, roleResult(passed)));
    const actual = await claude.read(claude.context,
      claudeExecution(claude.context, roleResult(passed)));
    const timeless = value => JSON.parse(JSON.stringify(value,
      (key, item) => key === 'observedAt' || key === 'id' ? undefined : item));
    assert.deepEqual(timeless(actual), timeless(expected));
  }
  const f = setup();
  const missing = claudeExecution(f.context, roleResult());
  delete missing.result;
  await assert.rejects(f.read(f.context, missing));
  const wrong = claudeExecution(f.context, { ...roleResult(), outcome: 'ready' });
  await assert.rejects(f.read(f.context, wrong), { code: 'WRONG_ROLE_OUTCOME' });
});

test('an idle stop reports the progress line the sandbox kept', async () => {
  // Claude progress uses its own event names, which Codex filtering would drop.
  for (const line of ['NIBFIN_IDLE_PROGRESS tool running',
    'NIBFIN_IDLE_PROGRESS item.started reasoning']) {
    const f = setup();
    const printed = mock.method(console, 'error', () => {});
    try {
      const readback = await f.read(f.context, { executionId: f.context.execution.id,
        terminationHash: 'a'.repeat(64), status: 'interrupted',
        code: 'CODEX_IDLE_TIMEOUT', lastProgress: line, artifacts: {} });
      assert.equal(readback.outcome, 'blocked');
      assert.equal(printed.mock.calls[0].arguments[0], 'Nibfin accept: Agent was ' +
        `stopped after a period without progress. (${line})`);
      assert.equal(f.stored[0].lastProgress, line);
    } finally { printed.mock.restore(); }
  }
});
