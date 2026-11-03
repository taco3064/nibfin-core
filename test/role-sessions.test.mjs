import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleSessions } from '../src/role-sessions.mjs';
import { stageFixture } from './stage-fixture.mjs';
const thread = '12345678-1234-4234-8234-123456789abc';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-session-'));
  t.after(() => rm(root, { recursive: true, force: true })); return new RoleSessions(root);
}
async function result(session, context, id = thread) {
  await mkdir(join(session.directory, 'sessions'), { recursive: true });
  await writeFile(join(session.directory, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  return { executionId: context.execution.id, terminationHash: 'a'.repeat(64), threadId: id };
}
test('fresh final Shaper review requires no prior conversation and confirmed completion removes its private home', async t => {
  const sessions = await fixture(t), review = stageFixture('review-pr');
  await sessions.run('review-pr', review, async session => { assert.equal(session.threadId, null); return result(session, review); });
  await assert.rejects(sessions.run('review-pr', review, async () => { throw new Error('Should not replay'); }), { code: 'EEXIST' });
});
test('replayed execution and unknown termination retain a fence instead of launching another writer', async t => {
  const sessions = await fixture(t), shape = stageFixture('shape');
  await assert.rejects(sessions.run('shape', shape, async () => { throw new Error('Lost writer'); }));
  await assert.rejects(sessions.run('shape', shape, async () => { throw new Error('Should not retry'); }), { code: 'EEXIST' });
  const independent = stageFixture('accept');
  await sessions.run('accept', independent, session => result(session, independent));
  await assert.rejects(sessions.run('accept', independent, async () => { throw new Error('Should not reuse'); }), { code: 'EEXIST' });
});
test('a verified completion needs no historical transcript but still requires actual thread and termination identity', async t => {
  const sessions = await fixture(t), shape = stageFixture('shape');
  await sessions.run('shape', shape, async () => ({ executionId: shape.execution.id, threadId: thread, terminationHash: 'a'.repeat(64) }));
  const review = stageFixture('review-pr');
  await assert.rejects(sessions.run('review-pr', review, async () => ({ executionId: review.execution.id, threadId: thread })));
});
