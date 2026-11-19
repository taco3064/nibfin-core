import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile }
  from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { acquireHostFence } from '../src/host-fence.mjs';
import { digest } from '../src/identity.mjs';
import { claimMcpJob } from '../src/mcp-job.mjs';
import { makeBlockerReport } from '../src/blocker-report.mjs';
import { saveBlockerReport } from '../src/blocker-report-store.mjs';

async function pending(f, code) {
  assert.deepEqual(await f.recover(), { status: 'pending', code });
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
  assert.equal((await readdir(f.issueRoot)).includes('recovery.lock'), false);
}

for (const outer of ['deliver', 'shape']) {
  test(`settles legacy ${outer} fence using actual Deliver input; repeat is inert`,
    async t => {
      const f = await deliverRecoveryFixture(t, outer);
      const receipts = await f.store.load();
      const journal = await readFile(join(f.journalRoot, 'receipts.json'), 'utf8');
      assert.equal((await f.recover()).status, 'completed');
      assert.equal(f.observations(), 3);
      await assert.rejects(readFile(f.fencePath), { code: 'ENOENT' });
      const names = (await readdir(f.issueRoot)).filter(n => n.startsWith('settled-'));
      assert.equal(names.length, 1);
      const archive = JSON.parse(await readFile(join(f.issueRoot, names[0]), 'utf8'));
      assert.equal(archive.disposition, 'settled');
      assert.equal(archive.execution.id, f.execution.id);
      assert.equal(archive.fence.bytes, f.fenceBytes);
      assert.equal((await f.recover()).status, 'completed');
      assert.equal(f.observations(), 3);
      assert.equal(await readFile(join(f.journalRoot, 'receipts.json'), 'utf8'), journal);
      assert.deepEqual(await f.store.load(), receipts);
      assert.equal(f.effects, 1);
      const calls = [];
      const result = await continueStages({ store: f.store,
        inspect: async () => {}, execute: async stage => {
          calls.push(stage);
          return { status: 'pending', code: 'ADMISSION_RECHECK', stage };
        } });
      assert.deepEqual(calls, ['deliver']);
      assert.equal(result.code, 'ADMISSION_RECHECK');
      await acquireHostFence(f.issueRoot, { fresh: true });
      assert.equal((await f.recover()).status, 'pending');
      assert.equal(JSON.parse(await readFile(f.fencePath)).binding.fresh, true);
    });
}

const failures = [
  ['wrong job', f => { f.job.id++; }, 'RECOVERY_EXECUTION_MISMATCH'],
  ['wrong attempt', f => { f.job.run_attempt++; }, 'RECOVERY_EXECUTION_MISMATCH'],
  ['nonterminal job', f => { f.job.status = 'in_progress'; },
    'RECOVERY_EXECUTION_MISMATCH'],
  ['nonterminal run', f => { f.run.status = 'in_progress'; },
    'RECOVERY_EXECUTION_MISMATCH'],
  ['wrong Runner', f => { f.job.runner_id++; }, 'RECOVERY_EXECUTION_MISMATCH'],
  ['wrong member', f => { f.data['/user'].id++; }, 'RECOVERY_EXECUTION_MISMATCH'],
  ['wrong repository', f => { f.data['/repos/example/core'].id++; },
    'RECOVERY_EXECUTION_MISMATCH'],
  ['wrong Issue', f => { f.issue.node_id = 'I_other'; }, 'RECOVERY_ISSUE_CHANGED'],
  ['pause', f => { f.issue.labels.push({ name: 'pause' }); }, 'RECOVERY_ISSUE_CHANGED'],
  ['edited requirements', f => { f.issue.body = 'Changed'; }, 'RECOVERY_ISSUE_CHANGED'],
  ['boot changed', f => { f.options.observeBoot = async () => 'different'; },
    'RECOVERY_BOOT_MISMATCH'],
  ['missing native observation', f => { f.context.reader.get = async () => {
    throw new Error('unavailable private diagnostic');
  }; }, 'RECOVERY_OBSERVATION_UNAVAILABLE'],
  ['MCP external host unavailable', async f => {
    f.context.host.mcp = {};
    await claimMcpJob(f.root, f.runner);
  },
    'RECOVERY_MCP_OBSERVATION_UNAVAILABLE'],
  ['container observation unavailable', f => { f.options.containers = async () => {
    throw new Error('private daemon information');
  }; }, 'RECOVERY_OBSERVATION_UNAVAILABLE'],
  ['retained journal lock', async f => {
    await writeFile(join(f.journalRoot, 'execution.lock'), '{}', { mode: 0o600 });
  }, 'WRITER_NOT_PROVEN_TERMINATED'],
  ['unknown external write', async f => {
    const request = { operation: 'deliver', bindingHash: 'd'.repeat(64) };
    assert.equal((await f.journal.run(request, {
      admit: async () => request.bindingHash,
      perform: async () => { throw new Error('unknown effect'); },
      readBack: async () => undefined,
    })).code, 'EXTERNAL_EFFECT_UNKNOWN');
  }, 'EXTERNAL_EFFECT_UNKNOWN'],
  ['live Controller', f => { f.processes.push({ pid: 900001, state: 'S',
    startTicks: '100', parent: 1 }); }, 'RECOVERY_CONTROLLER_UNRESOLVED'],
  ['detached Writer', f => { f.processes.push({ pid: 900002, state: 'S',
    startTicks: '101', parent: 1, command: ['/bin/helper'] }); },
    'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED'],
  ['live VM', f => { f.processes.push({ pid: 900003, state: 'S',
    startTicks: '102', parent: 1, command: ['/opt/firecracker'] }); },
    'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED'],
  ['unreadable processes', f => { f.options.processes = async () => {
    throw Object.assign(new Error('credentials'),
      { code: 'RECOVERY_PROCESS_UNAVAILABLE' });
  }; }, 'RECOVERY_PROCESS_UNAVAILABLE'],
  ['contradictory invocation stage', async f => {
    await writeFile(f.invocationPath,
      JSON.stringify({ plan: { contract: { stage: 'accept' } } }));
  }, 'INVALID_ROLE_EXECUTION'],
  ['mismatched execution context', async f => {
    f.retained.runner.runnerId++;
    await writeFile(f.inputPath, JSON.stringify(f.retained));
  }, 'RECOVERY_EXECUTION_MISMATCH'],
];
for (const [name, change, code] of failures) {
  test(`${name} retains legacy fence and bounded Pending reason`, async t => {
    const f = await deliverRecoveryFixture(t);
    await change(f);
    await pending(f, code);
  });
}

