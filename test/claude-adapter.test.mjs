import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../src/identity.mjs';
import { claudePlan, claudeTools, claudeLimits } from '../src/claude-plan.mjs';
import { parseClaudeResult } from '../src/claude-result.mjs';
import { ClaudeRoleAgent } from '../src/claude-agent.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { bindClaudeWorkChannel } from '../src/claude-work-channel.mjs';

const component = {
  cli: { package: '@anthropic-ai/claude-code', version: '2.1.81',
    executable: '/opt/nibfin/claude/bin/claude' },
  runner: 'claude-private-runner-v1', toolChannel: 'claude-scoped-work-v1',
};
const thread = '12345678-1234-4234-8234-123456789abc';
const outcomes = { shape: 'ready', 'validate-shape': 'approved',
  deliver: 'ready', accept: 'accepted', 'review-pr': 'approved' };
function inputs(stage = 'deliver') {
  const identity = ['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage;
  return { modelProfile: { model: 'claude-configured' },
    skill: { identity, content: 'Protected Skill', hash: digest('Protected Skill') } };
}
function result(stage = 'deliver') {
  return { outcome: outcomes[stage], body: 'Content', summary: 'Implemented',
    rootCause: '', failureClass: 'none', evidenceReferences: ['source'],
    blockingFindings: [], contractConflicts: [] };
}
function envelope(value = result()) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: thread, structured_output: value });
}
function plan(stage = 'deliver', extra = {}, config = component) {
  return claudePlan(stage, { ...inputs(stage), context: {}, ...extra }, config);
}

