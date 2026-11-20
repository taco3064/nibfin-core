import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitContinuationFence, continuationEligibility, recoverContinuationFence }
  from '../src/continuation-admission.mjs';
import { observeRecoveryInvocation } from '../src/recovery-invocation.mjs';
import { acquireHostFence } from '../src/host-fence.mjs';
import { selectRecoverySlot } from '../src/recovery-slot.mjs';
import { recoverAdoptedDeliverFence } from '../src/recover-deliver-fence.mjs';
import { hostExecution } from '../src/host-execution.mjs';
import { readProtectedApproval } from '../src/github-approval.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { deliverRecoveryFixture, boot } from './deliver-recovery-fixture.mjs';

function admission(f, authorize = async () => {}) {
  const execution = hostExecution({ ...f.runner, runId: 21, jobId: 31 }, 'shape');
  f.processes.push({ pid: process.pid, parent: 1, startTicks: '13', state: 'S',
    command: [process.execPath, '/opt/nibfin/core/bin/nibfin-controller.mjs'] });
  return {
    authorize,
    acquire: () => acquireHostFence(f.issueRoot,
      { issueId: f.subject.id, execution }, async () => boot),
    recover: () => recoverContinuationFence(f.context, f.runner, {
      recoveryOptions: f.options,
      loadSlot: () => assert.fail('slot'),
      observeInvocation: (installation, number) =>
        observeRecoveryInvocation(installation, number, {
          census: async () => structuredClone(f.processes),
        }),
    }),
  };
}

test('eligible continuation settles history and exclusively acquires its own fence',
  async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    const receipts = await f.store.load();
    let checks = 0;
    const result = await admitContinuationFence(admission(f, async () => checks++));
    assert.equal(checks, 2);
    assert.ok(result.fence);
    const current = JSON.parse(await readFile(f.fencePath));
    assert.equal(current.binding.execution.jobId, 31);
    assert.deepEqual(await f.store.load(), receipts);
    assert.equal(f.effects, 1);
    await result.fence.release();
  });

test('failed preflight cannot settle or acquire', async t => {
  const f = await deliverRecoveryFixture(t);
  const input = admission(f, async () => {
    throw Object.assign(new Error('ISSUE_PAUSED'), { code: 'ISSUE_PAUSED' });
  });
  input.recover = () => assert.fail('recovery entered');
  await assert.rejects(admitContinuationFence(input), { code: 'ISSUE_PAUSED' });
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
});

test('eligibility revocation after settlement prevents new admission', async t => {
  const f = await deliverRecoveryFixture(t);
  let calls = 0;
  await assert.rejects(admitContinuationFence(admission(f, async () => {
    if (++calls === 2) throw Object.assign(new Error('changed'), { code: 'REVOKED' });
  })), { code: 'REVOKED' });
  await assert.rejects(readFile(f.fencePath), { code: 'ENOENT' });
  assert.deepEqual(await f.recover(), await f.recover());
});

test('unresolved live history stays pending without a new fence', async t => {
  const f = await deliverRecoveryFixture(t);
  f.processes.push({ pid: 900001, state: 'S', startTicks: '10' });
  const result = await admitContinuationFence(admission(f));
  assert.equal(result.pending.code, 'RECOVERY_CONTROLLER_UNRESOLVED');
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
});

test('replacement between settlement and exclusive acquisition wins', async t => {
  const f = await deliverRecoveryFixture(t);
  let checks = 0;
  const bytes = JSON.stringify({ replacement: true });
  await assert.rejects(admitContinuationFence(admission(f, async () => {
    if (++checks === 2) await writeFile(f.fencePath, bytes, { mode: 0o600 });
  })), { code: 'HOST_EXECUTION_UNRESOLVED' });
  assert.equal(await readFile(f.fencePath, 'utf8'), bytes);
});

