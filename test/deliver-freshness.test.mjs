import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alignDelivery, handoffDelivery } from '../src/deliver-freshness.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { rolePrompt } from '../src/role-prompt.mjs';
import { stageFixture } from './stage-fixture.mjs';

const clock = () => Date.parse('2026-11-18T00:00:00Z');
const moved = '9'.repeat(40);

function fixture() {
  const context = stageFixture('deliver');
  const calls = [];
  let candidate = structuredClone(context.candidate);
  const workspace = {
    capture: async (_shape, _during, partial) => {
      calls.push(partial ? 'capture-partial' : 'capture');
      return candidate;
    },
    rebase: async (before, shape, target) => {
      calls.push('rebase');
      assert.deepEqual(before, candidate);
      assert.equal(shape, context.shape.body);
      candidate = { ...candidate, base: target };
      return { status: 'rebased', candidate, contentChanged: false };
    },
    discardWriterGit: async () => calls.push('cleanup'),
  };
  return { context, workspace, calls, candidate: () => candidate };
}

for (const retained of [false, true]) {
  test(`entry aligns ${retained ? 'Candidate' : 'partial work'} before Writer`,
    async () => {
      const f = fixture();
      f.context.main.head = moved;
      if (!retained) delete f.context.candidate;
      const handler = stageHandlers({
        workspace: f.workspace, clock,
        agent: { run: async (_stage, context) => {
          assert.equal(context.rebase.candidate.base, moved);
          f.calls.push('writer');
          return {};
        } },
      }).deliver;
      await handler.perform(f.context);
      assert.deepEqual(f.calls, retained ? ['capture-partial', 'rebase']
        : ['capture-partial', 'rebase', 'writer']);
    });
}

test('already current partial work runs Writer without rebase', async () => {
  const f = fixture();
  delete f.context.candidate;
  const result = await alignDelivery(f.workspace, f.context, undefined, clock, true);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(f.calls, ['capture-partial']);
});

test('handoff observes after termination, cleanup and capture', async () => {
  const f = fixture();
  const message = JSON.stringify({
    outcome: 'ready', body: '', summary: 'Controlled Writer', rootCause: '',
    failureClass: 'none', evidenceReferences: ['fixture:writer'],
    blockingFindings: [], contractConflicts: [],
  });
  const handler = stageHandlers({
    workspace: f.workspace, clock, store: { put: async () => 'a'.repeat(64) },
    observeMain: async () => {
      f.calls.push('observe');
      return { ...f.context.main, head: moved };
    },
  }).deliver;
  const result = await handler.readBack(f.context, {
    executionId: f.context.execution.id, terminationHash: 'a'.repeat(64),
    lastMessage: message, result: JSON.parse(message),
    stdout: [
      { type: 'thread.started', thread_id: f.context.execution.sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: message } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n'),
  });
  assert.equal(result.outcome, 'ready');
  assert.equal(f.candidate().base, moved);
  assert.deepEqual(f.calls, ['cleanup', 'capture', 'observe', 'rebase']);
  await assert.rejects(handler.readBack(f.context, { lastMessage: message }),
    { code: 'AGENT_TERMINATION_UNPROVEN' });
});

for (const conflict of [false, true]) {
  test(`handoff ${conflict ? 'conflict' : 'content change'} returns to admission`,
    async () => {
      const f = fixture();
      f.workspace.rebase = async () => conflict
        ? { status: 'changes_required', latestMain: moved, paths: ['src/example.mjs'] }
        : { status: 'rebased', candidate: f.candidate(), contentChanged: true };
      const result = await handoffDelivery({ ...f, candidate: f.candidate(), clock,
        observeMain: async () => ({ ...f.context.main, head: moved }) });
      assert.equal(result.outcome, 'changes_required');
      assert.ok(result.findings[0].includes(conflict ? 'conflicts' : 'verify'));
    });
}

test('retained conflict resumes through Writer with its actual target', async () => {
  const f = fixture();
  const pending = { status: 'changes_required', latestMain: moved,
    paths: ['src/example.mjs'] };
  f.workspace.pendingRebase = async () => pending;
  f.workspace.capture = async () => assert.fail('Do not capture unresolved conflicts');
  f.workspace.continueRebase = async (_shape, target, proof) => {
    assert.equal(target, moved);
    assert.equal(proof, 'a'.repeat(64));
  };
  const handler = stageHandlers({ workspace: f.workspace, clock,
    agent: { run: async (_stage, context) => {
      assert.deepEqual(context.rebase, pending);
      return { executionId: f.context.execution.id, terminationHash: 'a'.repeat(64) };
    } },
  }).deliver;
  const result = await handler.perform(f.context);
  assert.equal(result.rebaseTarget, moved);
  assert.equal(result.rebaseStatus, 'changes_required');
});

test('unavailable handoff observation retains actual Candidate and reports cause',
  async () => {
    const f = fixture();
    const result = await handoffDelivery({ ...f, candidate: f.candidate(), clock,
      observeMain: async () => { throw { code: 'CURRENT_MAIN_UNAVAILABLE' }; } });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.findings[0], /CURRENT_MAIN_UNAVAILABLE/);
    assert.equal(result.candidate, f.candidate());
    assert.deepEqual(f.calls, []);
  });

test('missing or wrong-repository entry observation cannot start alignment', async () => {
  const f = fixture();
  for (const main of [undefined, { ...f.context.main, repositoryId: 11 }]) {
    await assert.rejects(alignDelivery(f.workspace, { ...f.context, main },
      undefined, clock), { code: 'CURRENT_MAIN_UNAVAILABLE' });
  }
  assert.deepEqual(f.calls, []);
});

