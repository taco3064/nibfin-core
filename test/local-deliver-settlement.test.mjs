import { roleCoreFixture } from './role-core-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localDeliverSettlement } from '../src/local-deliver-settlement.mjs';
import { settleHostStage, assertHostSettlement }
  from '../src/host-stage-settlement.mjs';
import { acquireHostFence } from '../src/host-fence.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { withUserMcp } from '../src/mcp-agent.mjs';
import { jobMcpProfile } from '../src/mcp-job.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

const pending = { stage: 'deliver', status: 'pending',
  code: 'LOCAL_DELIVER_INTERRUPTED' };
const quiet = () => {};

async function fixture(t) {
  const scratch = resolve('.deliver-test-tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(scratch, 'settlement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = stageFixture('deliver');
  const fence = await acquireHostFence(root, { execution: context.execution });
  const lifecycle = localDeliverSettlement(fence);
  const invocation = lifecycle.invocation('deliver', context.execution);
  invocation.composed();
  return { root, context, fence, lifecycle, invocation };
}

test('local journal failure settles a never-entered Writer and preserves edits',
  async t => {
    const f = await fixture(t);
    const journal = new OperationJournal(f.root, { id: 'I_local', repositoryId: 10 });
    const edit = join(f.root, 'maintained.txt');
    const request = { operation: 'deliver', bindingHash: 'a'.repeat(64) };
    const adapters = { localDeliver: true, admit: async () => request.bindingHash,
      readBack: async () => request.bindingHash, perform: async () => {
        await writeFile(edit, 'preserved');
        throw Object.assign(new Error('private detail'), { code: 'EIO' });
      } };
    const result = await settleHostStage(async () => ({
      ...await journal.run(request, adapters), stage: 'deliver',
    }), async () => {
      await assertHostSettlement(journal, async () => {});
      await f.fence.release();
    }, quiet, () => f.lifecycle.assertSettled());
    assert.equal(result.retrySettled, true);
    assert.equal(result.code, pending.code);
    assert.equal(await readFile(edit, 'utf8'), 'preserved');
    assert.ok(!(await readdir(f.root)).includes('stage.lock'));
    let writes = 0;
    const resumed = { ...adapters, perform: async () => { writes++; } };
    assert.equal((await journal.run(request, resumed)).status, 'completed');
    assert.equal(writes, 1);
    assert.equal((await journal.run(request, resumed)).code, 'REPLAYED_OPERATION');
    assert.equal(writes, 1);
  });

test('partial composition, owners, foreign executions and changed fence retain Pending',
  async t => {
    for (const fault of ['composition', 'role', 'backend/workspace', 'mcp', 'fence']) {
      const f = await fixture(t);
      if (fault === 'composition') f.lifecycle.invocation('deliver', { id: 'next' });
      else if (fault === 'fence')
        await writeFile(join(f.root, 'stage.lock'), 'changed fence');
      else f.invocation.enter(fault);
      let releases = 0;
      const result = await settleHostStage(async () => pending,
        async () => { releases++; }, quiet, () => f.lifecycle.assertSettled());
      assert.equal(result.status, 'pending');
      assert.equal(result.retrySettled, undefined);
      if (fault === 'fence') assert.equal(result.code, 'HOST_FENCE_CHANGED');
      assert.equal(releases, 0);
    }
    const f = await fixture(t);
    assert.throws(() => f.invocation.assertExecution({ id: 'wrong' }),
      { code: 'LOCAL_DELIVER_EXECUTION_CHANGED' });
    const complete = f.invocation.enter('backend/workspace');
    complete();
    assert.throws(complete, { code: 'LOCAL_DELIVER_OBSERVATION_REUSED' });
    const second = f.lifecycle.invocation('deliver', { id: 'second' });
    second.composed();
    second.enter('backend/workspace');
    await assert.rejects(f.lifecycle.assertSettled(),
      { code: 'LOCAL_DELIVER_HAND_BACK_UNPROVEN' });
  });

test('local settlement never bypasses release checks or generic Pending handling',
  async t => {
    const f = await fixture(t);
    for (const code of ['EXTERNAL_EFFECT_UNKNOWN', 'JOURNAL_CORRUPT',
      'WRITER_NOT_PROVEN_TERMINATED', 'HOST_FENCE_CHANGED',
      'MCP_JOB_TERMINATION_UNPROVEN']) {
      const result = await settleHostStage(async () => pending, async () => {
        throw Object.assign(new Error('private detail'), { code });
      }, quiet, () => f.lifecycle.assertSettled());
      assert.equal(result.code, code);
      assert.equal(result.retrySettled, undefined);
    }
    for (const result of [{ ...pending, stage: 'accept' },
      { ...pending, code: 'EXTERNAL_EFFECT_UNKNOWN' }]) {
      assert.equal(await settleHostStage(async () => result,
        () => assert.fail('No release'), quiet,
        () => assert.fail('No local settlement')), result);
    }
    assert.equal(await settleHostStage(async () => pending,
      () => assert.fail('A diagnostic is not proof'), quiet), pending);
  });

async function roleFixture(t, fault) {
  const f = await fixture(t);
  const stateRoot = join(f.root, 'agent'), work = join(f.root, 'work');
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  const authFile = join(f.root, 'model.json');
  const secret = 'synthetic-only-model-token';
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: secret, refresh_token: secret + '-refresh', id_token: secret + '-id',
  } }), { mode: 0o600 });
  const profile = { expiresAt: null, configuration: { mcp_servers: {} },
    metadata: {}, policyHash: 'a'.repeat(64), secrets: ['synthetic-mcp-token'] };
  const job = jobMcpProfile(async () => profile);
  const isolator = withUserMcp({ execute: async input => {
    await writeFile(join(work, 'edit.txt'), 'Writer edit');
    if (fault !== 'unknown-backend' && fault !== 'vm') {
      input.onInterruptedCleanup();
      input.onLocalHandback();
    }
    if (fault === 'role-retirement') {
      const lock = join(input.session, '..', 'active.lock');
      await rm(lock);
      await mkdir(lock);
    }
    if (fault === 'model-leak' || fault === 'mcp-leak') {
      await writeFile(join(input.output, 'stream.json'), JSON.stringify({
        stdout: fault === 'model-leak' ? secret : 'synthetic-mcp-token', stderr: '',
      }));
    }
    // A VM retirement/termination result alone must not qualify as handback.
    return { executionId: input.executionId, status: 'interrupted',
      code: 'CODEX_IDLE_TIMEOUT', terminationHash: 'b'.repeat(64) };
  } }, {}, () => job.read(), job);
  const coreRoot = await roleCoreFixture(f.root, 'deliver');
  const agent = new CodexRoleAgent({ stateRoot, work, authFile, coreRoot,
    model: 'configured-model', skills: { deliver: digest(await readFile(
      join(coreRoot, 'skills/deliver/SKILL.md'), 'utf8')) } }, isolator, {
    settlement: f.invocation,
    reclaim: false,
    prepareMain: async (directory, _issue, head) => {
      await mkdir(directory, { mode: 0o700 });
      return { base: head, directory };
    },
  });
  return { ...f, agent, job, stateRoot, work, authFile };
}