test('byte-identical replacement after slot selection is never recovered', async t => {
  const f = await deliverRecoveryFixture(t);
  const selected = await selectRecoverySlot(f.context, () => assert.fail('slot'));
  await rename(f.fencePath, join(f.issueRoot, 'retained-original'));
  await writeFile(f.fencePath, f.fenceBytes, { mode: 0o600 });
  const result = await recoverAdoptedDeliverFence(f.context,
    { ...f.options, expectedFence: selected.expectedFence });
  assert.equal(result.code, 'RECOVERY_LOCK_CHANGED');
  assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
});

test('historical native Job chooses only an explicitly adopted slot', async t => {
  const f = await deliverRecoveryFixture(t);
  const current = structuredClone({ ...f.context, reader: undefined });
  current.reader = f.context.reader;
  current.adopted.runner.runnerId = 41;
  current.host.runnerUid = 1001;
  let selectedUid;
  const selected = await selectRecoverySlot(current, async uid => {
    selectedUid = uid;
    return f.context;
  });
  assert.equal(selectedUid, 1001);
  assert.equal(selected.context.adopted.runner.runnerId, 40);
  assert.equal(current.adopted.runner.runnerId, 41);
  f.job.runner_id = 99;
  await assert.rejects(selectRecoverySlot(current, async () => f.context),
    { code: 'RECOVERY_EXECUTION_MISMATCH' });
});

async function eligibilityFixture(t) {
  const f = await nativeFixture(t);
  const approvalReader = (reader, pin) => readProtectedApproval(reader, pin, now);
  const approval = await approvalReader(f.adapters.reader, f.adapters.config.approval);
  const context = { reader: f.adapters.reader,
    host: { stateRoot: f.root }, adopted: { approval: f.adapters.config.approval } };
  const options = { inspectAdoption: async () => {}, approvalReader };
  return { f, approval, context, options,
    check: () => continuationEligibility(context, f.runner.expected, approval, options) };
}

test('continuation preflight uses live native eligibility without starting a role',
  async t => {
    const { check } = await eligibilityFixture(t);
    assert.equal((await check()).memberId, 1);
  });

for (const [name, change, code] of [
  ['inactive scope', f => { f.issue.labels = []; }, 'INACTIVE_SCOPE'],
  ['closed Issue', f => { f.issue.state = 'closed'; }, undefined],
  ['assignee changed', f => { f.issue.assignees = []; },
    'ASSIGNEE_RUNNER_BINDING_CHANGED'],
  ['blocked prerequisite', f => {
    f.data['/issues/2/dependencies/blocked_by'].push({ node_id: 'I_other' });
  }, undefined],
  ['offline runner', f => { f.runner.runner.status = 'offline'; },
    'ACTUAL_RUNNER_BINDING_MISMATCH'],
]) test(`preflight refuses ${name}`, async t => {
  const fixture = await eligibilityFixture(t);
  change(fixture.f);
  await assert.rejects(fixture.check, code ? { code } : undefined);
});

test('ordinary admission without a retained fence keeps its existing route', async () => {
  const fence = { ordinary: true };
  assert.deepEqual(await admitContinuationFence({ acquire: async () => fence,
    authorize: () => assert.fail('retained-fence preflight'),
    recover: () => assert.fail('recovery'),
  }), { fence });
});

test('pause or unknown pause observation prevents settlement preflight', async t => {
  const fixture = await eligibilityFixture(t);
  fixture.f.issue.labels.push({ name: 'pause' });
  await assert.rejects(fixture.check, { code: 'PAUSE_OBSERVATION_UNKNOWN' });
});

test('approval changed since native authentication prevents settlement', async t => {
  const fixture = await eligibilityFixture(t);
  fixture.approval.record.operations = ['shape'];
  await assert.rejects(fixture.check, { code: 'HOST_APPROVAL_MISMATCH' });
});

test('an otherwise eligible request needs the recovery operation authorization',
  async t => {
    const fixture = await eligibilityFixture(t);
    fixture.approval.record.operations = ['shape'];
    fixture.options.approvalReader = async () => fixture.approval;
    await assert.rejects(fixture.check, { code: 'OPERATION_NOT_APPROVED' });
  });
