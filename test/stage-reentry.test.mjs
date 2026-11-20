import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../src/identity.mjs';
import { reconcileDelivery } from '../src/stage-reconciliation.mjs';
import { relayControllerRequest } from '../src/host-relay.mjs';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { continueStages } from '../src/stage-continuation.mjs';
import { retryGitHubObservation } from '../src/observation-failure.mjs';
import { issueStatePath } from '../src/host-fence.mjs';
import {
  unfinishedObservation, isUnfinishedObservation,
} from '../src/reconciliation-result.mjs';
import { retryDelay } from '../scripts/retry-shared-runner.mjs';
import { reconciliationFixture } from './reconciliation-fixture.mjs';

const observe = f => reconcileDelivery(f.input, f.dependencies);
const output = value => ({ stdout: Buffer.from(JSON.stringify(value)) });
function unfinished() {
  const f = reconciliationFixture();
  f.live.state = 'open';
  f.live.labels = [{ name: 'scope' }, { name: 'shaped' }];
  for (const stage of Object.keys(f.receipts)) delete f.receipts[stage];
  return f;
}

async function relay(f, enter, fault = 'transport') {
  const request = { schemaVersion: 1, command: 'stage', issue: '443',
    stage: f.input.stage, context: { GITHUB_REPOSITORY: 'owner/repo' } };
  const calls = [];
  const result = await relayControllerRequest(request, 999, async (_, __, opts) => {
    const value = JSON.parse(opts.input);
    calls.push(value);
    if (calls.length === 1) {
      if (fault === 'transport') throw new Error('private transport detail');
      return { stdout: Buffer.from(fault === 'json' ? '{' : '{}') };
    }
    if (value.command === 'reconcile-stage') return output(await observe(f));
    assert.deepEqual(value, request);
    assert.equal(f.counts.released, 1, 'observation fence released before admission');
    return output(await enter(value));
  });
  return { result, calls };
}

test('lost and malformed responses re-enter the exact original stage request',
  async () => {
    for (const stage of ['continue', 'deliver', 'review-pr']) {
      for (const fault of ['transport', 'json', 'status']) {
        const f = unfinished();
        f.input.stage = stage;
        const expected = { schemaVersion: 1, status: 'denied', stage,
          code: 'PAUSE_ACTIVE' };
        const { result, calls } = await relay(f, async () => expected, fault);
        assert.deepEqual(result, expected);
        assert.deepEqual(calls.map(value => value.command),
          ['stage', 'reconcile-stage', 'stage']);
        assert.equal(f.counts.settled, 2);
        assert.deepEqual(f.reads, ['issue']);
      }
    }
  });

test('normal continuation reuses confirmed publication and finishes remaining stages',
  async () => {
    const f = reconciliationFixture();
    f.live.state = 'open';
    f.live.labels = [{ name: 'scope' }, { name: 'shaped' }];
    const remaining = ['review-pr', 'merge', 'close'];
    const saved = Object.fromEntries(remaining.map(stage => [stage, f.receipts[stage]]));
    for (const stage of remaining) delete f.receipts[stage];
    const executed = [];
    const { result } = await relay(f, () => continueStages({
      store: f.store, inspect: async () => {}, wait: async () => {},
      execute: async stage => {
        executed.push(stage);
        assert.ok(remaining.includes(stage), 'confirmed writes must not repeat');
        const receipt = saved[stage];
        f.receipts[stage] = receipt;
        f.objects.set(digest(receipt), receipt);
        return { schemaVersion: 1, stage, status: 'completed',
          receiptHash: digest(receipt) };
      },
    }));
    assert.equal(result.stage, 'close');
    assert.deepEqual(executed, remaining);
  });

test('completed response loss reuses closure without another execution', async () => {
  const f = reconciliationFixture();
  const { result, calls } = await relay(f,
    () => assert.fail('confirmed complete delivery must not execute again'));
  assert.equal(result.terminalStage, 'close');
  assert.equal(result.receiptHash, digest(f.receipts.close));
  assert.equal(calls.length, 2);
});

test('explicit close can recover the existing full closure proof', async () => {
  const f = reconciliationFixture();
  f.input.stage = 'close';
  const { result, calls } = await relay(f, () => assert.fail('no repeat closure'));
  assert.equal(result.stage, 'close');
  assert.equal(result.status, 'completed');
  assert.equal(result.receiptHash, digest(f.receipts.close));
  assert.equal(calls.length, 2);
});

