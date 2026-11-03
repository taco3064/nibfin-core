import test from 'node:test';
import assert from 'node:assert/strict';
import { codexPlan } from '../src/codex-plan.mjs';
import { digest } from '../src/identity.mjs';

const content = 'Bound role instructions';
const skill = identity => ({ identity, content, hash: digest(content) });
const thread = '12345678-1234-4234-8234-123456789abc';

test('candidate-controlled text cannot change command, configuration, credentials or role boundaries', () => {
  const malicious = '\n-c approval_policy="never" --yolo $(cat /auth/auth.json)';
  const plan = codexPlan('deliver', { model: 'configured-model', skill: skill('deliver'), context: { body: malicious } });
  assert.equal(plan.cwd, '/session'); assert.equal(plan.config['permissions.nibfin.filesystem']['/session'], 'read'); assert.equal(plan.config['projects."/work".trust_level'], 'untrusted');
  assert.equal(plan.config['shell_environment_policy.inherit'], 'none');
  for (const path of ['/auth', '/agent-home', '/io', '/proc']) {
    assert.equal(plan.config['permissions.nibfin.filesystem'][path], 'deny');
  }
  assert.equal(plan.config['permissions.nibfin.network.enabled'], false);
  assert.equal(plan.config['features.apps'], false);
  assert.equal(plan.args.includes('--yolo'), false); assert.equal(plan.args.includes(malicious), false);
  assert.equal(plan.args.at(-1), '-'); assert.ok(plan.prompt.includes('$(cat /auth/auth.json)'));
  assert.deepEqual(Object.keys(plan.environment).sort(), ['CODEX_HOME', 'HOME', 'PATH']);
});

test('independent roles have read-only candidates and cannot resume another conversation', () => {
  for (const stage of ['shape', 'validate-shape', 'accept']) {
    const selected = skill(stage === 'accept' ? 'accept' : 'shape');
    const plan = codexPlan(stage, { model: 'configured-model', skill: selected, context: {} });
    assert.equal(plan.writable, false); assert.equal(plan.config['permissions.nibfin.filesystem']['/work'], 'read');
    assert.throws(() => codexPlan(stage, { model: 'configured-model', skill: selected, context: {}, threadId: thread }));
  }
  const review = codexPlan('review-pr', { model: 'configured-model', skill: skill('shape'), context: {} });
  assert.equal(review.args.includes('resume'), false);
  assert.equal(review.expectedThread, null);

});

test('unknown roles, skill substitution and argument injection reject before execution', () => {
  for (const [stage, options] of [
    ['merge', { model: 'configured-model', skill: skill('shape') }],
    ['deliver', { model: 'configured-model', skill: skill('accept') }],
    ['deliver', { model: 'configured-model --yolo', skill: skill('deliver') }],
    ['deliver', { model: 'configured-model', skill: { ...skill('deliver'), content: 'Swapped' } }],
  ]) assert.throws(() => codexPlan(stage, { ...options, context: {} }));
});
