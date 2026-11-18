import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, symlink, unlink, writeFile }
  from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { hostExecution } from '../src/host-launcher.mjs';
import { stages } from '../src/stages.mjs';
import { makeBlockerReport } from '../src/blocker-report.mjs';
import { saveBlockerReport } from '../src/blocker-report-store.mjs';

async function layout(f, kind) {
  if (kind === 'absent')
    await rm(join(f.issueRoot, 'agent'), { recursive: true });
  else await unlink(f.invocationPath);
}

async function archive(f) {
  const names = (await readdir(f.issueRoot)).filter(n => n.startsWith('settled-'));
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(f.issueRoot, names[0]), 'utf8'));
}

async function retains(f, code) {
  assert.deepEqual(await f.recover(), { status: 'pending', code });
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
}

for (const kind of ['absent', 'incomplete']) {
  test(`${kind} input settles only through full native continuation proof`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    await layout(f, kind);
    const receipts = await f.store.load();
    const journal = await readFile(join(f.journalRoot, 'receipts.json'), 'utf8');
    assert.equal((await f.recover()).status, 'completed');
    const record = await archive(f);
    assert.equal(record.execution.id, JSON.parse(f.fenceBytes).binding.execution.id);
    assert.equal(record.coverage.kind, 'native-continuation');
    assert.equal(record.coverage.iterations, 'all');
    assert.deepEqual(record.coverage.stages, Object.keys(stages));
    if (kind === 'incomplete') {
      assert.equal(record.coverage.retained[0].classification, 'incomplete-input');
      assert.equal(record.coverage.retained[0].stage, undefined);
    }
    assert.deepEqual(await f.store.load(), receipts);
    assert.equal(await readFile(join(f.journalRoot, 'receipts.json'), 'utf8'), journal);
    assert.equal((await f.recover()).status, 'completed');
  });

  for (const resource of ['controller', 'unattributable', 'container', 'journal',
    'write', 'mcp']) {
    test(`${kind} input cannot hide ${resource}`, async t => {
      const f = await deliverRecoveryFixture(t, 'shape');
      await layout(f, kind);
      let code;
      if (resource === 'controller' || resource === 'unattributable') {
        f.processes.push({ pid: resource === 'controller' ? 900001 : 900002,
          state: 'S', startTicks: '1', parent: 1, command: ['helper'] });
        code = resource === 'controller' ? 'RECOVERY_CONTROLLER_UNRESOLVED' :
          'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED';
      }
      if (resource === 'container') {
        f.options.containers = async () => {
          throw Object.assign(new Error('active resource'),
            { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
        };
        code = 'PREVIOUS_HOST_PROCESS_UNRESOLVED';
      }
      if (resource === 'journal') {
        await writeFile(join(f.journalRoot, 'execution.lock'), '{}', { mode: 0o600 });
        code = 'WRITER_NOT_PROVEN_TERMINATED';
      }
      if (resource === 'write') {
        await f.journal.run({ operation: 'merge', bindingHash: 'e'.repeat(64) }, {
          admit: async () => 'e'.repeat(64),
          perform: async () => { throw new Error('unknown'); },
          readBack: async () => undefined,
        });
        code = 'EXTERNAL_EFFECT_UNKNOWN';
      }
      if (resource === 'mcp') {
        const { claimMcpJob } = await import('../src/mcp-job.mjs');
        await claimMcpJob(f.root, f.runner);
        code = 'RECOVERY_MCP_OBSERVATION_UNAVAILABLE';
      }
      await retains(f, code);
    });
  }
}

for (const stage of ['accept', 'review-pr', 'commit-pr', 'merge']) {
  test(`same-native ${stage} evidence and correction iterations are covered`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    await unlink(f.invocationPath);
    for (const iteration of [0, 1, 3]) {
      const execution = hostExecution(f.runner, stage, iteration);
      const input = join(f.issueRoot, 'agent', `execution-${execution.id}`, 'input');
      await mkdir(input, { recursive: true, mode: 0o700 });
      await writeFile(join(input, 'context.json'), JSON.stringify({ ...f.retained,
        execution }), { mode: 0o400 });
      await writeFile(join(input, 'invocation.json'),
        JSON.stringify({ plan: { contract: { stage } } }), { mode: 0o400 });
    }
    const report = makeBlockerReport({ approval: f.approval, runner: f.runner,
      execution: hostExecution(f.runner, stage, 3) }, stage,
    { producer: 'core-native', code: 'OBSERVATION_UNAVAILABLE' });
    await saveBlockerReport(join(f.issueRoot, 'receipts'), report);
    const before = await f.store.load();
    assert.equal((await f.recover()).status, 'completed');
    const record = await archive(f);
    assert.equal(record.coverage.retained.filter(entry =>
      entry.classification === 'complete-stage' && entry.stage === stage).length, 3);
    assert.deepEqual(await f.store.load(), before);
  });
}

