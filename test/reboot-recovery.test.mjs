import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rebootFixture, oldBoot } from './reboot-recovery-fixture.mjs';
import { digest } from '../src/identity.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { idleContainers } from '../src/host-containers.mjs';

async function assertPending(recovery, reason) {
  const result = await recovery;
  assert.equal(result.status, 'pending');
  if (reason) assert.match(result.code, reason);
}


for (const stage of ['commit-pr', 'review-pr']) {
  test(`${stage}: different boot reconciles retained lock despite reused PID`,
    async t => {
    const f = await rebootFixture(t, stage);
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
    const result = await f.recover();
    assert.equal(result.status, 'completed');
    assert.equal(result.decisionId, f.decision);
    assert.equal(f.writes(), 1);
    assert.ok(f.observations() >= 4);
    await f.journal.assertIdle();
    await assert.rejects(readFile(f.fencePath), { code: 'ENOENT' });
    const archived = join(f.root, `reconciled-${stage}-20-1.json`);
    assert.equal(await readFile(archived, 'utf8'), f.fenceBytes);
    const receipt = await f.store.get(result.receiptHash);
    assert.equal(receipt.executionId ?? receipt.execution.id, f.execution.id);
    if (stage === 'review-pr') assert.equal(receipt.previous, digest(f.previous));
    else assert.equal(receipt.artifacts.candidateHash, f.artifacts.candidateHash);
    // Recreate the crash window after settlement but before fence retirement.
    await writeFile(f.fencePath, f.fenceBytes, { mode: 0o600 });
    await writeFile(f.lockPath, JSON.stringify({ pid: process.pid,
      decision: f.decision }), { mode: 0o600 });
    assert.deepEqual(await f.recover(), result);
    assert.equal(f.writes(), 1);
  });
}

test('same boot, legacy and malformed boot identity retain all recovery evidence',
  async t => {
    for (const bootId of [oldBoot, undefined, 'not-a-boot-id']) {
      const f = await rebootFixture(t);
      if (bootId === oldBoot) {
        f.options.observeBoot = async () => oldBoot;
        await f.changeFence(fence => { fence.pid = 2147483647; });
      }
      else await f.changeFence(fence => { fence.bootId = bootId; });
      const before = await readFile(f.fencePath, 'utf8');
      await assertPending(f.recover(), /WRITER_NOT_PROVEN_TERMINATED/);
      assert.equal(await readFile(f.fencePath, 'utf8'), before);
      await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
      assert.equal(f.writes(), 1);
    }
  });

test('unavailable boot, host, Issue and exact Job observations cannot settle',
  async t => {
  for (const change of [
    f => { f.options.observeBoot = async () => { throw new Error('kernel read'); }; },
    f => f.changeFence(x => { x.binding.host = 'foreign'; }),
    f => f.changeFence(x => { x.binding.issueId = 'I_other'; }),
    f => f.changeFence(x => { x.binding.execution.jobId = 31; }),
    f => { f.job.id = 31; },
    f => { f.job.run_id = 21; },
    f => { f.run.run_attempt = 2; },
    f => { f.context.reader.list = async () => { throw new Error('offline unknown'); }; },
    f => { f.context.reader.list = async () => []; },
  ]) {
    const f = await rebootFixture(t);
    await change(f);
    await assertPending(f.recover());
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
    assert.equal(f.writes(), 1);
    assert.ok(await readFile(f.fencePath, 'utf8'));
  }
});

test('containers and operation-specific read-back remain independent refusal gates',
  async t => {
    for (const stage of ['commit-pr', 'review-pr']) {
      for (const change of [
        f => { f.options.containers = async () => { throw new Error('container'); }; },
        f => {
          const c = { docker: '/fixed/docker', socket: '/fixed/socket',
            network: 'isolated', gatewayId: 'gateway' };
          f.options.containers = () => idleContainers({ agent: c, hooks: c },
            f.context.adopted.isolation.issue, async (_exe, args) => ({
              stdout: Buffer.from(args.includes('network=isolated')
                ? 'gateway\n' : 'surviving-container\n'),
            }));
        },
        f => { f.pr.node_id = 'PR_other'; },
        f => { f.pr.head.sha = 'f'.repeat(40); },
        f => { f.commit.tree.sha = 'f'.repeat(40); },
        f => { f.commit.parents = []; },
        f => { f.issue.body += 'changed'; },
        f => { f.context.reader.get = async () => { throw new Error('provider'); }; },
      ]) {
        const f = await rebootFixture(t, stage);
        change(f);
        await assertPending(f.recover());
        assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
        await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
        assert.equal(f.writes(), 1);
      }
    }
    const f = await rebootFixture(t, 'review-pr');
    await f.store.append({ ...f.previous, outcome: 'changes_required' });
    await assertPending(f.recover(), /RECOVERY_REVIEW_NOT_REPEATED/);
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
  });

