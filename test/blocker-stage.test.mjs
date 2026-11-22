import test from 'node:test';
import assert from 'node:assert/strict';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { stageFixture } from './stage-fixture.mjs';

function setup() {
  const context = stageFixture('deliver');
  const reports = [];
  const handlers = stageHandlers({ agent: {},
    workspace: { discardWriterGit: async () => {} },
    store: { put: async () => 'b'.repeat(64) },
    persistReport: async report => { reports.push(report); },
  });
  return { context, reports, read: handlers.deliver.readBack };
}

test('blocked readback preserves validated cause with actual Core execution',
  async () => {
    const { context, reports, read } = setup();
    const result = { outcome: 'blocked', body: '', summary: 'Native result missing',
      rootCause: 'The required workflow result is unavailable.',
      failureClass: 'external_failure',
      evidenceReferences: ['https://github.com/example/core/issues/2'],
      blockingFindings: ['Matching native result is required.'], contractConflicts: [] };
    const message = JSON.stringify(result);
    const execution = { executionId: context.execution.id,
      terminationHash: 'a'.repeat(64), lastMessage: message, result,
      stdout: [
        { type: 'thread.started', thread_id: context.execution.sessionId },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: message } },
        { type: 'turn.completed' },
      ].map(JSON.stringify).join('\n') };
    const readback = await read(context, execution);
    assert.equal(readback.rootCause, result.rootCause);
    assert.equal(readback.failureClass, result.failureClass);
    assert.equal(readback.report.binding.executionId, context.execution.id);
    assert.deepEqual(readback.report.binding.issue, context.approval.record.issue);
    assert.equal(reports.length, 1);
    assert.deepEqual(readback.report.hypotheses, ['AGENT_ATTRIBUTED_EXPLANATION']);
  });

test('abrupt termination retains observations without fabricating an Agent result',
  async () => {
    const { context, reports, read } = setup();
    const readback = await read(context, { status: 'interrupted',
      executionId: context.execution.id, terminationHash: 'a'.repeat(64),
      code: 'PROCESS_FAILED', artifacts: { shapeHash: context.shape.hash },
      terminationObservation: { owner: 'docker-inspect',
        executionId: context.execution.id, containerId: 'c'.repeat(64),
        running: false, exitCode: 137, oomKilled: false,
        observedAt: '2026-11-18T12:00:00Z' } });
    assert.equal(readback.outcome, 'blocked');
    assert.equal(reports[0].producer, 'core-native');
    assert.equal(reports[0].rootCause, null);
    assert.equal(reports[0].failureClass, null);
    assert.equal(reports[0].termination.exitCode, 137);
  });
