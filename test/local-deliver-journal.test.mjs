import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { OperationJournal } from '../src/operation-journal.mjs';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { retainHostOutcome } from '../src/blocker-native-report.mjs';
import { projectBlockerReport } from '../src/blocker-report.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

const linux = { skip: process.platform !== 'linux' };
const subject = { id: 'I_target', repositoryId: 10 };
const failure = code => Object.assign(new Error('/private/token secret'), { code });

async function fixture(t) {
  const scratch = fileURLToPath(new URL('../.deliver-test-tmp/', import.meta.url));
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(scratch, '576-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationJournal(root, subject);
  const request = { operation: 'deliver', bindingHash: 'a'.repeat(64) };
  return { root, journal, request, adapters: {
    localDeliver: true, admit: async () => request.bindingHash,
    perform: async () => {}, readBack: async () => request.bindingHash,
  } };
}

test('real local journal preserves perform/read-back failure and resumes normally',
  linux, async t => {
    for (const phase of ['perform', 'read-back']) {
      const f = await fixture(t);
      let effects = 0;
      const adapters = { ...f.adapters, perform: async () => { effects++; } };
      if (phase === 'perform') adapters.perform = async () => { throw failure('EIO'); };
      else adapters.readBack = async () => 'b'.repeat(64);
      const first = await f.journal.run(f.request, adapters);
      assert.equal(first.code, 'LOCAL_DELIVER_INTERRUPTED');
      assert.deepEqual(first.localInterruption, {
        owner: 'core-local-deliver', phase,
        cause: phase === 'perform' ? 'EIO' : 'READBACK_BINDING_MISMATCH',
      });
      await f.journal.assertIdle();
      const resumed = await f.journal.run(f.request, f.adapters);
      assert.equal(resumed.status, 'completed');
      assert.equal((await f.journal.run(f.request, {
        ...f.adapters, perform: async () => assert.fail('Confirmed work must not repeat'),
      })).code, 'REPLAYED_OPERATION');
      assert.equal(effects, phase === 'perform' ? 0 : 1);
    }
  });

test('real local completion write failure is distinct from execution or read-back',
  linux, async t => {
    const f = await fixture(t);
    const target = join(f.root, digest({ issueId: subject.id,
      repositoryId: subject.repositoryId }), 'receipts.json');
    const result = await f.journal.run(f.request, {
      ...f.adapters, readBack: async () => {
        await mkdir(target);
        return f.request.bindingHash;
      },
    });
    assert.equal(result.code, 'LOCAL_DELIVER_INTERRUPTED');
    assert.deepEqual(result.localInterruption, {
      owner: 'core-local-deliver', phase: 'complete', cause: 'EISDIR',
    });
    await rmdir(target);
    assert.equal((await f.journal.run(f.request, f.adapters)).status, 'completed');
  });

test('external effect uncertainty retains its original non-replayable contract',
  linux, async t => {
    const f = await fixture(t);
    const request = { ...f.request, operation: 'commit-pr' };
    const result = await f.journal.run(request, {
      ...f.adapters, localDeliver: false,
      perform: async () => { throw failure('EIO'); },
    });
    assert.deepEqual(result, { status: 'pending', code: 'EXTERNAL_EFFECT_UNKNOWN' });
    const again = await f.journal.run(request, {
      ...f.adapters, localDeliver: false,
      perform: async () => assert.fail('Unknown remote write must not replay'),
    });
    assert.deepEqual(again, result);
  });

test('StageRuntime and retained native report preserve cause, phase and actual stage',
  linux, async t => {
    for (const phase of ['perform', 'read-back', 'append']) {
      const f = await fixture(t);
      const context = stageFixture('deliver');
      const artifacts = { shapeHash: context.shape.hash,
        candidateHash: digest(context.candidate) };
      const runtime = new StageRuntime({
        observe: async () => structuredClone(context), clock: () => now,
        journal: f.journal,
        handlers: { deliver: {
          perform: async () => { if (phase === 'perform') throw failure('EACCES'); },
          readBack: async () => {
            if (phase === 'read-back') return {};
            return { outcome: 'ready', findings: [], references: ['fixture:role'],
              artifacts };
          },
        } },
        receipts: { append: async () => {
          if (phase === 'append') throw failure('ENOSPC');
          return assert.fail('Failed read-back must not append a receipt');
        } },
      });
      const result = await runtime.run({ schemaVersion: 1, stage: 'deliver' });
      assert.equal(result.stage, 'deliver');
      assert.equal(result.code, 'LOCAL_DELIVER_INTERRUPTED');
      assert.equal(result.localInterruption.phase,
        phase === 'perform' ? 'perform' : 'read-back');
      assert.equal(result.localInterruption.cause, phase === 'perform'
        ? 'EACCES' : phase === 'append' ? 'ENOSPC' : 'INVALID_STAGE_READBACK');
      // The host launcher creates this private base before entering a stage.
      await mkdir(join(f.root, 'receipts'), { mode: 0o700 });
      const retained = await retainHostOutcome(f.root, context, 'deliver', result);
      assert.equal(retained.reportStatus, undefined);
      assert.match(retained.reportReference, /^report:[a-f0-9]{64}$/);
      const report = JSON.parse(await readFile(join(f.root, 'receipts', 'reports',
        retained.reportReference.slice('report:'.length) + '.json'), 'utf8'));
      const projected = projectBlockerReport(report, {
        issue: context.approval.record.issue, subjectId: context.execution.actorId,
      });
      assert.equal(projected.binding.stage, 'deliver');
      assert.deepEqual(projected.localInterruption, result.localInterruption);
      assert.ok(!JSON.stringify([result, report, projected]).includes('/private/token'));
      await f.journal.assertIdle();
    }
  });

test('Owner pause prevents local execution and cannot become an automatic retry',
  linux, async t => {
    const f = await fixture(t);
    const context = stageFixture('deliver');
    context.pause.status = 'paused';
    context.pause.effective = true;
    context.pause.visible = true;
    const runtime = new StageRuntime({
      observe: async () => context, journal: f.journal, clock: () => now,
      receipts: { append: async () => assert.fail('Paused work cannot create receipts') },
      handlers: { deliver: {
        perform: async () => assert.fail('Owner pause must stay authoritative'),
        readBack: async () => assert.fail('No execution to read back'),
      } },
    });
    const result = await runtime.run({ schemaVersion: 1, stage: 'deliver' });
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'ISSUE_PAUSED');
    assert.equal(result.localInterruption, undefined);
  });
