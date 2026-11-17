import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { modelFixture } from './fixtures/claude-model-lifecycle.mjs';

async function using(t) {
  const f = await modelFixture();
  t.after(async () => {
    f.modelControls.modelUnknown = false;
    f.workerControls.cleanupUnknown = false;
    try { await f.runner.requestCleanup(f.admission.executionId); }
    finally { await f.close(); }
  });
  return f;
}

test('simulated private runner proves both absent and retains key until retirement',
  async t => {
    const f = await using(t);
    const result = await f.execute();
    assert.equal(result.status, 'completed');
    assert.match(result.terminationHash, /^[a-f0-9]{64}$/);
    assert.equal(f.modelControls.modelExists, false);
    assert.ok(f.calls.some(cmd => cmd[0] === 'rm' &&
      cmd.at(-1).startsWith('nibfin-claude-work-')));
    assert.equal(await f.runner.assertOutputSafe(f.admission.executionId,
      f.key, ''), false);
    assert.equal(await f.runner.assertOutputSafe(f.admission.executionId,
      'safe', ''), true);
    await assert.rejects(access(f.admissionFile));
    await f.runner.retire(f.admission.executionId);
    assert.equal(await f.runner.assertOutputSafe(f.admission.executionId,
      'safe', ''), false);
  });

test('simulated startup and lost create failures reconcile both sides', async t => {
  for (const mode of ['workerLost', 'modelLost', 'modelFailure']) {
    await t.test(mode, async t => {
      const f = await using(t);
      if (mode === 'workerLost') f.workerControls.lostCreate = true;
      if (mode === 'modelLost') f.modelControls.modelLostCreate = true;
      if (mode === 'modelFailure') f.modelControls.modelFailure = true;
      await assert.rejects(f.execute());
      await f.runner.requestCleanup(f.admission.executionId);
      assert.equal(f.modelControls.modelExists, false);
      await assert.rejects(access(f.admissionFile));
    });
  }
});

test('simulated worker or channel loss rejects late model success', async t => {
  for (const mode of ['workerGone', 'channelGone']) {
    await t.test(mode, async t => {
      const f = await using(t);
      f.modelControls.hold = true;
      f.modelControls.executing = async () => { f.modelControls[mode] = true; };
      await assert.rejects(f.execute());
      assert.ok(f.calls.some(cmd => cmd[0] === 'start' && cmd[1] === '-ai'));
      assert.equal(f.modelControls.modelExists, false);
      await assert.rejects(access(f.admissionFile));
    });
  }
});

test('simulated cancellation during create and execution settles both', async t => {
  for (const mode of ['creating', 'executing']) {
    await t.test(mode, async t => {
      const f = await using(t);
      f.modelControls[mode] = async () => { f.abort.abort(); };
      const result = await f.execute();
      assert.equal(result.status, 'interrupted');
      if (mode === 'creating') assert.ok(!f.calls.some(cmd =>
        cmd[0] === 'start' && cmd[1] === '-ai'));
      await Promise.all([f.runner.requestCleanup(f.admission.executionId),
        f.runner.requestCleanup(f.admission.executionId)]);
      assert.equal(f.modelControls.modelExists, false);
      await assert.rejects(access(f.admissionFile));
    });
  }
});

test('simulated unknown cleanup retains recovery resources and scans', async t => {
  for (const mode of ['model', 'worker']) {
    await t.test(mode, async t => {
      const f = await using(t);
      f.modelControls.executing = async () => {
        if (mode === 'model') f.modelControls.modelUnknown = true;
        else f.workerControls.cleanupUnknown = true;
      };
      await assert.rejects(f.execute());
      assert.ok(await readFile(f.admissionFile));
      await access(f.channel);
      await assert.rejects(f.runner.retire(f.admission.executionId));
      assert.equal(await f.runner.assertOutputSafe(f.admission.executionId,
        f.key, ''), false);
      assert.ok(f.calls.some(cmd => cmd[0] === 'ps' &&
        cmd.at(-1).includes(mode === 'model' ? 'nibfin-claude-work-' :
          'nibfin-claude-model-')));
      f.modelControls.modelUnknown = false;
      f.workerControls.cleanupUnknown = false;
      await f.runner.requestCleanup(f.admission.executionId);
      await assert.rejects(access(f.admissionFile));
    });
  }
});

test('simulated cancellation before and during worker startup prevents model create',
  async t => {
    for (const mode of ['before', 'worker-create']) {
      await t.test(mode, async t => {
        const f = await using(t);
        if (mode === 'before') f.abort.abort();
        else f.workerControls.creating = async () => { f.abort.abort(); };
        await assert.rejects(f.execute());
        assert.ok(!f.calls.some(cmd => cmd[0] === 'create' &&
          cmd.includes('--user=1001:1001')));
        await assert.rejects(access(f.admissionFile));
      });
    }
  });

test('simulated orderly bridge completion permits worker exit before model exit',
  async t => {
    const f = await using(t);
    f.modelControls.executing = async () => {
      f.modelControls.workerCompleted = true;
    };
    const result = await f.execute();
    assert.equal(result.status, 'completed');
    assert.equal(f.modelControls.modelExists, false);
    await assert.rejects(access(f.admissionFile));
  });
