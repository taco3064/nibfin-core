import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentResult } from '../src/agent-result.mjs';

test('a successful Deliver can record the defect it corrected', () => {
  const result = {
    outcome: 'ready',
    body: '',
    summary: 'Ran browser tests with the installed browser.',
    rootCause: 'The hosted browser download used an unsupported platform.',
    failureClass: 'implementation_defect',
    evidenceReferences: ['internal/dashboard/browsertest/run.mjs'],
    blockingFindings: [],
    contractConflicts: [],
  };
  const parse = () => {
    const message = JSON.stringify(result);
    const events = [
      { type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: message } },
      { type: 'turn.completed' },
    ];
    return parseAgentResult('deliver', events.map(JSON.stringify).join('\n'), message);
  };
  assert.deepEqual(parse().result, result);
  result.blockingFindings.push('Browser tests are still failing.');
  assert.throws(parse, /INCONSISTENT_AGENT_RESULT/);
});
