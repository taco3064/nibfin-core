import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { digest } from '../src/identity.mjs';
import { subscriptionSecrets, containsCredentials } from '../src/credential-output.mjs';
import { stageFixture } from './stage-fixture.mjs';

const thread = '12345678-1234-4234-8234-123456789abc';
const tokens = { access_token: 'synthetic-access-token-with-no-authority', refresh_token: 'synthetic-refresh-token-with-no-authority',
  id_token: 'synthetic-identity-token-with-no-authority', account_id: 'fixture-account' };
async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state'), work = join(root, 'work'), authFile = join(root, 'auth.json');
  await mkdir(stateRoot, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens }), { mode: 0o600 });
  const coreRoot = resolve(import.meta.dirname, '..');
  const config = { stateRoot, work, authFile, coreRoot, model: 'configured-model', skills: {
    shape: digest(await readFile(join(coreRoot, 'skills/shape/SKILL.md'), 'utf8')) } };
  let invocations = 0;
  const isolator = { execute: async input => {
    invocations++;
    assert.ok(input.main.endsWith('/current-main'));
    assert.equal(input.plan.config['permissions.nibfin.filesystem']['/main'], 'read');
    assert.equal(input.plan.config['permissions.nibfin.filesystem']['/auth'], 'deny');
    assert.ok(!input.plan.prompt.includes(tokens.access_token));
    assert.deepEqual(Object.keys(input.plan.environment).sort(), ['CODEX_HOME', 'HOME', 'PATH']);
    const message = JSON.stringify({ outcome: 'ready', body: 'Synthetic Shape', summary: 'Checked fixture', rootCause: '', failureClass: 'none',
      evidenceReferences: ['/input/context.json'], blockingFindings: [], contractConflicts: [] });
    await writeFile(join(input.output, 'result.json'), message);
    await mkdir(join(input.session, 'sessions'));
    await writeFile(join(input.session, 'sessions', `rollout-${thread}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
    const value = { status: 'completed', executionId: input.executionId, terminationHash: 'a'.repeat(64),
      policyHash: input.plan.policyHash, isolationHash: 'b'.repeat(64), probeHash: 'c'.repeat(64), stderr: '',
      stdout: [{ type: 'thread.started', thread_id: thread }, { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: message } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n') };
    change(value); return value;
  } };
  return { config, isolator, adapters: { prepareMain: async (root, _issue, head) => {
    await mkdir(root, { mode: 0o700 }); return { base: head, directory: root };
  } }, calls: () => invocations };
}

test('role Agent binds pinned instruction, fixed invocation, isolated result and current main snapshot', async t => {
  const f = await fixture(t), context = stageFixture('shape');
  const result = await new CodexRoleAgent(f.config, f.isolator, f.adapters).run('shape', context);
  assert.equal(result.executionId, context.execution.id); assert.equal(result.threadId, thread);
  assert.equal(f.calls(), 1); assert.ok(!JSON.stringify(result).includes(tokens.access_token));
});

test('missing probe, uncertain termination, credential output and swapped execution cannot become receipts', async t => {
  for (const change of [r => { delete r.probeHash; }, r => { r.status = 'pending'; },
    r => { r.stderr = Buffer.from(tokens.access_token).toString('base64'); }, r => { r.executionId = 'wrong'; }]) {
    const f = await fixture(t, change);
    await assert.rejects(new CodexRoleAgent(f.config, f.isolator, f.adapters).run('shape', stageFixture('shape')));
  }
});

test('API fallback and overlapping workspace/authority configuration reject before any Agent execution', async t => {
  for (const mode of ['api', 'overlap']) {
    const f = await fixture(t);
    if (mode === 'api') await writeFile(f.config.authFile, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key' }));
    else f.config.work = f.config.stateRoot;
    await assert.rejects(new CodexRoleAgent(f.config, f.isolator, f.adapters).run('shape', stageFixture('shape')));
    assert.equal(f.calls(), 0);
  }
});

test('credential scanner rejects common encodings without treating filtering as isolation', () => {
  const secrets = subscriptionSecrets({ auth_mode: 'chatgpt', tokens });
  for (const text of [tokens.access_token, Buffer.from(tokens.refresh_token).toString('hex'), encodeURIComponent(tokens.id_token)]) {
    assert.equal(containsCredentials(text, secrets), true);
  }
  assert.equal(containsCredentials('No credential bytes', secrets), false);
});