test('unsafe, malformed, foreign-PID and wrong-decision locks remain unresolved',
  async t => {
  for (const change of [
    async f => writeFile(f.lockPath, '{bad'),
    async f => chmod(f.lockPath, 0o666),
    async f => writeFile(f.lockPath, JSON.stringify({ pid: process.pid,
      decision: 'f'.repeat(64) })),
    async f => writeFile(f.lockPath, JSON.stringify({ pid: process.pid + 1,
      decision: f.decision })),
    async f => {
      await rename(f.lockPath, f.lockPath + '.retained');
      await symlink(f.lockPath + '.retained', f.lockPath);
    },
  ]) {
    const f = await rebootFixture(t);
    await change(f);
    await assertPending(f.recover());
    assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
    assert.equal(f.writes(), 1);
  }
});

test('changed fence, lock or journal during reconciliation is detected', async t => {
  for (const change of [
    f => f.changeFence(x => { x.binding.execution.jobId++; }),
    async f => {
      const bytes = await readFile(f.lockPath);
      await unlink(f.lockPath);
      await writeFile(f.lockPath, bytes, { mode: 0o600 });
    },
    async f => {
      const path = join(f.journalRoot, 'receipts.json');
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.payload.completed.push('f'.repeat(64));
      record.hash = digest(record.payload);
      await writeFile(path, JSON.stringify(record));
    },
  ]) {
    const f = await rebootFixture(t);
    let calls = 0;
    const original = f.context.reader.issue;
    f.context.reader.issue = async (...args) => {
      if (++calls === 2) await change(f);
      return original(...args);
    };
    await assertPending(f.recover(), /CHANGED/);
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
    assert.equal(f.writes(), 1);
  }
});

test('competing recovery cannot enter read-back or admit another Writer', async t => {
  const f = await rebootFixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  f.options.containers = async () => { entered(); await finish; };
  const first = f.recover();
  await started;
  assert.deepEqual(await f.recover(),
    { status: 'pending', code: 'RECOVERY_ALREADY_PENDING' });
  await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(f.writes(), 1);
});

test('failed reconciliation preserves intent and can be retried without writes',
  async t => {
  const f = await rebootFixture(t);
  const get = f.context.reader.get;
  let reads = 0;
  f.context.reader.get = async path => {
    if (path.endsWith('/pulls/9') && ++reads === 2) throw new Error('interrupted read');
    return get(path);
  };
  await assertPending(f.recover(), /RECOVERY_OBSERVATION_UNAVAILABLE/);
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
  await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
  f.context.reader.get = get;
  assert.equal((await f.recover()).status, 'completed');
  assert.equal(f.writes(), 1);
});

test('reconciled receipts continue in order through ordinary stage admission',
  async t => {
  const f = await rebootFixture(t);
  await f.recover();
  const calls = [];
  const result = await continueStages({ store: f.store,
    inspect: () => f.journal.assertIdle(),
    execute: async stage => {
      calls.push(stage);
      return { status: 'denied', code: 'CURRENT_ADMISSION_REQUIRED' };
    },
  });
  assert.deepEqual(calls, ['review-pr']);
  assert.equal(result.code, 'CURRENT_ADMISSION_REQUIRED');
  assert.equal(f.writes(), 1);
});

