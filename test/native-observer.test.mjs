import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture as fixture } from './native-observer-fixture.mjs';
import { decideStage } from '../src/stages.mjs';
import { now } from './approval-fixture.mjs';

test('observer composes live grant, Issue, dependencies and Job', async (t) => {
  const f = await fixture(t),
    context = await f.observe('shape');
  assert.equal(context.runner.memberId, 1);
  assert.equal(context.route.userId, 1);
  assert.deepEqual(context.receipts, {});
  assert.equal(decideStage('shape', context, now).status, 'allowed');
});

test('observer reads live Issue edits and revocation', async (t) => {
  const f = await fixture(t);
  await f.observe('shape');
  f.issue.body = 'Edited outside protected publication';
  assert.equal(
    decideStage('shape', await f.observe('shape'), now).status,
    'allowed',
  );
  f.data['/collaborators/reviewer/permission'].permission = 'read';
  await assert.rejects(f.observe('shape'), /MEMBER_PERMISSION_REVOKED/);
});

test('offline Runner cannot fall back to another member', async (t) => {
  const f = await fixture(t);
  f.issue.assignees.push({ id: 9, login: 'backup', type: 'User' });
  f.runner.runner.status = 'offline';
  await assert.rejects(f.observe('shape'), /ACTUAL_RUNNER_BINDING_MISMATCH/);
});
