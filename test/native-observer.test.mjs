import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture as fixture } from './native-observer-fixture.mjs';
import { decideStage } from '../src/stages.mjs';
import { now } from './approval-fixture.mjs';

test('native observer composes live grant, original Issue, dependencies, ordered route and real job adapters', async t => {
  const f = await fixture(t), context = await f.observe('shape');
  assert.equal(context.runner.memberId, 1); assert.equal(context.route.userId, 1);
  assert.deepEqual(context.receipts, {}); assert.equal(decideStage('shape', context, now).status, 'allowed');
});

test('the same observer re-reads revocation and edited Scope instead of reusing prior permission', async t => {
  const f = await fixture(t); await f.observe('shape');
  f.issue.body = 'Edited outside protected publication';
  assert.equal(decideStage('shape', await f.observe('shape'), now).code, 'RAW_SCOPE_CHANGED');
  f.data['/collaborators/reviewer/permission'].permission = 'read';
  await assert.rejects(f.observe('shape'), /MEMBER_PERMISSION_REVOKED/);
});

test('routing cannot fall back to another member when the approved selected Runner is offline', async t => {
  const f = await fixture(t); f.issue.assignees.push({ id: 9, login: 'backup', type: 'User' });
  f.runner.runner.status = 'offline';
  await assert.rejects(f.observe('shape'), /ACTUAL_RUNNER_BINDING_MISMATCH/);
});
