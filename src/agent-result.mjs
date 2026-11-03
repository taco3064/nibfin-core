import { validateSchema } from './schema.mjs';
import { requireThat } from './identity.mjs';

// Compatible structured result fields from the inspected reference; the Agent
// cannot choose execution identity, evidence binding or authorization.
export const resultSchema = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'body', 'summary', 'rootCause', 'failureClass', 'evidenceReferences', 'blockingFindings', 'contractConflicts'],
  properties: {
    outcome: { type: 'string', enum: ['ready', 'approved', 'accepted', 'changes_required', 'blocked', 'decision_required', 'proposal_update_required'] },
    body: { type: 'string' }, summary: { type: 'string' }, rootCause: { type: 'string' },
    failureClass: { type: 'string', enum: ['none', 'implementation_defect', 'shape_defect', 'authority_gap', 'external_failure'] },
    evidenceReferences: { type: 'array', items: { type: 'string' } }, blockingFindings: { type: 'array', items: { type: 'string' } },
    contractConflicts: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['scopeHash', 'shapeHash', 'scopeQuote', 'shapeQuote', 'explanation', 'evidenceReference'],
      properties: Object.fromEntries(['scopeHash', 'shapeHash', 'scopeQuote', 'shapeQuote', 'explanation', 'evidenceReference'].map(key => [key, { type: 'string' }])) } },
  },
};
const success = { shape: 'ready', 'validate-shape': 'approved', 'review-pr': 'approved', deliver: 'ready', accept: 'accepted' };
export function parseAgentResult(stage, stdout, lastMessage, expectedThread) {
  requireThat(Object.hasOwn(success, stage) && typeof stdout === 'string' && Buffer.byteLength(stdout) <= 8 * 1024 * 1024,
    'INVALID_AGENT_STREAM');
  const events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  requireThat(events.at(-1)?.type === 'turn.completed' && events.filter(event => event.type === 'turn.started').length === 1 &&
    events.filter(event => event.type === 'turn.completed').length === 1 && !events.some(event => ['turn.failed', 'error'].includes(event.type)),
  'AGENT_TURN_INCOMPLETE');
  const threads = events.filter(event => event.type === 'thread.started').map(event => event.thread_id);
  requireThat(threads.length === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threads[0]) &&
    (!expectedThread || threads[0] === expectedThread), 'AGENT_SESSION_MISMATCH');
  const item = events.filter(event => event.type === 'item.completed').at(-1)?.item;
  requireThat(item?.type === 'agent_message' && typeof item.text === 'string' && item.text === lastMessage, 'AMBIGUOUS_AGENT_RESULT');
  const result = validateSchema(JSON.parse(item.text), resultSchema);
  const passed = result.outcome === success[stage];
  requireThat(passed || ['changes_required', 'blocked', 'decision_required', 'proposal_update_required'].includes(result.outcome), 'WRONG_ROLE_OUTCOME');
  requireThat(result.summary.trim() && result.evidenceReferences.length > 0 && result.evidenceReferences.every(value => value.trim()) &&
    result.blockingFindings.every(value => value.trim()) && (passed ? result.blockingFindings.length === 0 && result.failureClass === 'none' :
      result.blockingFindings.length > 0 && result.failureClass !== 'none'), 'INCONSISTENT_AGENT_RESULT');
  if (stage === 'shape' && passed) requireThat(result.body.trim(), 'EMPTY_SHAPE_RESULT');
  return { result, threadId: threads[0] };
}
