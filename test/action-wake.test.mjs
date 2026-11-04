import test from 'node:test';
import assert from 'node:assert/strict';
import { callerRecipe, wakeRecipe } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';
import { readRunnerBinding } from '../src/runner-binding.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

test('Action continuation is a fixed immutable caller with no role policy', () => {
  const core = 'c'.repeat(40),
    action = 'd'.repeat(40);
  const recipe = wakeRecipe(core, { actionCommit: action }, 2);
  const body = callerRecipe(recipe.kind, core, recipe);
  assert.ok(body.includes(action));
  assert.ok(body.includes(`Core source: ${core}`));
  assert.ok(body.includes('nibfin-user-2'));
  assert.ok(body.includes('stage: continue'));
  assert.equal(body.includes('run:'), false);
  assert.equal(body.includes('secrets:'), false);
  assert.equal(body.includes('write-all'), false);
  for (const line of body.split('\n')) assert.ok(line.length <= 90);
  for (const changed of [{ actionCommit: 'main' }, { memberId: '2' }, { memberId: 0 }]) {
    assert.throws(() => callerRecipe('action-wake', core, { ...recipe, ...changed }));
  }
});

test('native Action caller retains identity and source continuity gates', async () => {
  const f = runnerProviderFixture(),
    anchor = 'a'.repeat(40),
    head = 'b'.repeat(40);
  Object.assign(f.expected, {
    sourceAnchor: anchor,
    sourceCommit: head,
    actionCommit: 'd'.repeat(40),
    actionCoreCommit: 'c'.repeat(40),
    jobName: 'adopted-stage',
  });
  f.job.name = f.expected.jobName;
  f.run.head_sha = head;
  f.job.head_sha = head;
  const recipe = wakeRecipe(f.expected.actionCoreCommit, f.expected, 2);
  const body = callerRecipe(recipe.kind, recipe.coreCommit, recipe);
  f.expected.workflowBlob = gitBlob(body);
  const path = f.expected.workflowPath;
  f.data['/branches/main'] = { protected: true, commit: { sha: head } };
  f.data[`/compare/${anchor}...${head}`] = {
    status: 'ahead',
    merge_base_commit: { sha: anchor },
  };
  for (const sha of [anchor, head]) {
    f.data[`/contents/${path}?ref=${sha}`] = {
      type: 'file',
      path,
      sha: gitBlob(body),
      content: Buffer.from(body).toString('base64'),
      encoding: 'base64',
      size: Buffer.byteLength(body),
    };
    f.data[`/commits?sha=${sha}&path=${encodeURIComponent(path)}&per_page=1`] = [
      { sha: anchor },
    ];
  }
  assert.equal((await readRunnerBinding(f.reader, f.expected)).runnerId, 40);
  for (const changed of [
    { actionCommit: 'e'.repeat(40) },
    { actionCoreCommit: 'e'.repeat(40) },
  ]) {
    await assert.rejects(
      readRunnerBinding(f.reader, { ...f.expected, ...changed }),
      /CALLER_NOT_FIXED_RECIPE/,
    );
  }
  f.expected.sourceAnchor = head;
  assert.equal((await readRunnerBinding(f.reader, f.expected)).runnerId, 40);
  for (const changed of [
    { actionCommit: 'e'.repeat(40) },
    { actionCoreCommit: 'e'.repeat(40) },
    { memberId: 3 },
  ]) {
    await assert.rejects(
      readRunnerBinding(f.reader, { ...f.expected, ...changed }),
      /CALLER_NOT_FIXED_RECIPE/,
    );
  }
});