test('private state permissions cannot be bypassed by recovery', async t => {
  const f = await deliverRecoveryFixture(t);
  await chmod(f.fencePath, 0o644);
  await pending(f, 'UNSAFE_RECOVERY_LOCK');
});

test('PID reuse remains ambiguous even with a historical start time', async t => {
  const f = await deliverRecoveryFixture(t);
  const fence = JSON.parse(f.fenceBytes);
  fence.startTicks = '1';
  f.fenceBytes = JSON.stringify(fence);
  await writeFile(f.fencePath, f.fenceBytes);
  f.processes.push({ pid: fence.pid, startTicks: '2', state: 'S', parent: 1 });
  await pending(f, 'RECOVERY_PID_REUSED');
});

for (const identical of [true, false]) {
  const label = identical ? 'identical replacement' : 'changed';
  test(`never retires ${label} fence`, async t => {
    const f = await deliverRecoveryFixture(t);
    const bytes = identical ? f.fenceBytes : JSON.stringify({ replacement: true });
    f.options.afterRecord = async () => {
      await rename(f.fencePath, join(f.issueRoot, 'old-fence'));
      await writeFile(f.fencePath, bytes, { mode: 0o600 });
    };
    assert.equal((await f.recover()).code, 'RECOVERY_LOCK_CHANGED');
    assert.equal(await readFile(f.fencePath, 'utf8'), bytes);
  });
}

test('interruption after durable record revalidates before completing once', async t => {
  const f = await deliverRecoveryFixture(t);
  f.options.afterRecord = async () => { throw new Error('simulated interruption'); };
  await pending(f, 'RECOVERY_OBSERVATION_UNAVAILABLE');
  f.options.afterRecord = async () => {};
  assert.equal((await f.recover()).status, 'completed');
  const names = (await readdir(f.issueRoot)).filter(n => n.startsWith('settled-'));
  assert.equal(names.length, 1);
  assert.equal((await f.recover()).status, 'completed');
});

test('fresh live resources after recording prevent retirement', async t => {
  const f = await deliverRecoveryFixture(t);
  f.options.afterRecord = async () => {
    f.processes.push({ pid: 900001, state: 'S', startTicks: '1', parent: 1 });
  };
  await pending(f, 'RECOVERY_CONTROLLER_UNRESOLVED');
});

test('concurrent recovery is exclusive; unrelated Issue state is preserved', async t => {
  const f = await deliverRecoveryFixture(t);
  const unrelated = join(f.root, 'issue-10-3');
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(join(unrelated, 'stage.lock'), 'unrelated', { mode: 0o600 });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let resume;
  const held = new Promise(resolve => { resume = resolve; });
  f.options.afterRecord = async () => { entered(); await held; };
  const first = f.recover();
  await waiting;
  assert.equal((await f.recover()).code, 'RECOVERY_ALREADY_PENDING');
  resume();
  assert.equal((await first).status, 'completed');
  assert.equal(await readFile(join(unrelated, 'stage.lock'), 'utf8'), 'unrelated');
});

