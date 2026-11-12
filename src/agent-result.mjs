import { validateSchema } from './schema.mjs';
import { requireThat } from './identity.mjs';

const success = {
  shape: 'ready',
  'validate-shape': 'approved',
  'review-pr': 'approved',
  deliver: 'ready',
  accept: 'accepted',
};
const unsuccessful = [
  'changes_required', 'blocked', 'decision_required', 'proposal_update_required',
];
const conflictFields = [
  'scopeHash', 'shapeHash', 'scopeQuote', 'shapeQuote', 'explanation',
  'evidenceReference',
];

// The Agent cannot choose execution identity, evidence binding or authorization.
export const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome', 'body', 'summary', 'rootCause', 'failureClass', 'evidenceReferences',
    'blockingFindings', 'contractConflicts',
  ],
  properties: {
    outcome: {
      type: 'string', enum: ['ready', 'approved', 'accepted', ...unsuccessful],
    },
    body: { type: 'string' },
    summary: { type: 'string' },
    rootCause: { type: 'string' },
    failureClass: {
      type: 'string',
      enum: ['none', 'implementation_defect', 'shape_defect', 'authority_gap',
        'external_failure'],
    },
    evidenceReferences: { type: 'array', items: { type: 'string' } },
    blockingFindings: { type: 'array', items: { type: 'string' } },
    contractConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: conflictFields,
        properties: Object.fromEntries(conflictFields.map(key => [key, {
          type: 'string',
        }])),
      },
    },
  },
};

export function parseAgentResult(stage, stdout, lastMessage, expectedThread) {
  requireThat(Object.hasOwn(success, stage) && typeof stdout === 'string' &&
    Buffer.byteLength(stdout) <= 8 * 1024 * 1024, 'INVALID_AGENT_STREAM');
  const events = stdout.split('\n').filter(line => line.trim())
    .map(line => JSON.parse(line));
  requireThat(
    events.at(-1)?.type === 'turn.completed' &&
    events.filter(event => event.type === 'turn.started').length === 1 &&
    events.filter(event => event.type === 'turn.completed').length === 1 &&
    !events.some(event => ['turn.failed', 'error'].includes(event.type)),
    'AGENT_TURN_INCOMPLETE',
  );
  const threads = events.filter(event => event.type === 'thread.started')
    .map(event => event.thread_id);
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  requireThat(threads.length === 1 && uuid.test(threads[0]) &&
    (!expectedThread || threads[0] === expectedThread), 'AGENT_SESSION_MISMATCH');
  const item = events.filter(event => event.type === 'item.completed').at(-1)?.item;
  requireThat(item?.type === 'agent_message' && typeof item.text === 'string' &&
    item.text === lastMessage, 'AMBIGUOUS_AGENT_RESULT');
  const result = validateSchema(JSON.parse(item.text), resultSchema);
  const passed = result.outcome === success[stage];
  requireThat(passed || unsuccessful.includes(result.outcome), 'WRONG_ROLE_OUTCOME');
  // A successful repair may describe the defect it fixed. Findings describe
  // blockers that remain in this result and still prevent a successful outcome.
  const findings = result.blockingFindings;
  const consistent = passed ? findings.length === 0 :
    findings.length > 0 && result.failureClass !== 'none';
  requireThat(result.summary.trim() && result.evidenceReferences.length > 0 &&
    result.evidenceReferences.every(value => value.trim()) &&
    findings.every(value => value.trim()) && consistent, 'INCONSISTENT_AGENT_RESULT');
  if (stage === 'shape' && passed) requireThat(result.body.trim(), 'EMPTY_SHAPE_RESULT');
  return { result, threadId: threads[0] };
}
