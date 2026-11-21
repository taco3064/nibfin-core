import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { claudePolicyHash } from '../src/claude-agent-plan.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

const thread = '12345678-1234-4234-8234-123456789abc';
const claudeToken = 'sk-ant-oat01-' + 'c'.repeat(40);
const tokens = { access_token: 'synthetic-access-token-with-no-authority',
  refresh_token: 'synthetic-refresh-token-with-no-authority',
  id_token: 'synthetic-identity-token-with-no-authority', account_id: 'fixture' };
const result = { outcome: 'ready', body: 'Synthetic Shape', summary: 'Checked fixture',
  rootCause: '', failureClass: 'none', evidenceReferences: ['/input/context.json'],
  blockingFindings: [], contractConflicts: [] };
const message = JSON.stringify(result);
const codexStream = [{ type: 'thread.started', thread_id: thread },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: message } },
  { type: 'turn.completed' }].map(event => JSON.stringify(event)).join('\n');
const claudeStream = JSON.stringify({ type: 'result', subtype: 'success',
  is_error: false, session_id: thread, structured_output: result });

async function fixture(t, provider, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-agent-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state'), work = join(root, 'work');
  await mkdir(stateRoot, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
  const coreRoot = resolve(import.meta.dirname, '..');
  const config = { stateRoot, work, coreRoot, model: 'configured-model', skills: {
    shape: digest(await readFile(join(coreRoot, 'skills/shape/SKILL.md'), 'utf8')) } };
  if (provider === 'claude') config.provider = 'claude';
  else {
    config.authFile = join(root, 'auth.json');
    await writeFile(config.authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens }),
      { mode: 0o600 });
  }
  const inputs = [];
  const isolator = { execute: async input => {
    inputs.push({ ...input, files: await readdir(input.input) });
    if (provider !== 'claude') await writeFile(join(input.output, 'result.json'),
      message);
    const value = { status: 'completed', executionId: input.executionId,
      terminationHash: 'a'.repeat(64), policyHash: input.plan.policyHash,
      isolationHash: 'b'.repeat(64), probeHash: 'c'.repeat(64), stderr: '',
      stdout: provider === 'claude' ? claudeStream : codexStream };
    change(value); return value;
  } };
  let reads = 0;
  const options = { prepareMain: async (path, _issue, head) => {
    await mkdir(path, { mode: 0o700 }); return { base: head, directory: path };
  }, readCredential: async () => { reads++; return claudeToken; } };
  return { config, isolator, options, inputs, reads: () => reads };
}

// Captured from origin/main before the provider branch; `result` is the only
// addition to the Codex return shape.
test('Codex role return keeps every field and adds the normalized result',
  async t => {
    const f = await fixture(t, 'codex'), context = stageFixture('shape');
    const value = await new CodexRoleAgent(f.config, f.isolator, f.options)
      .run('shape', context);
    assert.deepEqual(Object.keys(value), ['executionId', 'terminationHash',
      'terminationObservation', 'stdout', 'lastMessage', 'expectedThread',
      'threadId', 'isolationHash', 'probeHash', 'invocationHash', 'result']);
    assert.deepEqual(value, { executionId: context.execution.id,
      terminationHash: 'a'.repeat(64), terminationObservation: undefined,
      stdout: codexStream, lastMessage: message, expectedThread: null,
      threadId: thread, isolationHash: 'b'.repeat(64), probeHash: 'c'.repeat(64),
      invocationHash: '9109dde6c6bc041a9c1c68c70d02a8393fd9681a70f52416fad06bcbebb74f90',
      result });
    assert.equal(f.reads(), 0);
    assert.equal(f.inputs[0].credential, undefined);
    assert.equal(f.inputs[0].auth, f.config.authFile);
  });

test('Claude role passes its stored credential to the isolator only', async t => {
  const f = await fixture(t, 'claude'), context = stageFixture('shape');
  const value = await new CodexRoleAgent(f.config, f.isolator, f.options)
    .run('shape', context);
  assert.equal(f.reads(), 1);
  const [input] = f.inputs;
  assert.equal(input.plan.provider, 'claude');
  assert.equal(input.plan.policyHash, claudePolicyHash(input.plan));
  assert.equal(input.auth, undefined);
  assert.equal(input.credential, claudeToken);
  assert.ok(!JSON.stringify(input.plan).includes(claudeToken));
  assert.ok(!input.files.includes('result.json'));
  assert.deepEqual(value.result, result);
  assert.equal(value.threadId, thread);
  assert.equal(value.lastMessage, undefined);
  assert.equal(value.stdout, claudeStream);
  assert.ok(!JSON.stringify(value).includes(claudeToken));
});

test('Claude output carrying the credential or a bad envelope is rejected',
  async t => {
    for (const change of [r => { r.stderr = claudeToken; },
      r => { r.stdout = Buffer.from(claudeToken).toString('base64'); },
      r => { r.stdout = claudeStream.replace('"is_error":false', '"is_error":true'); },
      r => { delete r.probeHash; }]) {
      const f = await fixture(t, 'claude', change);
      await assert.rejects(new CodexRoleAgent(f.config, f.isolator, f.options)
        .run('shape', stageFixture('shape')));
    }
    const missing = await fixture(t, 'claude');
    missing.options.readCredential = async () => {
      throw new Error('private detail');
    };
    await assert.rejects(new CodexRoleAgent(missing.config, missing.isolator,
      missing.options).run('shape', stageFixture('shape')),
    { message: 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
    assert.equal(missing.inputs.length, 0);
    assert.throws(() => new CodexRoleAgent({ ...missing.config, provider: 'other' },
      missing.isolator), /INVALID_AGENT_ADAPTER/);
  });

test('an interrupted Claude run scans private output for the credential',
  async t => {
    const f = await fixture(t, 'claude', r => {
      r.status = 'interrupted'; r.code = 'CODEX_IDLE_TIMEOUT';
    });
    const isolator = { execute: async input => {
      const value = await f.isolator.execute(input);
      await writeFile(join(input.output, 'stream.json'),
        JSON.stringify({ stdout: '', stderr: claudeToken }));
      return value;
    } };
    await assert.rejects(new CodexRoleAgent(f.config, isolator, f.options)
      .run('shape', stageFixture('shape')), { message: 'CREDENTIAL_OUTPUT_REJECTED' });
  });

test('a Firecracker writer selects the Claude VM-mode plan, never Codex\'s',
  async t => {
    const f = await fixture(t, 'claude');
    f.config.jobVm = true;
    // Only a writer has a VM mode; a read role cannot be given one.
    await assert.rejects(new CodexRoleAgent(f.config, f.isolator, f.options)
      .run('shape', stageFixture('shape')), /INVALID_CLAUDE_PLAN/);
    assert.equal(f.inputs.length, 0);
    const docker = await fixture(t, 'claude');
    await new CodexRoleAgent(docker.config, docker.isolator, docker.options)
      .run('shape', stageFixture('shape'));
    assert.equal(docker.inputs[0].plan.jobVm, undefined);
    const codex = await fixture(t, 'codex');
    codex.config.jobVm = true;
    await new CodexRoleAgent(codex.config, codex.isolator, codex.options)
      .run('shape', stageFixture('shape'));
    assert.equal(codex.inputs[0].plan.jobVm, undefined);
    assert.equal(codex.inputs[0].plan.provider, undefined);
  });