async function unrelatedRelay(f) {
  const directory = join(f.root, 'issue-10-3');
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, 'stage.lock');
  await acquireHostFence(directory, { host: digest(f.context.hostBytes),
    issueId: 'I_other', execution: { jobId: 31 } },
  async () => JSON.parse(f.fenceBytes).bootId);
  const fence = JSON.parse(await readFile(path, 'utf8'));
  // The recovery process is excluded from the census. Synthetic unrelated
  // Controllers must not accidentally reuse its real PID or the target owner.
  const pid = Math.max(process.pid, JSON.parse(f.fenceBytes).pid,
    ...f.processes.map(item => item.pid)) + 1;
  Object.assign(fence, { pid, startTicks: '1' });
  await writeFile(path, JSON.stringify(fence));
  f.processes.push({ pid, state: 'S', startTicks: '1', parent: 1,
    command: ['node', '/opt/nibfin/core/bin/nibfin-controller.mjs'] },
  { pid: pid + 1, state: 'S', startTicks: '2', parent: pid, command: ['helper'] });
  return { path, fence };
}

test('actual relay and descendants use private unrelated-Issue attribution', async t => {
  const f = await deliverRecoveryFixture(t);
  const { path } = await unrelatedRelay(f);
  const bytes = await readFile(path, 'utf8');
  assert.equal((await f.recover()).status, 'completed');
  assert.equal(await readFile(path, 'utf8'), bytes);
});

for (const mismatch of ['missing', 'legacy', 'pid', 'boot', 'host', 'issue',
  'detached', 'entry', 'permissions', 'replacement']) {
  test(`unrelated relay attribution fails closed: ${mismatch}`, async t => {
    const f = await deliverRecoveryFixture(t);
    const { path, fence } = await unrelatedRelay(f);
    if (mismatch === 'legacy') delete fence.startTicks;
    if (mismatch === 'pid') fence.startTicks = '99';
    if (mismatch === 'boot') fence.bootId = 'other-boot';
    if (mismatch === 'host') fence.binding.host = digest('other-host');
    if (mismatch === 'issue') fence.binding.issueId = f.subject.id;
    if (mismatch === 'detached') f.processes[1].parent = 1;
    if (mismatch === 'entry')
      f.processes[0].command[1] = '/untrusted/bin/nibfin-controller.mjs';
    await writeFile(path, JSON.stringify(fence));
    if (mismatch === 'missing') await unlink(path);
    if (mismatch === 'permissions') await chmod(path, 0o644);
    if (mismatch === 'replacement') f.options.afterRecord = async () => {
      await unlink(path);
      // A new Controller cannot inherit the previous process identity.
      fence.startTicks = '99';
      await writeFile(path, JSON.stringify(fence), { mode: 0o600 });
    };
    await pending(f, mismatch === 'permissions' ? 'UNSAFE_RECOVERY_LOCK' :
      'RECOVERY_RESOURCE_OWNERSHIP_UNRESOLVED');
  });
}

test('public CLI refuses proof arguments and invalid Issue numbers', () => {
  for (const args of [['recover-deliver-fence', '2', 'proof'],
    ['recover-deliver-fence', '../2']]) {
    const result = spawnSync(process.execPath, ['bin/nibfin-core.mjs', ...args],
      { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INVALID_COMMAND|INVALID_RECOVERY_REQUEST/);
  }
});

test('configured but unentered MCP needs no external-host termination inference',
  async t => {
    const f = await deliverRecoveryFixture(t);
    f.context.host.mcp = {};
    assert.equal((await f.recover()).status, 'completed');
  });

test('continuation can use a trusted native Deliver report before Agent entry',
  async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    await unlink(f.inputPath);
    await unlink(f.invocationPath);
    // Remove the empty execution input: this attempt failed before Agent entry.
    const { rm } = await import('node:fs/promises');
    await rm(join(f.issueRoot, 'agent'), { recursive: true });
    const report = makeBlockerReport({ approval: f.approval, runner: f.runner,
      execution: f.execution }, 'deliver', { producer: 'core-native',
      code: 'LIVE_OBSERVATION_UNAVAILABLE', agentStarted: false });
    await saveBlockerReport(join(f.issueRoot, 'receipts'), report);
    assert.equal((await f.recover()).status, 'completed');
  });