test('trusted cleanup plus actual role and MCP retirement settle an interruption',
  async t => {
    const f = await roleFixture(t);
    const interrupted = await f.agent.run('deliver', f.context);
    assert.equal(interrupted.status, 'interrupted');
    const result = await settleHostStage(async () => pending, async () => {
      await f.job.retire([], true);
      await f.fence.release();
    }, quiet, () => f.lifecycle.assertSettled());
    assert.equal(result.retrySettled, true);
    assert.equal(await readFile(join(f.work, 'edit.txt'), 'utf8'), 'Writer edit');
    assert.ok((await readFile(f.authFile, 'utf8')).includes('synthetic-only'));
    const session = (await readdir(f.stateRoot))
      .find(name => name.startsWith('session-'));
    assert.deepEqual(await readdir(join(f.stateRoot, session)), []);
  });

test('unknown backend, unreturned VM workspace and failed role retirement cannot settle',
  async t => {
    for (const fault of ['unknown-backend', 'vm', 'role-retirement']) {
      const f = await roleFixture(t, fault);
      if (fault === 'role-retirement')
        await assert.rejects(f.agent.run('deliver', f.context));
      else await f.agent.run('deliver', f.context);
      const result = await settleHostStage(async () => pending,
        () => assert.fail('Must retain ownership'), quiet,
        () => f.lifecycle.assertSettled());
      assert.equal(result.retrySettled, undefined);
      assert.equal(result.code, 'LOCAL_DELIVER_HAND_BACK_UNPROVEN');
      if (fault !== 'role-retirement') await assert.rejects(f.job.retire([], true),
        { code: 'MCP_JOB_TERMINATION_UNPROVEN' });
    }
  });


test('partial interrupted output cannot bypass model or MCP credential scans',
  async t => {
  for (const fault of ['model-leak', 'mcp-leak']) {
    const f = await roleFixture(t, fault);
    await assert.rejects(f.agent.run('deliver', f.context), {
      code: fault === 'model-leak' ? 'CREDENTIAL_OUTPUT_REJECTED'
        : 'MCP_CREDENTIAL_OUTPUT_REJECTED',
    });
    await assert.rejects(f.lifecycle.assertSettled(),
      { code: 'LOCAL_DELIVER_HAND_BACK_UNPROVEN' });
    if (fault === 'mcp-leak') await assert.rejects(f.job.retire([], true),
      { code: 'MCP_JOB_TERMINATION_UNPROVEN' });
  }
});
