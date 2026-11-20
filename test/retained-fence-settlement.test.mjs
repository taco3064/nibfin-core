import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { digest } from '../src/identity.mjs';

// #462: a stopped historical continuation predates a legitimate installation
// update and revised Scope. Recovery must settle it, not authorize new work.
function reviseCurrentRequirements(f) {
  f.context.hostBytes = 'current trusted adoption after source installation';
  f.issue.body = 'Revised requirements: do not retain the withdrawn PR';
  f.issue.labels = [{ name: 'scope' }];
  f.approval.record.scope = {
    body: f.issue.body, hash: digest(f.issue.body),
  };
}

test('settles historical execution after host update and new unshaped Scope', async t => {
  const f = await deliverRecoveryFixture(t, 'shape');
  const receipts = await f.store.load();
  const journal = await readFile(join(f.journalRoot, 'receipts.json'), 'utf8');
  reviseCurrentRequirements(f);
  assert.equal((await f.recover()).status, 'completed');
  await assert.rejects(readFile(f.fencePath), { code: 'ENOENT' });
  assert.deepEqual(await f.store.load(), receipts);
  assert.equal(await readFile(join(f.journalRoot, 'receipts.json'), 'utf8'), journal);
  assert.deepEqual(f.issue.labels, [{ name: 'scope' }]);
  assert.equal(f.effects, 1);
});

for (const state of ['open', 'closed']) {
  test(`paused ${state} Issue permits settlement without resuming it`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    reviseCurrentRequirements(f);
    f.issue.state = state;
    f.issue.labels.push({ name: 'pause' });
    const issue = structuredClone(f.issue);
    assert.equal((await f.recover()).status, 'completed');
    assert.deepEqual(f.issue, issue);
  });
}

test('settlement does not require a completed historical Shape publication', async t => {
  const f = await deliverRecoveryFixture(t, 'shape');
  const directory = join(f.issueRoot, 'receipts', `evidence-${digest(f.binding)}`);
  await unlink(join(directory, 'publish-shape.json'));
  const before = await f.store.load();
  assert.equal((await f.recover()).status, 'completed');
  assert.deepEqual(await f.store.load(), before);
});

for (const failure of ['member', 'slot', 'journal', 'current-adoption']) {
  test(`changed requirements cannot conceal an unsettled ${failure}`, async t => {
    const f = await deliverRecoveryFixture(t, 'shape');
    reviseCurrentRequirements(f);
    let expected;
    if (failure === 'member') {
      f.data['/user'].id++;
      expected = 'RECOVERY_EXECUTION_MISMATCH';
    }
    if (failure === 'slot') {
      f.job.runner_id++;
      expected = 'RECOVERY_EXECUTION_MISMATCH';
    }
    if (failure === 'current-adoption') {
      f.options.inspectAdoption = async () => {
        throw Object.assign(new Error('Current trusted installation changed'),
          { code: 'HOST_ADOPTION_CHANGED' });
      };
      expected = 'HOST_ADOPTION_CHANGED';
    }
    if (failure === 'journal') {
      await f.journal.run({ operation: 'merge', bindingHash: 'e'.repeat(64) }, {
        admit: async () => 'e'.repeat(64),
        perform: async () => { throw new Error('Unknown external write'); },
        readBack: async () => undefined,
      });
      expected = 'EXTERNAL_EFFECT_UNKNOWN';
    }
    assert.deepEqual(await f.recover(), { status: 'pending', code: expected });
    assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
  });
}
