import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseAgentResult } from '../src/agent-result.mjs';
import { readSkill, skillIdentity } from '../src/skills.mjs';
import { digest } from '../src/identity.mjs';
const thread = '00000000-0000-4000-8000-000000000001';
function fixture(outcome = 'ready') {
  const result = { outcome, body: 'Proposed Shape', summary: 'Evidence inspected', rootCause: '', failureClass: 'none',
    evidenceReferences: ['src/example.mjs'], blockingFindings: [], contractConflicts: [] };
  const stream = value => [{ type: 'thread.started', thread_id: thread }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n');
  return { result, stream };
}
test('completed role-specific result is accepted without accepting Agent identity or authority fields', () => {
  const f = fixture(); assert.equal(parseAgentResult('shape', f.stream(f.result), JSON.stringify(f.result)).threadId, thread);
  f.result.authorized = true; assert.throws(() => parseAgentResult('shape', f.stream(f.result), JSON.stringify(f.result)));
});
test('truncated streams, swapped sessions, mismatched final files, self-accepted writer and inconsistent success reject', () => {
  const f = fixture();
  assert.throws(() => parseAgentResult('shape', f.stream(f.result).split('\n').slice(0, -1).join('\n'), JSON.stringify(f.result)));
  assert.throws(() => parseAgentResult('shape', f.stream(f.result), JSON.stringify(f.result), '00000000-0000-4000-8000-000000000002'));
  assert.throws(() => parseAgentResult('shape', f.stream(f.result), '{}'));
  const writer = fixture('accepted'); assert.throws(() => parseAgentResult('deliver', writer.stream(writer.result), JSON.stringify(writer.result)));
  f.result.blockingFindings.push('Unresolved'); assert.throws(() => parseAgentResult('shape', f.stream(f.result), JSON.stringify(f.result)));
});
test('fixed approved Skill identity is distinct from its execution role and repository instructions', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const stage of ['shape', 'validate-shape', 'review-pr', 'deliver', 'accept']) {
    const identity = skillIdentity(stage), content = await readFile(new URL(`../skills/${identity}/SKILL.md`, import.meta.url), 'utf8');
    assert.equal((await readSkill(root, stage, digest(content))).identity, identity);
    await assert.rejects(readSkill(root, stage, '0'.repeat(64)), /SKILL_IDENTITY_CHANGED/);
  }
  assert.throws(() => skillIdentity('publish-shape'), /UNKNOWN_AGENT_ROLE/);
});
