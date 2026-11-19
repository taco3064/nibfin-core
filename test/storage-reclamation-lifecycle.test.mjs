import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, access, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RoleSessions } from '../src/role-sessions.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';

test('private home retirement contains reclamation failures after confirmed removal',
  async t => {
    await mkdir('.npm', { recursive: true });
    const root = await mkdtemp(resolve('.npm/reclamation-session-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const context = stageFixture('shape');
    let home, requests = 0, removed = false;
    const sessions = new RoleSessions(root, async () => {
      requests++;
      await assert.rejects(access(home), { code: 'ENOENT' });
      removed = true;
      throw Error('discard failure');
    });
    const result = { executionId: context.execution.id,
      threadId: '12345678-1234-4234-8234-123456789abc',
      terminationHash: 'a'.repeat(64) };
    assert.deepEqual(await sessions.run('shape', context, async session => {
      home = session.directory;
      return result;
    }), result);
    assert.equal(requests, 1);
    assert.equal(removed, true);
    const other = stageFixture('accept');
    await assert.rejects(sessions.run('accept', other, async () => {
      throw Error('termination unknown');
    }));
    assert.equal(requests, 1);
  });

test('recovery requests once after retirement and again through recorded retry',
  async t => {
    const f = await deliverRecoveryFixture(t);
    let requests = 0, retired = false;
    f.options.reclaim = async () => {
      requests++;
      await assert.rejects(access(f.fencePath), { code: 'ENOENT' });
      assert(!(await readdir(f.issueRoot)).includes('stage.lock'));
      retired = true;
      throw Error('lost reclamation response');
    };
    assert.equal((await f.recover()).status, 'completed');
    assert.equal(requests, 1);
    assert.equal(retired, true);
    assert.equal((await f.recover()).status, 'completed');
    assert.equal(requests, 2);
    await access(join(f.issueRoot, (await readdir(f.issueRoot))
      .find(name => name.startsWith('settled-deliver-fence-'))));
  });

test('unresolved recovery never requests reclamation', async t => {
  const f = await deliverRecoveryFixture(t);
  let requests = 0;
  f.options.reclaim = async () => { requests++; };
  f.options.containers = async () => { throw Error('unknown termination'); };
  assert.equal((await f.recover()).status, 'pending');
  assert.equal(requests, 0);
});
