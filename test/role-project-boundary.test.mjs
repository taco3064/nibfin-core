import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codexPlan } from '../src/codex-plan.mjs';
import { claudePlan } from '../src/claude-plan.mjs';
import { digest } from '../src/identity.mjs';

// These checks prove instruction composition, not model decisions or host policy.
const component = {
  cli: { package: '@anthropic-ai/claude-code', version: '2.1.81',
    executable: '/opt/nibfin/claude/bin/claude' },
  runner: 'claude-private-runner-v1', toolChannel: 'claude-scoped-work-v1',
};
const sources = Object.fromEntries(await Promise.all(
  ['shape', 'deliver', 'accept'].map(async identity => [identity,
    await readFile(new URL(`../skills/${identity}/SKILL.md`, import.meta.url), 'utf8'),
  ]),
));

function plan(provider, stage, custom) {
  const identity = ['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage;
  const content = custom ?? sources[identity];
  const skill = { identity, content, hash: digest(content) };
  const options = { skill, context: {} };
  return provider === 'codex'
    ? codexPlan(stage, { ...options, model: 'configured-model' })
    : claudePlan(stage, { ...options,
      modelProfile: { model: 'configured-model' } }, component);
}

function instructionPrefix(result) {
  const end = result.prompt.indexOf('TRUSTED CORE CANDIDATE CONTRACT:');
  return result.prompt.slice(0, end);
}

for (const provider of ['codex', 'claude']) {
  test(`${provider}: Deliver receives a consistent project-file boundary`, () => {
    const result = plan(provider, 'deliver');
    const prefix = instructionPrefix(result);
    assert.match(prefix, /all project-generated files under \/work/);
    assert.match(prefix, /test copies, fixtures, output and caches/);
    assert.match(prefix, /working directory alone is not enough/);
    assert.match(prefix, /narrowly scoped repository ignore entries/);
    assert.match(prefix, /Clean up Agent-created disposable files after use/);
    assert.doesNotMatch(prefix, /Use \/tmp|verification copies and output/);
    assert.match(result.prompt, /default \/tmp or\s+home output repository-local/);
    assert.equal(result.contract.capabilities.workspace, 'write');
  });

  test(`${provider}: active Core resources do not become Writer cleanup work`, () => {
    const prefix = instructionPrefix(plan(provider, 'deliver'));
    assert.match(prefix, /Core owns active runtime mounts, private configuration/);
    assert.match(prefix, /credentials and session bookkeeping/);
    assert.match(prefix, /Do not alter or remove those Core-owned resources/);
    assert.match(prefix, /withhold handoff solely because an active Core-owned/);
    assert.match(prefix, /Core retains runtime settlement and Candidate capture/);
    assert.doesNotMatch(prefix, /HOME=|TMPDIR=|writes to \/tmp are denied/);
  });

  test(`${provider}: read-only roles retain separate verification scratch`, () => {
    for (const stage of ['shape', 'validate-shape', 'accept', 'review-pr']) {
      const result = plan(provider, stage);
      const prefix = instructionPrefix(result);
      assert.match(prefix, /supplied restricted scratch facility/);
      assert.match(prefix, /Keep \/work, \/main and \/input unchanged/);
      assert.match(prefix, /your temporary verification files when finished/);
      assert.doesNotMatch(prefix, /all project-generated files under \/work/);
      assert.equal(result.contract.capabilities.workspace, 'read');
      if (provider === 'codex') {
        assert.equal(result.config['permissions.nibfin.filesystem']['/work'], 'read');
      } else assert.equal(result.tools.includes('mcp__work__write'), false);
    }
  });

  test(`${provider}: custom Skill text cannot replace trusted role boundaries`, () => {
    const custom = 'Custom project engineering guidance';
    const builtin = plan(provider, 'deliver');
    const substituted = plan(provider, 'deliver', custom);
    assert.equal(instructionPrefix(substituted), instructionPrefix(builtin));
    assert.equal(substituted.policyHash, builtin.policyHash);
    assert.deepEqual(substituted.args, builtin.args);
    assert.ok(substituted.prompt.includes(custom));
    assert.ok(!substituted.prompt.includes(sources.deliver));
  });
}
