import { validateAgentResult } from './agent-result.mjs';
import { requireThat } from './identity.mjs';
import { claudeLimits } from './claude-plan.mjs';

// Print JSON is a single official result envelope, never Codex JSONL or prose.
// Provider metadata is intentionally not copied into the public role result.
export function parseClaudeResult(stage, stdout) {
  requireThat(typeof stdout === 'string' &&
    Buffer.byteLength(stdout) <= claudeLimits.stdout, 'CLAUDE_OUTPUT_LIMIT');
  let envelope;
  try { envelope = JSON.parse(stdout); }
  catch { throw new Error('CLAUDE_MALFORMED_OUTPUT'); }
  rejectDuplicateKeys(stdout);
  requireThat(envelope && !Array.isArray(envelope) &&
    envelope.type === 'result', 'CLAUDE_INVALID_ENVELOPE');
  requireThat(envelope.is_error === false && envelope.subtype === 'success' &&
    (envelope.errors === undefined ||
      Array.isArray(envelope.errors) && envelope.errors.length === 0),
    'CLAUDE_PROVIDER_ERROR');
  requireThat(typeof envelope.session_id === 'string' &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(envelope.session_id),
  'CLAUDE_INVALID_SESSION');
  requireThat(envelope.structured_output &&
    typeof envelope.structured_output === 'object', 'CLAUDE_MISSING_STRUCTURED_OUTPUT');
  let result;
  try { result = validateAgentResult(stage, envelope.structured_output); }
  catch (error) {
    const safe = ['WRONG_ROLE_OUTCOME', 'INCONSISTENT_AGENT_RESULT',
      'EMPTY_SHAPE_RESULT', 'INVALID_AGENT_ROLE'];
    throw new Error(safe.includes(error.code) ? error.code :
      'CLAUDE_INVALID_STRUCTURED_OUTPUT');
  }
  return { result, threadId: envelope.session_id };
}

// JSON.parse alone silently accepts conflicting duplicate object members.
// After syntax validation, scan only strings and container delimiters so braces
// and escaped keys inside values cannot confuse the duplicate-member check.
function rejectDuplicateKeys(text) {
  const stack = [];
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{' || value === '[') {
      stack.push(value === '{' ? new Set() : null);
    } else if (value === '}' || value === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(token.index + value.length))) {
      const key = JSON.parse(value), keys = stack.at(-1);
      requireThat(keys && !keys.has(key), 'CLAUDE_AMBIGUOUS_OUTPUT');
      keys.add(key);
    }
  }
}