test('continuation without retained context covers the entire native attempt',
  async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    const { rm } = await import('node:fs/promises');
    await rm(join(f.issueRoot, 'agent'), { recursive: true });
    assert.equal((await f.recover()).status, 'completed');
    const names = (await readdir(f.issueRoot)).filter(n => n.startsWith('settled-'));
    const record = JSON.parse(await readFile(join(f.issueRoot, names[0]), 'utf8'));
    assert.equal(record.execution.id, JSON.parse(f.fenceBytes).binding.execution.id);
    assert.equal(record.coverage.kind, 'native-continuation');
    assert.equal(record.coverage.iterations, 'all');
    assert.deepEqual(record.coverage.retained, []);
  });

test('native and journal observations are repeated after recording', async t => {
  for (const changed of ['native', 'journal', 'containers', 'authority']) {
    const f = await deliverRecoveryFixture(t);
    f.options.afterRecord = async () => {
      if (changed === 'native') f.job.status = 'in_progress';
      if (changed === 'authority') f.approval.record.roles.writer++;
      if (changed === 'journal')
        await writeFile(join(f.journalRoot, 'execution.lock'), '{}', { mode: 0o600 });
    };
    // Observer functions are captured at admission; use a mutable observer for
    // the container case so the repeated observation sees the changed state.
    let resourcesLive = false;
    if (changed === 'containers') {
      f.options.containers = async () => {
        if (resourcesLive) throw Object.assign(new Error('owned resource'),
          { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
        return digest('empty');
      };
      f.options.afterRecord = async () => { resourcesLive = true; };
    }
    const code = { native: 'RECOVERY_EXECUTION_MISMATCH',
      journal: 'WRITER_NOT_PROVEN_TERMINATED',
      containers: 'PREVIOUS_HOST_PROCESS_UNRESOLVED',
      authority: 'RECOVERY_AUTHORITY_CHANGED' }[changed];
    await pending(f, code);
  }
});

test('published PR and completed receipts/effects survive recovery and continuation',
  async t => {
    const f = await deliverRecoveryFixture(t);
    const prior = { ...f.execution, runId: 19, jobId: 29 };
    const artifacts = { ...f.artifacts, candidateHash: await f.store.put({
      tree: 'a'.repeat(40), base: 'b'.repeat(40) }) };
    const pr = { ...artifacts, prId: 'PR_existing', prNumber: 9,
      head: 'c'.repeat(40) };
    for (const [stage, outcome] of [['deliver', 'ready'],
      ['pre-accept-hooks', 'passed'], ['accept', 'accepted'],
      ['post-accept-hooks', 'passed'], ['commit-pr', 'published']]) {
      await f.store.append({ schemaVersion: 1, stage, execution: prior,
        binding: f.binding, outcome, artifacts: stage === 'commit-pr' ? pr : artifacts });
    }
    const before = await f.store.load();
    assert.equal((await f.recover()).status, 'completed');
    const calls = [];
    await continueStages({ store: f.store, inspect: async () => {},
      execute: async stage => {
        calls.push(stage);
        return { status: 'pending', code: 'CURRENT_ADMISSION_REQUIRED' };
      } });
    assert.deepEqual(calls, ['review-pr']);
    assert.deepEqual(await f.store.load(), before);
    assert.equal(f.effects, 1);
  });

test('legacy host-root fence is retired only for its exact adopted Issue', async t => {
  const f = await deliverRecoveryFixture(t);
  const legacy = join(f.root, 'stage.lock');
  await rename(f.fencePath, legacy);
  assert.equal((await f.recover()).status, 'completed');
  await assert.rejects(readFile(legacy), { code: 'ENOENT' });
});

test('an interrupted exclusive guard is never stolen using the recovery record',
  async t => {
    const f = await deliverRecoveryFixture(t);
    f.options.afterRecord = async () => { throw new Error('interruption'); };
    await pending(f, 'RECOVERY_OBSERVATION_UNAVAILABLE');
    await writeFile(join(f.issueRoot, 'recovery.lock'), '{"pid":900009}',
      { mode: 0o600 });
    assert.equal((await f.recover()).code, 'RECOVERY_ALREADY_PENDING');
    assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
  });

test('a retained MCP claim cannot be hidden by changing current target settings',
  async t => {
    const f = await deliverRecoveryFixture(t);
    await claimMcpJob(f.root, f.runner);
    await pending(f, 'RECOVERY_MCP_OBSERVATION_UNAVAILABLE');
  });

test('unrelated native API metadata changes do not block settlement', async t => {
  const f = await deliverRecoveryFixture(t);
  f.options.afterRecord = async () => {
    f.data['/repos/example/core'].open_issues_count = 20;
    f.job.html_url = 'https://github.com/irrelevant';
    f.run.updated_at = '2026-11-18T12:00:00Z';
  };
  assert.equal((await f.recover()).status, 'completed');
});
