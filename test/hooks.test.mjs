import test from 'node:test';
import assert from 'node:assert/strict';
import { hookScript, runCandidateHooks } from '../src/hooks.mjs';
import { stageFixture } from './stage-fixture.mjs';

function fixture() {
  const c = stageFixture('accept'), candidate = c.candidate;
  candidate.obligations.hooks = [{ path: 'hooks/pre.sh', event: 'pre-commit' },
    { path: 'hooks/prepare.sh', event: 'prepare-commit-msg' }, { path: 'hooks/message.sh', event: 'commit-msg' }];
  return { candidate, phase: 'pre-accept', message: 'Deliver #2\n', baseline: '/safe/baseline', shapeBody: c.shape.body,
    workspace: { work: '/safe/work', capture: async () => structuredClone(candidate) }, sandbox: { execute: async () => ({ status: 'passed' }) } };
}

test('ordered supported hooks are split around acceptance and message text is data', () => {
  const f = fixture();
  const pre = hookScript(f.candidate, 'pre-accept', '$(unsafe)\n');
  assert.deepEqual(pre.hooks.map(h => h.event), ['pre-commit']); assert.ok(!pre.script.includes('$(unsafe)'));
  const post = hookScript(f.candidate, 'post-accept', f.message);
  assert.deepEqual(post.hooks.map(h => h.event), ['prepare-commit-msg', 'commit-msg']);
  assert.ok(post.script.indexOf('sh /work/hooks/prepare.sh') < post.script.indexOf('sh /work/hooks/message.sh'));
  assert.match(post.script, /cmp \/tmp\/original-message \/tmp\/message/);
});

test('hooks bind exact Candidate before and after isolated execution', async () => {
  const f = fixture(); assert.equal((await runCandidateHooks(f)).status, 'passed');
  let captures = 0;
  f.workspace.capture = async () => ({ ...structuredClone(f.candidate), tree: ++captures === 1 ? f.candidate.tree : '9'.repeat(40) });
  await assert.rejects(runCandidateHooks(f), /HOOK_CHANGED_CANDIDATE/);
  f.workspace.capture = async () => structuredClone(f.candidate);
  f.sandbox.execute = async () => ({ status: 'pending', code: 'WRITER_TERMINATION_UNKNOWN' });
  assert.equal((await runCandidateHooks(f)).status, 'pending');
});

test('unsafe hook paths reject and empty required hook inventory does not invent an execution', async () => {
  const f = fixture(); f.candidate.obligations.hooks[0].path = '../outside';
  assert.throws(() => hookScript(f.candidate, 'pre-accept', f.message));
  f.candidate.obligations.hooks = []; f.sandbox.execute = async () => { throw new Error('Must not run'); };
  assert.equal((await runCandidateHooks(f)).notApplicable, true);
});