for (const change of ['context', 'invocation', 'execution', 'report', 'progress',
  'journal', 'membership-restored', 'remove-context', 'remove-invocation']) {
  test(`changed ${change} after recording preserves the fence`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    if (['context', 'invocation', 'execution', 'report'].includes(change))
      await unlink(f.invocationPath);
    f.options.afterRecord = async () => {
      if (change === 'context')
        await writeFile(f.inputPath, JSON.stringify({ ...f.retained, extra: true }));
      if (change === 'invocation') await writeFile(f.invocationPath,
        JSON.stringify({ plan: { contract: { stage: 'deliver' } } }), { mode: 0o400 });
      if (change === 'membership-restored') {
        const path = join(dirname(f.inputPath), 'transient.json');
        await writeFile(path, '{}', { mode: 0o400 });
        await unlink(path);
      }
      if (change === 'remove-context') await unlink(f.inputPath);
      if (change === 'remove-invocation') await unlink(f.invocationPath);
      if (change === 'execution') await mkdir(join(f.issueRoot, 'agent',
        `execution-${hostExecution(f.runner, 'deliver', 1).id}`), { mode: 0o700 });
      if (change === 'report') {
        const report = makeBlockerReport({ approval: f.approval, runner: f.runner,
          execution: f.execution }, 'deliver', { producer: 'core-native' });
        await saveBlockerReport(join(f.issueRoot, 'receipts'), report);
      }
      if (change === 'progress') await f.store.append({ schemaVersion: 1,
        stage: 'deliver', binding: f.binding, execution: f.execution,
        outcome: 'ready', artifacts: f.artifacts });
      if (change === 'journal') await f.journal.run({ operation: 'close',
        bindingHash: 'f'.repeat(64) }, { admit: async () => 'f'.repeat(64),
        perform: async () => {}, readBack: async () => 'f'.repeat(64) });
    };
    await retains(f, change === 'progress' ? 'RECOVERY_PROGRESS_CHANGED' :
      'RECOVERY_EVIDENCE_CHANGED');
  });
}

for (const malformed of ['json', 'null', 'role', 'issue', 'runner-native',
  'actor', 'identity', 'unsafe', 'symlink', 'orphan']) {
  test(`malformed or contradictory retained ${malformed} fails closed`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    let code = 'RECOVERY_EXECUTION_MISMATCH';
    if (malformed === 'json' || malformed === 'null') {
      await writeFile(f.inputPath, malformed === 'json' ? '{' : 'null');
      code = 'RECOVERY_EVIDENCE_INVALID';
    }
    if (malformed === 'actor') {
      f.retained.execution.actorId++;
      f.retained.runner.memberId++;
      await writeFile(f.inputPath, JSON.stringify(f.retained));
    }
    if (malformed === 'identity') {
      f.retained.execution.sessionId = hostExecution(f.runner, 'deliver', 1).sessionId;
      await writeFile(f.inputPath, JSON.stringify(f.retained));
    }
    if (malformed === 'role') {
      f.retained.execution.role = 'acceptor';
      code = 'INVALID_ROLE_EXECUTION';
    }
    if (malformed === 'issue') f.retained.approval.record.issue.id = 'I_other';
    if (malformed === 'runner-native') f.retained.runner.jobId++;
    if (['role', 'issue', 'runner-native'].includes(malformed))
      await writeFile(f.inputPath, JSON.stringify(f.retained));
    if (malformed === 'unsafe') {
      await chmod(f.inputPath, 0o666);
      code = 'UNTRUSTED_EVIDENCE';
    }
    if (malformed === 'symlink') {
      await unlink(f.invocationPath);
      await symlink(join(dirname(f.invocationPath), 'missing'), f.invocationPath);
      code = 'UNTRUSTED_EVIDENCE';
    }
    if (malformed === 'orphan') {
      await unlink(f.inputPath);
      code = 'RECOVERY_CONTEXT_UNAVAILABLE';
    }
    await retains(f, code);
  });
}


test('same-native later receipts and existing PR survive unknown-stage recovery',
  async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    await layout(f, 'absent');
    const artifacts = { ...f.artifacts, candidateHash: await f.store.put({
      tree: 'a'.repeat(40), base: 'b'.repeat(40) }) };
    const pr = { ...artifacts, prId: 'PR_existing', prNumber: 9,
      head: 'c'.repeat(40) };
    for (const [stage, outcome] of [['deliver', 'ready'],
      ['pre-accept-hooks', 'passed'], ['accept', 'accepted'],
      ['post-accept-hooks', 'passed'], ['commit-pr', 'published']]) {
      await f.store.append({ schemaVersion: 1, stage,
        execution: hostExecution(f.runner, stage, 1), binding: f.binding,
        outcome, artifacts: stage === 'commit-pr' ? pr : artifacts });
    }
    const before = await f.store.load();
    assert.equal((await f.recover()).status, 'completed');
    assert.deepEqual(await f.store.load(), before);
    assert.equal((await archive(f)).execution.role, 'author');
  });

test('a retained native continuation report does not invent a specific stage',
  async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    await layout(f, 'absent');
    const report = makeBlockerReport({ approval: f.approval, runner: f.runner,
      execution: hostExecution(f.runner, 'shape') }, 'continue',
    { producer: 'core-native', agentStarted: false, code: 'OBSERVATION_UNAVAILABLE' });
    await saveBlockerReport(join(f.issueRoot, 'receipts'), report);
    assert.equal((await f.recover()).status, 'completed');
    const record = await archive(f);
    assert.equal(record.execution.role, 'author');
    assert.equal(record.coverage.retained[0].stage, 'continue');
    assert.equal(record.coverage.iterations, 'all');
  });


test('an empty retained input directory supplies no stage identity', async t => {
  const f = await deliverRecoveryFixture(t, 'shape');
  await unlink(f.inputPath);
  await unlink(f.invocationPath);
  assert.equal((await f.recover()).status, 'completed');
  const record = await archive(f);
  assert.equal(record.coverage.retained[0].classification, 'absent-context');
  assert.equal(record.coverage.retained[0].stage, undefined);
  assert.equal(record.execution.role, 'author');
});

test('new Agent evidence after recording invalidates observed root absence', async t => {
  const f = await deliverRecoveryFixture(t, 'shape');
  await layout(f, 'absent');
  f.options.afterRecord = async () => {
    await mkdir(dirname(f.inputPath), { recursive: true, mode: 0o700 });
    await writeFile(f.inputPath, JSON.stringify(f.retained), { mode: 0o400 });
  };
  await retains(f, 'RECOVERY_EVIDENCE_CHANGED');
});
