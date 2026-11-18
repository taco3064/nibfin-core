import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codexPlan } from '../src/codex-plan.mjs';
import { claudePlan } from '../src/claude-plan.mjs';
import { digest } from '../src/identity.mjs';

// These assertions check instruction delivery, not model choices or host behavior.
const component = {
  cli: { package: '@anthropic-ai/claude-code', version: '2.1.81',
    executable: '/opt/nibfin/claude/bin/claude' },
  runner: 'claude-private-runner-v1', toolChannel: 'claude-scoped-work-v1',
};
const builtin = await readFile(
  new URL('../skills/deliver/SKILL.md', import.meta.url), 'utf8');
const prose = builtin.replace(/\s+/g, ' ');

const requirements = [
  /trace the proposed command from its public wrapper through the implementation/,
  /dependencies of its successful path/,
  /identity, installed state, tools, inputs and privileges/,
  /trusted Job environment and maintained fixtures/,
  /fixture-only Runner provides the production prerequisites/,
  /existing controlled interface exercises the required shared behavior/,
  /use that interface for positive verification/,
  /equivalence from the maintained implementation and caller evidence/,
  /public argument parsing or refusal assertions at the public boundary/,
  /controlled success does not cover those assertions or establish public success/,
  /Do not invent a public testing API, installed host state or new infrastructure/,
  /requirement genuinely requires public success/,
  /preserve that requirement and return the specific conflict/,
  /missing capability, the conflicting requirement and the source\/environment/,
  /Do not weaken the asserted behavior, broaden access/,
  /unrelated missing upstream dependency/,
  /role-owned runnable checks remain required/,
  /workflow-owned checks stay with CI\/CD/,
  /Independent Accept chooses its own verification methods/,
];

test('Deliver supplies all three verification routes with evidence boundaries', () => {
  for (const requirement of requirements) assert.match(prose, requirement);
  assert.match(prose,
    /preview flag, read-only mode or non-mutating intent does not prove/);
  assert.match(prose, /deterministic prompt assertions prove instruction delivery/);
});

for (const provider of ['codex', 'claude']) {
  function plan(stage, content) {
    const skill = { identity: stage, content, hash: digest(content) };
    const options = { skill, context: {} };
    return provider === 'codex'
      ? codexPlan(stage, { ...options, model: 'configured-model' })
      : claudePlan(stage, { ...options,
        modelProfile: { model: 'configured-model' } }, component);
  }

  test(`${provider}: shared feasibility guidance survives Skill replacement`, () => {
    for (const stage of ['deliver', 'accept']) {
      const custom = 'Custom role instructions';
      const selected = plan(stage, custom);
      const contract = selected.prompt.slice(
        selected.prompt.indexOf('TRUSTED CORE VERIFICATION CONTRACT:'),
        selected.prompt.indexOf(custom));
      const text = contract.replace(/\s+/g, ' ');
      assert.match(text, /success-path capabilities/);
      assert.match(text, /preview flag or read-only intent/);
      assert.match(text, /source and caller evidence/);
      assert.match(text, /separately required public argument parsing, refusal/);
      assert.match(text, /public success at their actual boundary/);
      assert.match(text, /required public success needs an unavailable capability/);
      assert.match(text, /specific requirement\/capability conflict/);
      assert.match(text, /Do not infer additional identity, installed state/);
      assert.match(text, /component check stays workflow-owned/);
      assert.match(text, /Do not duplicate them here/);
      assert.match(text, /pending or unavailable workflow results as Unverified/);
      assert.equal(selected.prompt.includes('Choose feasible engineering checks'), false);
    }
  });

  test(`${provider}: built-in Deliver procedure reaches its prompt only`, () => {
    const delivered = plan('deliver', builtin);
    for (const requirement of requirements) {
      assert.match(delivered.prompt.replace(/\s+/g, ' '), requirement);
    }
    const custom = plan('deliver', 'Custom role instructions');
    // Instruction changes must not change either provider's execution permissions.
    assert.equal(delivered.policyHash, custom.policyHash);
    assert.deepEqual(delivered.args, custom.args);
    assert.ok(delivered.prompt.includes(builtin));
    assert.ok(!plan('accept', 'Independent verification').prompt.includes(builtin));
  });
}