test('private plans are deterministic and role tools are exact', () => {
  for (const stage of Object.keys(outcomes)) {
    const p = plan(stage);
    assert.deepEqual(p, plan(stage));
    assert.deepEqual(p.tools, claudeTools(stage));
    assert.equal(p.contract.capabilities.workspace,
      stage === 'deliver' ? 'write' : 'read');
    assert.equal(p.tools.includes('mcp__work__write'), stage === 'deliver');
    assert.equal(p.cwd, '/session');
    assert.equal(p.repositoryMounts, false);
    assert.deepEqual(JSON.parse(p.args[p.args.indexOf('--mcp-config') + 1]), {
      mcpServers: { work: { type: 'stdio',
        command: '/opt/nibfin/claude/bin/work-tools', args: [], env: {} } },
    });
    assert.equal(p.environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    for (const flag of ['--bare', '--print', '--disable-slash-commands',
      '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(p.args.includes(flag));
    }
    assert.equal(p.args[p.args.indexOf('--tools') + 1], '');
    assert.equal(p.args[p.args.indexOf('--setting-sources') + 1], '');
    assert.ok(!p.args.some(arg => /bypass|skip-permissions|resume|add-dir/.test(arg)));
    assert.match(p.prompt, /Protected Skill/);
    assert.equal(parseClaudeResult(stage, envelope(result(stage))).result.outcome,
      outcomes[stage]);
  }
});

test('work dispatch is bound to the authenticated execution and role', () => {
  for (const stage of Object.keys(outcomes)) {
    const authorize = bindClaudeWorkChannel(stage, thread);
    authorize(thread, 'read');
    authorize(thread, 'check');
    if (stage === 'deliver') authorize(thread, 'write');
    else assert.throws(() => authorize(thread, 'write'), /OPERATION_DENIED/);
    assert.throws(() => authorize(thread, 'exec'), /OPERATION_DENIED/);
    assert.throws(() => authorize('unrelated execution', 'read'), /EXECUTION_MISMATCH/);
  }
  assert.throws(() => bindClaudeWorkChannel('deliver', ''), /INVALID_CLAUDE_WORK/);
});

test('untrusted text cannot select configuration or executable', () => {
  const hostile = '--resume --dangerously-skip-permissions $(cat /auth/key)';
  const a = plan(), b = plan('deliver', { context: { issue: hostile } });
  assert.deepEqual(a.args, b.args);
  assert.equal(a.policyHash, b.policyHash);
  assert.ok(b.prompt.includes(hostile));
  for (const extra of [{ args: [] }, { threadId: thread }, { environment: {} },
    { modelProfile: { model: '--bad' } }, { skill: inputs('accept').skill },
    { skill: { ...inputs().skill, content: 'substituted' } },
    { context: { body: 'a'.repeat(claudeLimits.stdin) } }]) {
    assert.throws(() => plan('deliver', extra));
  }
  assert.throws(() => plan('merge'));
  assert.throws(() => plan('deliver', {}, {}), /PREREQUISITE/);
  assert.throws(() => plan('deliver', {}, { ...component,
    cli: { ...component.cli, executable: '/work/claude' } }), /PREREQUISITE/);
});

test('only unambiguous official structured output succeeds', () => {
  for (const output of ['ready', '{}', '[]', envelope() + envelope(),
    JSON.stringify({ ...JSON.parse(envelope()), structured_output: undefined }),
    JSON.stringify({ ...JSON.parse(envelope()), is_error: true }),
    JSON.stringify({ ...JSON.parse(envelope()), errors: ['failure'] }),
    envelope({ ...result(), extra: 'unknown' }),
    envelope({ ...result(), outcome: 'accepted' }),
    envelope({ ...result(), blockingFindings: ['remaining'] }),
    envelope({ ...result(), evidenceReferences: [] }),
    envelope().replace('"is_error":false', '"is_error":true,"is_error":false'),
    envelope().replace('"outcome":"ready"',
      '"outcome":"blocked","outcome":"ready"')]) {
    assert.throws(() => parseClaudeResult('deliver', output));
  }
  const blocked = { ...result(), outcome: 'blocked',
    failureClass: 'external_failure', blockingFindings: ['Unavailable'] };
  const parsed = parseClaudeResult('deliver', envelope(blocked));
  assert.equal(parsed.result.outcome, 'blocked');
  assert.throws(() => parseClaudeResult('deliver',
    'x'.repeat(claudeLimits.stdout + 1)), /OUTPUT_LIMIT/);
  assert.throws(() => parseClaudeResult('deliver',
    envelope({ ...result(), 'private-token': true })), error =>
    !error.message.includes('private-token'));
});

async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runner = { contract: 'claude-private-runner-v1',
    async execute({ plan, executionId, session }) {
      calls.push(['execute', session]);
      return { status: 'completed', executionId, policyHash: plan.policyHash,
        terminationHash: 'a'.repeat(64), isolationHash: 'b'.repeat(64),
        probeHash: 'c'.repeat(64), exitCode: 0, stdout: envelope(), stderr: '',
        ...overrides };
    },
    async requestCleanup(id) { calls.push(['cleanup', id]); },
    async assertOutputSafe() { calls.push(['scan']); return true; },
    async retire(id) { calls.push(['retire', id]); },
  };
  return { root, calls, runner, agent: new ClaudeRoleAgent(component, runner, root) };
}

test('runner double gates retirement on termination and safety', async t => {
  const h = await harness(t), context = stageFixture('deliver');
  const delivered = await h.agent.run('deliver', context, inputs());
  assert.equal(delivered.result.outcome, 'ready');
  assert.deepEqual(h.calls.map(call => call[0]),
    ['execute', 'cleanup', 'scan', 'retire']);
  assert.deepEqual(Object.keys(delivered).sort(), ['executionId', 'isolationHash',
    'probeHash', 'result', 'terminationHash', 'threadId']);
  const dirs = await readdir(h.root);
  assert.deepEqual(await readdir(join(h.root, dirs[0])), []);
  await assert.rejects(h.agent.run('deliver', context, inputs()), { code: 'EEXIST' });
  const next = stageFixture('accept');
  h.runner.execute = async ({ plan, executionId, session }) => {
    h.calls.push(['execute', session]);
    return { status: 'completed', executionId, policyHash: plan.policyHash,
      terminationHash: 'a'.repeat(64), isolationHash: 'b'.repeat(64),
      probeHash: 'c'.repeat(64), exitCode: 0, stdout: envelope(result('accept')),
      stderr: '' };
  };
  await h.agent.run('accept', next, inputs('accept'));
  const paths = h.calls.filter(call => call[0] === 'execute').map(call => call[1]);
  assert.equal(new Set(paths).size, 2);
});

test('failures retain fences and never retire unsafe output', async t => {
  for (const [overrides, message] of [
    [{ terminationHash: null }, /TERMINATION_UNPROVEN/],
    [{ timedOut: true }, /TIMEOUT/],
    [{ exitCode: 1 }, /PROCESS_ERROR/],
    [{ stdout: '{}' }, /INVALID_ENVELOPE/],
    [{ exitCode: 1,
      stdout: envelope().replace('"success"', '"error_during_execution"') },
      /PROVIDER_ERROR/],
    [{ stdout: 'not json' }, /MALFORMED_OUTPUT/],
    [{ stderr: 'x'.repeat(claudeLimits.stderr + 1) }, /OUTPUT_LIMIT/],
  ]) {
    const h = await harness(t, overrides), context = stageFixture('deliver');
    await assert.rejects(h.agent.run('deliver', context, inputs()), message);
    assert.ok(h.calls.some(call => call[0] === 'cleanup'));
    assert.ok(!h.calls.some(call => call[0] === 'retire'));
    await assert.rejects(h.agent.run('deliver', context, inputs()), { code: 'EEXIST' });
  }
});

test('private runner failures are sanitized and cleanup remains mandatory', async t => {
  for (const method of ['execute', 'assertOutputSafe', 'requestCleanup', 'retire']) {
    const h = await harness(t);
    h.runner[method] = async () => { throw new Error('private-credential'); };
    await assert.rejects(h.agent.run('deliver', stageFixture('deliver'), inputs()),
      error => /CLAUDE_/.test(error.message) &&
        !error.message.includes('private-credential'));
  }
  assert.throws(() => new ClaudeRoleAgent(component, {}, '/tmp'), /PREREQUISITE/);
});

test('safe interruptions retire only after termination and output scanning', async t => {
  const h = await harness(t, { status: 'interrupted' });
  const value = await h.agent.run('deliver', stageFixture('deliver'), inputs());
  assert.equal(value.status, 'interrupted');
  assert.equal(value.result, undefined);
  assert.deepEqual(h.calls.map(call => call[0]),
    ['execute', 'cleanup', 'scan', 'retire']);
});

test('output scan must positively establish safety', async t => {
  const h = await harness(t);
  h.runner.assertOutputSafe = async () => false;
  await assert.rejects(h.agent.run('deliver', stageFixture('deliver'), inputs()),
    /UNSAFE_OUTPUT/);
  assert.ok(!h.calls.some(call => call[0] === 'retire'));
});