test('a process killed during retained-lock reconciliation preserves explainable Pending',
  { timeout: 10000 }, async t => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const f = await rebootFixture(t);
    const module = new URL('../src/operation-journal.mjs', import.meta.url).href;
    const boot = new URL('../src/linux-boot.mjs', import.meta.url).href;
    const code = `
      import { OperationJournal } from ${JSON.stringify(module)};
      import { proveDifferentBoot } from ${JSON.stringify(boot)};
      const journal = new OperationJournal(${JSON.stringify(join(f.issueRoot,
        'receipts'))}, { id: 'I_target', repositoryId: 10 });
      await journal.recoverCommitPr(${JSON.stringify(f.decision)}, async () => {
        process.stdout.write('reconciling');
        await new Promise(() => { setInterval(() => {}, 1000); });
      }, { pid: ${process.pid}, prove: () => proveDifferentBoot(
        '11111111-1111-4111-8111-111111111111',
        async () => '22222222-2222-4222-8222-222222222222') });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const started = await Promise.race([
      once(child.stdout, 'data').then(([bytes]) => bytes.toString()),
      exited.then(() => { throw new Error('Premature exit: ' + stderr); }),
    ]);
    assert.equal(started, 'reconciling');
    child.kill('SIGKILL');
    await exited;
    assert.deepEqual(await f.recover(),
      { status: 'pending', code: 'RECOVERY_ALREADY_PENDING' });
    assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
    assert.ok(await readFile(f.lockPath, 'utf8'));
    await assert.rejects(f.journal.assertIdle(), /WRITER_NOT_PROVEN_TERMINATED/);
    assert.equal(f.writes(), 1);
  });

test('ordered continuation reuses reconciled receipts and finishes remaining stages',
  async t => {
    const { stageSuccess } = await import('../src/stage-runtime.mjs');
    const f = await rebootFixture(t);
    await f.recover();
    const calls = [];
    const result = await continueStages({ store: f.store,
      inspect: () => f.journal.assertIdle(),
      execute: async stage => {
        calls.push(stage);
        const receipt = { schemaVersion: 1, stage, binding: f.binding,
          execution: f.execution,
          artifacts: (await f.store.load())['commit-pr'].artifacts,
          outcome: stageSuccess[stage], findings: [], references: ['fixture:stage'] };
        const receiptHash = await f.store.append(receipt);
        return { stage, status: 'completed', receiptHash };
      },
    });
    assert.deepEqual(calls, ['review-pr', 'merge', 'close']);
    assert.equal(result.stage, 'close');
    assert.equal(f.writes(), 1);
  });

test('after reconciliation live native admission rejects lost eligibility', async t => {
  const { nativeFixture } = await import('./native-observer-fixture.mjs');
  const { nativeStageExecutor } = await import('../src/native-stage.mjs');
  const { nativeObserver } = await import('../src/native-observer.mjs');
  for (const [change, expected] of [
    [n => { n.data['/collaborators/reviewer/permission'].permission = 'read'; },
      'MEMBER_PERMISSION_REVOKED'],
    [n => { n.issue.assignees = []; }, 'ASSIGNEE_RUNNER_BINDING_CHANGED'],
    [n => { n.data['/issues/2/dependencies/blocked_by'] = [{ node_id: 'I_unknown' }]; },
      'Native Blocked by differs'],
    [n => { n.authority.pr.merged = false; }, 'APPROVAL_PR_CHANGED_OR_BLOCKED'],
    [n => { n.adapters.inspectCaller = async () => { throw new Error('unknown'); }; },
      'unknown'],
  ]) {
    const f = await rebootFixture(t);
    await f.recover();
    const n = await nativeFixture(t);
    // Verify the current native fixture is eligible before changing its live reads.
    assert.equal((await n.observe('shape')).dependencies.ready, true);
    change(n);
    await assert.rejects(nativeObserver(n.adapters)('review-pr'),
      error => error.message.includes(expected));
    let agents = 0;
    const executor = nativeStageExecutor({ ...n.adapters,
      token: 'synthetic-token', agent: { run: async () => { agents++; } },
      workspace: { push: async () => assert.fail('unexpected push') },
      sandbox: { execute: async () => assert.fail('unexpected hook') } });
    const calls = [];
    const result = await continueStages({ store: f.store,
      inspect: () => f.journal.assertIdle(), execute: stage => {
        calls.push(stage);
        return executor.run({ schemaVersion: 1, stage });
      },
    });
    assert.deepEqual(calls, ['review-pr']);
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'LIVE_OBSERVATION_UNAVAILABLE');
    assert.equal(agents, 0);
    assert.equal(f.writes(), 1);
  }
});

test('an incomplete native dependency after recovery starts no next Writer', async t => {
  const { approvalRecord } = await import('./approval-fixture.mjs');
  const { nativeFixture } = await import('./native-observer-fixture.mjs');
  const { nativeObserver } = await import('../src/native-observer.mjs');
  const { nativeStageExecutor } = await import('../src/native-stage.mjs');
  const f = await rebootFixture(t);
  await f.recover();
  const record = approvalRecord();
  const dependency = { ...record.issue, id: 'I_dependency', number: 4 };
  record.prerequisites = [dependency];
  const n = await nativeFixture(t, record);
  const remote = { node_id: dependency.id, number: dependency.number,
    url: 'https://api.github.com/repos/example/core/issues/4', state: 'closed',
    labels: ['scope', 'shaped', 'delivered'].map(name => ({ name })) };
  n.data['/issues/2/dependencies/blocked_by'] = [remote];
  const readIssue = n.adapters.reader.issue;
  n.adapters.reader.issue = async subject => subject.id === dependency.id
    ? structuredClone(remote) : readIssue(subject);
  assert.equal((await nativeObserver(n.adapters)('shape')).dependencies.ready, true);
  remote.state = 'open';
  await assert.rejects(nativeObserver(n.adapters)('review-pr'),
    /PREREQUISITES_NOT_READY/);
  let writers = 0;
  const executor = nativeStageExecutor({ ...n.adapters, token: 'synthetic-token',
    agent: { run: async () => { writers++; } },
    workspace: { push: async () => assert.fail('unexpected push') },
    sandbox: { execute: async () => assert.fail('unexpected hook') } });
  const stages = [];
  const result = await continueStages({ store: f.store,
    inspect: () => f.journal.assertIdle(), execute: stage => {
      stages.push(stage);
      return executor.run({ schemaVersion: 1, stage });
    },
  });
  assert.deepEqual(stages, ['review-pr']);
  assert.equal(result.status, 'denied');
  assert.equal(writers, 0);
  assert.equal(f.writes(), 1);
});
