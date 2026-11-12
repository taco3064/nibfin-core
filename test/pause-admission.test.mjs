import { nativeObserver } from '../src/native-observer.mjs';
import { pauseFixture, people } from './pause-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStage, stages } from '../src/stages.mjs';
import { observeWake } from '../src/wakeup.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';

for (const stage of Object.keys(stages)) {
  test(`${stage} requires fresh clear pause evidence`, () => {
    const context = stageFixture(stage);
    assert.equal(decideStage(stage, context, now).status, 'allowed');
    for (const pause of [
      undefined,
      { status: 'clear' },
      { ...context.pause, status: 'paused', effective: true, visible: true },
      { ...context.pause, status: 'pending', visible: false },
      { ...context.pause, repair: true },
      { ...context.pause, issue: { ...context.pause.issue, id: 'other' } },
    ]) {
      assert.equal(decideStage(stage, { ...context, pause }, now).status, 'denied');
    }
  });
}

test('wake and direct stage fail closed when visible pause disappears before repair',
  async (t) => {
  const record = approvalRecord();
  record.operations.push('wake');
  const f = await nativeFixture(t, record);
  const actor = { id: 1, type: 'User', login: 'writer' };
  f.data['/issues/2/events'] = ['labeled', 'unlabeled'].map((event, index) => ({
    id: index + 1,
    event,
    label: { name: 'pause' },
    actor,
    created_at: `2026-11-12T00:00:0${index}Z`,
  }));
  const context = await f.observe('shape');
  assert.equal(context.pause.status, 'pending');
  assert.equal(decideStage('shape', context, now).code, 'PAUSE_OBSERVATION_UNKNOWN');
  const original = f.adapters.reader.get;
  f.adapters.reader.get = (path) =>
    path === '/user' ? Promise.resolve(f.authority.pr.merged_by) : original(path);
  await assert.rejects(
    observeWake(
      f.adapters.reader,
      {
        approvalPin: f.authority.pin,
        actorId: 3,
        shared: true,
        workflow: { id: 5, path: '.github/workflows/nibfin.yml' },
      },
      () => now,
    ),
    /PAUSE_OBSERVATION_UNKNOWN/,
  );
  const list = f.adapters.reader.list;
  f.adapters.reader.list = async (path) => {
    if (path.endsWith('/events')) throw new Error('History unavailable');
    return list(path);
  };
  assert.equal(decideStage('shape', await f.observe('shape'), now).status, 'denied');
});

test('clear pause evidence never grants execution, dependency or Writer authority',
  () => {
  for (const mutate of [
    (context) => {
      context.approval.record.operations = [];
    },
    (context) => {
      context.dependencies.ready = false;
    },
    (context) => {
      context.isolation.writerStatus = 'unknown';
    },
  ]) {
    const context = stageFixture();
    mutate(context);
    assert.equal(decideStage('shape', context, now).status, 'denied');
  }
});

test('authorized Resume reopens ordinary wake and native stage admission', async t => {
  const record = approvalRecord();
  record.operations.push('wake');
  const f = await nativeFixture(t, record);
  const p = await pauseFixture(t);
  p.issue.body = f.issue.body;
  p.issue.assignees = f.issue.assignees;
  await p.reconcile(p.emit(people.owner, 'labeled'));
  assert.equal((await p.reconcile(p.emit(people.owner, 'unlabeled'))).status, 'clear');
  const reader = f.adapters.reader;
  reader.issue = p.reader.issue;
  const list = reader.list, get = reader.get;
  reader.list = path => path.endsWith('/events') ? p.reader.list(path) : list(path);
  reader.get = path => path === '/user'
    ? Promise.resolve(f.authority.pr.merged_by) : get(path);
  const observe = nativeObserver({ ...f.adapters,
    config: { ...f.adapters.config, pauseJournalRoot: p.root } });
  const resumed = await observe('shape');
  assert.equal(resumed.pause.status, 'clear');
  assert.equal(decideStage('shape', resumed, now).status, 'allowed');
  const wake = await observeWake(reader, {
    approvalPin: f.authority.pin, actorId: 3, shared: true,
    workflow: { id: 5, path: '.github/workflows/nibfin.yml' },
    pauseDecisions: (await p.journal.pauseEvidence()).decisions,
  }, () => now);
  assert.equal(wake.route.userId, 1);
  f.runner.runner.status = 'offline';
  await assert.rejects(observe('shape'), /ACTUAL_RUNNER_BINDING_MISMATCH/);
});