test('retained native pre-merge outcomes keep their status and terminal stage',
  async () => {
    for (const status of ['completed', 'denied']) {
      const expected = { schemaVersion: 1, stage: 'continue', terminalStage: 'accept',
        status, receiptHash: 'a'.repeat(64), disposition: 'recovered-result',
        resultReference: 'b'.repeat(64), code: status === 'completed'
          ? 'STAGE_COMPLETED' : 'STAGE_REQUIRES_CORRECTION' };
      let calls = 0;
      const result = await relayControllerRequest({ command: 'stage',
        stage: 'continue' }, 999, async () => {
        if (++calls === 1) throw new Error('lost');
        assert.equal(calls, 2);
        return output(expected);
      });
      assert.deepEqual(result, expected);
    }
  });

test('current admission refusals and failed native re-entry retain their causes',
  async () => {
    for (const code of ['PERMISSION_DENIED', 'HOST_APPROVAL_MISMATCH',
      'PAUSE_ACTIVE', 'PREREQUISITES_NOT_READY', 'STAGE_REQUIRES_CORRECTION']) {
      const f = unfinished();
      const native = { schemaVersion: 1, stage: 'continue', terminalStage: 'deliver',
        status: 'denied', code };
      assert.deepEqual((await relay(f, async () => native)).result, native);
    }
  });

test('a sanitized Controller admission exception keeps the requested stage', async () => {
  const f = unfinished();
  f.input.stage = 'deliver';
  const { result } = await relay(f,
    async () => ({ status: 'denied', code: 'HOST_APPROVAL_MISMATCH' }));
  assert.deepEqual(result, { status: 'denied', stage: 'deliver',
    code: 'HOST_APPROVAL_MISMATCH' });
});

test('normal runtime admission rejects a newly paused Issue or missing dependency',
  async () => {
    for (const cause of ['pause', 'dependency']) {
      const f = unfinished();
      f.input.stage = 'deliver';
      const context = stageFixture('deliver');
      if (cause === 'pause') context.pause.status = 'paused';
      else context.dependencies.ready = false;
      const runtime = new StageRuntime({
        clock: () => now, observe: async () => context,
        journal: { run: () => assert.fail('refused before effect admission') },
        receipts: { append: () => assert.fail('no role receipt') },
        handlers: { deliver: {
          perform: () => assert.fail('no Writer'),
          readBack: () => assert.fail('no write'),
        } },
      });
      const { result } = await relay(f,
        () => runtime.run({ schemaVersion: 1, stage: 'deliver' }));
      assert.equal(result.stage, 'deliver');
      assert.equal(result.status, 'denied');
      assert.equal(result.code,
        cause === 'pause' ? 'ISSUE_PAUSED' : 'PREREQUISITES_NOT_READY');
    }
  });