test('protected changes are not rebased or captured as ready', async () => {
  const f = fixture();
  const candidate = { ...f.candidate(), paths: ['.github/workflows/ci.yml'] };
  f.context.main.head = moved;
  const result = await alignDelivery(f.workspace, f.context, candidate, clock);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(f.calls, []);
});

test('Skill and prompt distinguish target observation from comparison', async () => {
  const content = await readFile(new URL('../skills/deliver/SKILL.md', import.meta.url),
    'utf8');
  const prompt = rolePrompt('deliver', { skill: { content }, context: {} });
  assert.match(prompt, /before initial\/resumed Deliver/);
  assert.ok(prompt.includes(
    'Reading /main alone cannot establish a fresh remote observation'));
  assert.match(content, /before recording a ready Candidate/);
  assert.match(content, /Old-head CI cannot authorize merge/);
  assert.match(content, /another Issue's\ncontract, a security boundary/);
});


test('a resumed adopted delivery preserves partial work without restoring over it',
  async () => {
    const f = fixture();
    delete f.context.candidate;
    f.context.adoptedCandidate = { number: 15 };
    f.context.receipts.deliver.outcome = 'blocked';
    f.context.main.head = moved;
    f.workspace.restoreAdoptedCandidate = async () => assert.fail('Would erase work');
    const handler = stageHandlers({ workspace: f.workspace, clock,
      agent: { run: async () => ({}) },
    }).deliver;
    await handler.perform(f.context);
    assert.deepEqual(f.calls, ['capture-partial', 'rebase']);
  });

test('a semantic conflict blocker retains the rebase without continuing it', async () => {
  const f = fixture();
  f.workspace.continueRebase = async () => assert.fail('Unapproved semantic choice');
  const message = JSON.stringify({ outcome: 'blocked', body: '',
    summary: 'Protected behavior conflicts', rootCause: 'Ambiguous permission change',
    failureClass: 'authority_gap', evidenceReferences: ['fixture:permission-rule'],
    blockingFindings: ['Owner must resolve the conflicting permission requirement.'],
    contractConflicts: [],
  });
  const handler = stageHandlers({ workspace: f.workspace, clock,
    persistReport: async report => {
      assert.equal(report.binding.stage, 'deliver');
    },
  }).deliver;
  const result = await handler.readBack(f.context, {
    executionId: f.context.execution.id, terminationHash: 'a'.repeat(64),
    rebaseStatus: 'changes_required', rebaseTarget: moved, lastMessage: message,
    result: JSON.parse(message),
    stdout: [
      { type: 'thread.started', thread_id: f.context.execution.sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: message } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n'),
  });
  assert.equal(result.outcome, 'blocked');
  assert.match(result.findings[0], /permission requirement/);
  assert.deepEqual(f.calls, ['cleanup']);
});


test('handoff conflict repair enters perform again before continuing the rebase',
  async () => {
    const f = fixture();
    let pending;
    let writers = 0;
    let repaired;
    const message = JSON.stringify({ outcome: 'ready', body: '', summary: 'Ready',
      rootCause: '', failureClass: 'none', evidenceReferences: ['fixture:writer'],
      blockingFindings: [], contractConflicts: [],
    });
    f.workspace.pendingRebase = async () => pending;
    f.workspace.rebase = async () => {
      assert.equal(writers, 1);
      pending = { status: 'changes_required', latestMain: moved,
        paths: ['src/example.mjs'] };
      return pending;
    };
    const capture = f.workspace.capture;
    f.workspace.capture = async (...args) => {
      assert.ok(!pending, 'Do not capture unresolved conflicts');
      return repaired ?? capture(...args);
    };
    f.workspace.continueRebase = async (_shape, target, proof) => {
      assert.equal(writers, 2);
      assert.equal(target, moved);
      assert.equal(proof, 'a'.repeat(64));
      repaired = { ...f.candidate(), base: moved };
      pending = null;
    };
    const handler = stageHandlers({ workspace: f.workspace, clock,
      store: { put: async () => 'b'.repeat(64) },
      observeMain: async () => ({ ...f.context.main, head: moved }),
      agent: { run: async () => {
        writers++;
        return { executionId: f.context.execution.id, terminationHash: 'a'.repeat(64),
          lastMessage: message, result: JSON.parse(message), stdout: [
            { type: 'thread.started', thread_id: f.context.execution.sessionId },
            { type: 'turn.started' },
            { type: 'item.completed', item: { type: 'agent_message', text: message } },
            { type: 'turn.completed' },
          ].map(JSON.stringify).join('\n') };
      } },
    }).deliver;
    const first = await handler.readBack(f.context, await handler.perform(f.context));
    assert.equal(first.outcome, 'changes_required');
    assert.equal(writers, 1);
    delete f.context.candidate;
    f.context.receipts.deliver = { ...first };
    f.context.main.head = moved;
    const second = await handler.readBack(f.context, await handler.perform(f.context));
    assert.equal(second.outcome, 'ready');
    assert.equal(writers, 2);
  });


test('stale protected work blocks entry without starting Writer or mutating Git',
  async () => {
    const f = fixture();
    f.context.main.head = moved;
    f.context.candidate.paths = ['.github/workflows/ci.yml'];
    const handler = stageHandlers({ workspace: f.workspace, clock,
      agent: { run: async () => assert.fail('Protected conflict needs authority') },
    }).deliver;
    const result = await handler.readBack(f.context, await handler.perform(f.context));
    assert.equal(result.outcome, 'blocked');
    assert.match(result.findings[0], /Changes require separate approval/);
    assert.deepEqual(f.calls, []);
  });