test('a second response loss stays unresolved without recursive replay', async () => {
  for (const fault of ['transport', 'invalid-json']) {
    const f = unfinished();
    const { result, calls } = await relay(f, async () => {
      if (fault === 'transport') throw new Error('private failed re-entry');
      // An invalid native status is also an unresolved handoff.
      return { status: 'unknown', secret: 'private failed re-entry' };
    });
    assert.equal(calls.length, 3);
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
    assert.equal(result.stage, 'continue');
    assert.equal(Object.hasOwn(result, 'retrySettled'), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    // A later normal observation remains usable; no new recovery receipt needed.
    assert.ok(isUnfinishedObservation(await observe(f), 'continue'));
  }
});

test('missing optional records and directories permit real initial-state observation',
  async t => {
    const f = unfinished();
    const root = await mkdtemp(join(tmpdir(), 'nibfin-reentry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    f.input.context.host.stateRoot = root;
    f.input.approval.scopeBinding = f.binding.scopeHash;
    delete f.dependencies.acquire;
    delete f.dependencies.journal;
    delete f.dependencies.progress;
    assert.ok(isUnfinishedObservation(await observe(f), 'continue'));
    assert.ok(isUnfinishedObservation(await observe(f), 'continue'));
    assert.deepEqual(f.reads, ['issue', 'issue']);
  });

test('inaccessible or corrupt initial bookkeeping is not ordinary absence', async t => {
  for (const corrupt of ['directory', 'receipt']) {
    const f = unfinished();
    const root = await mkdtemp(join(tmpdir(), 'nibfin-reentry-corrupt-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    f.input.context.host.stateRoot = root;
    f.input.approval.scopeBinding = f.binding.scopeHash;
    const state = issueStatePath(root, f.input.approval.record.issue);
    await mkdir(state, { mode: 0o700 });
    const receipts = join(state, 'receipts');
    await mkdir(receipts, { mode: 0o700 });
    if (corrupt === 'directory') await chmod(receipts, 0o755);
    else {
      const binding = evidenceBinding({ approval: f.input.approval });
      const directory = join(receipts, `evidence-${digest(binding)}`);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'shape.json'), '{', { mode: 0o600 });
    }
    delete f.dependencies.acquire;
    delete f.dependencies.journal;
    delete f.dependencies.progress;
    const result = await observe(f);
    assert.equal(result.code, 'CONTROLLER_RECONCILIATION_UNPROVEN');
    assert.equal(isUnfinishedObservation(result, 'continue'), false);
  }
});

test('unknown, malformed and contradictory live observations never authorize re-entry',
  async () => {
    for (const change of [
      f => { f.live.node_id = 'I_wrong'; },
      f => { f.live.number++; },
      f => { f.live.url = 'https://example.invalid'; },
      f => { f.live.state = 'unknown'; },
      f => { f.live.labels = null; },
      f => { f.live.labels = [{}]; },
      f => { f.live.labels = [{ name: 'delivered' }]; },
      f => { f.live.state = 'closed'; },
      f => { f.live.pull_request = {}; },
      f => { f.receipts.close = {}; },
      f => { f.receipts.shape = { outcome: 'unknown' }; },
      f => { f.input.runner.repositoryId = 999; },
    ]) {
      const f = unfinished();
      change(f);
      const { result, calls } = await relay(f, () => assert.fail('must not re-enter'));
      assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
      assert.equal(calls.length, 2);
    }
  });

test('only the exact internal disposition selects re-entry', async () => {
  for (const change of [
    value => { delete value.disposition; },
    value => { value.stage = 'deliver'; },
    value => { value.schemaVersion = 2; },
    value => { value.status = 'unknown'; },
    value => { value.code = 'CONTROLLER_RECONCILIATION_UNPROVEN'; },
    value => { value.retrySettled = true; },
  ]) {
    const value = unfinishedObservation('continue');
    change(value);
    let calls = 0;
    const result = await relayControllerRequest({ command: 'stage', stage: 'continue' },
      999, async () => {
        if (++calls === 1) throw new Error('lost');
        assert.equal(calls, 2);
        return output(value);
      });
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
  }
});

test('temporary authoritative read failures retry, then observe successful absence',
  async () => {
    const f = unfinished();
    const issue = f.input.context.reader.issue;
    let attempts = 0;
    f.input.context.reader.issue = async value => {
      if (++attempts === 1) throw Object.assign(new Error('private read detail'),
        { transientGitHubRead: true, status: 503 });
      return issue(value);
    };
    const waits = [];
    f.dependencies.retryObservation = observe => retryGitHubObservation(observe,
      { wait: async delay => { waits.push(delay); } });
    assert.ok(isUnfinishedObservation(await observe(f), 'continue'));
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [5000]);
  });

test('exhausted read waits preserve diagnostics and trusted settlement retry binding',
  async () => {
    const f = unfinished();
    f.input.runner.target = { repositoryId: 12 };
    f.input.context.reader.issue = async () => {
      throw Object.assign(new Error('private read detail'),
        { transientGitHubRead: true, status: 503 });
    };
    f.dependencies.retryObservation = observe => retryGitHubObservation(observe,
      { timeout: 0 });
    const { result, calls } = await relay(f, () => assert.fail('failed read'));
    assert.equal(calls.length, 2);
    assert.equal(result.code, 'GITHUB_READ_RETRY_PENDING');
    assert.equal(result.retrySettled, true);
    assert.equal(result.retryRun, 21);
    assert.equal(result.retryAttempt, 1);
    const log = JSON.stringify(result);
    assert.equal(retryDelay(log, 21, 1), 30000);
    assert.equal(retryDelay(log, 21, 2), null);
    assert.equal(log.includes('private'), false);
    f.dependencies.containers = async () => { throw new Error('unsettled'); };
    const unproven = await observe(f);
    assert.equal(unproven.code, 'CONTROLLER_RECONCILIATION_UNPROVEN');
    assert.equal(Object.hasOwn(unproven, 'retrySettled'), false);
  });

test('final settlement or fence release failure withholds unfinished disposition',
  async () => {
    for (const fault of ['settlement', 'release', 'fence']) {
      const f = unfinished();
      if (fault === 'settlement') f.dependencies.containers = async () => {
        if (++f.counts.settled === 2) throw new Error('container appeared');
      };
      else f.dependencies.acquire = async () => ({
        inspect: async () => { if (fault === 'fence') throw new Error('changed'); },
        release: async () => { throw new Error('release failed'); },
      });
      const { result, calls } = await relay(f, () => assert.fail('not settled'));
      assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
      assert.equal(calls.length, 2);
    }
  });
