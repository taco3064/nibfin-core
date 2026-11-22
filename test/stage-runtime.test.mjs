import { pressureFixture } from './host-pressure-fixture.mjs';
import { pressureBinding, hostMemoryPressure } from '../src/host-memory-pressure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { GitHubReader } from '../src/github-read.mjs';
import { decideStage } from '../src/stages.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { relayControllerRequest } from '../src/host-relay.mjs';
async function fixture(t, stage) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = stageFixture(stage),
    saved = [];
  let performed = 0;
  const adapters = {
    observe: async () => structuredClone(context),
    clock: () => now,
    journal: new OperationJournal(root, context.approval.record.issue),
    receipts: {
      append: async (value) => {
        saved.push(value);
        return digest(value);
      },
    },
    handlers: {
      shape: {
        perform: async () => {
          performed++;
          return { body: context.shape.body };
        },
        readBack: async () => ({
          outcome: 'ready',
          findings: [],
          references: ['trusted-session:1'],
          artifacts: { shapeHash: context.shape.hash },
        }),
      },
    },
  };
  return { context, adapters, saved, performed: () => performed };
}
const request = { schemaVersion: 1, stage: 'shape' };

test('Deliver integrates an adopted PR with current main before Accept', async () => {
  const context = stageFixture();
  const pin = { number: 15 };
  const old = { base: '1'.repeat(40) };
  const rebased = { base: '2'.repeat(40) };
  context.adoptedCandidate = pin;
  delete context.receipts.deliver;
  context.rebaseTarget = rebased.base;
  context.main.head = rebased.base;
  let restored = false;
  const handler = stageHandlers({
    agent: { run: async () => assert.fail('Equivalent rebase needs no Writer') },
    workspace: {
      capture: async () => { assert.ok(restored); return old; },
      restoreAdoptedCandidate: async (value, shape) => {
        assert.deepEqual(value, pin);
        assert.equal(shape, context.shape.body);
        restored = true;
        return old;
      },
      rebase: async (candidate, shape, base) => {
        assert.ok(restored);
        assert.equal(candidate, old);
        assert.equal(shape, context.shape.body);
        assert.equal(base, rebased.base);
        return { status: 'rebased', candidate: rebased, contentChanged: false };
      },
    },
  }).deliver;
  const outcome = await handler.perform(context);
  assert.deepEqual(outcome.retainedCandidate, rebased);
  assert.match(outcome.reference, /\/pulls\/15$/);
});

test('Deliver receives independent Accept findings for its Candidate', async () => {
  const context = stageFixture();
  const candidateHash = digest(context.candidate);
  const findings = ['Fix the installation instructions.'];
  context.receipts.deliver = { artifacts: { candidateHash } };
  context.receipts.accept = {
    outcome: 'changes_required',
    artifacts: { candidateHash, shapeHash: context.shape.hash },
    findings,
  };
  const handler = stageHandlers({
    workspace: { capture: async () => context.candidate },
    agent: { run: async (stage, input) => {
      assert.equal(stage, 'deliver');
      assert.deepEqual(input.correctionFindings, findings);
      return { status: 'completed' };
    } },
  }).deliver;
  assert.equal((await handler.perform(context)).status, 'completed');
});

test('Deliver reports protected paths before storing a candidate', async () => {
  const context = stageFixture();
  const path = '.github/workflows/nibfin-issue.yml';
  const candidate = { ...context.candidate, paths: [path] };
  const handler = stageHandlers({
    workspace: { capture: async () => candidate },
    store: { put: async () => assert.fail('Protected changes must not be stored') },
  }).deliver;
  const result = await handler.readBack(context, { retainedCandidate: candidate });
  assert.equal(result.outcome, 'changes_required');
  assert.ok(result.findings[0].includes(path));
  assert.deepEqual(result.artifacts, { shapeHash: context.shape.hash });
});

test('blocked Deliver returns guidance through the Controller and keeps its finding',
  async t => {
    const { context, adapters, saved } = await fixture(t, 'deliver');
    delete context.receipts.merge;
    const evidenceReferences = ['missing-upstream example/core#338'];
    const blockingFindings = ['The installer entry point is missing.'];
    const reports = [];
    const message = JSON.stringify({
      outcome: 'blocked', body: '', summary: 'Missing upstream capability',
      rootCause: 'The code is absent.', failureClass: 'shape_defect',
      evidenceReferences, blockingFindings, contractConflicts: [],
    });
    adapters.handlers = stageHandlers({
      store: { put: async report => {
        reports.push(report);
        return digest(report);
      } },
      workspace: { discardWriterGit: async () => {},
        capture: async () => context.candidate },
      deliverBlockedGuidance: async (observed, refs, rebased) => {
        assert.deepEqual(observed, context);
        assert.deepEqual(refs, evidenceReferences);
        assert.equal(rebased, false);
        return 'Verify the native dependency.';
      },
      agent: { run: async () => ({
        executionId: context.execution.id, terminationHash: 'a'.repeat(64),
        lastMessage: message, result: JSON.parse(message),
        stdout: [
          { type: 'thread.started', thread_id: context.execution.sessionId },
          { type: 'turn.started' },
          { type: 'item.completed', item: { type: 'agent_message', text: message } },
          { type: 'turn.completed' },
        ].map(JSON.stringify).join('\n'),
      }) },
    });
    const outcome = await new StageRuntime(adapters).run({
      schemaVersion: 1, stage: 'deliver',
    });
    const relayed = await relayControllerRequest({ command: 'stage' }, 999, async () =>
      ({ stdout: Buffer.from(JSON.stringify(outcome)) }));
    assert.equal(relayed.status, 'denied');
    assert.equal(relayed.blockedGuidance, 'Verify the native dependency.');
    assert.equal(saved[0].outcome, 'blocked');
    assert.deepEqual(saved[0].findings, blockingFindings);
    assert.deepEqual(saved[0].references, evidenceReferences);
    assert.equal(reports.length, 1);
    assert.deepEqual(saved[0].report, reports[0]);
    assert.equal(reports[0].binding.executionId, context.execution.id);
    assert.equal(reports[0].rootCause, 'The code is absent.');
    assert.equal(reports[0].failureClass, 'shape_defect');
    assert.deepEqual(reports[0].agentEvidenceReferences, evidenceReferences);
  });

test('a published Shape is loaded verbatim without starting Author', async t => {
  const f = await fixture(t);
  const body = f.context.shape.body;
  f.context.issue.body = body;
  f.context.issue.labels.push({ name: 'shaped' });
  let stored;
  f.adapters.handlers = stageHandlers({
    agent: { run: async () => assert.fail('Published Shape needs no new Author') },
    store: { put: async value => {
      stored = value;
      return digest(value);
    }, get: async hash => {
      assert.equal(hash, digest(body));
      return body;
    } },
  });
  const outcome = await new StageRuntime(f.adapters).run(request);
  assert.equal(outcome.status, 'completed');
  assert.equal(stored, body);
  assert.equal(f.saved[0].artifacts.shapeHash, digest(body));
  assert.deepEqual(f.saved[0].references, [f.context.issue.url]);
});

test('a finished Author with invalid obligations writes a blocked receipt', async t => {
  const f = await fixture(t);
  const { execution } = f.context;
  const message = JSON.stringify({
    outcome: 'ready', body: 'Missing the required block', summary: 'Draft',
    rootCause: '', failureClass: 'none', evidenceReferences: [f.context.issue.url],
    blockingFindings: [], contractConflicts: [],
  });
  f.adapters.handlers = stageHandlers({
    agent: { run: async () => ({
      executionId: execution.id, terminationHash: 'a'.repeat(64), lastMessage: message,
      result: JSON.parse(message),
      stdout: [
        { type: 'thread.started', thread_id: execution.sessionId },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: message } },
        { type: 'turn.completed' },
      ].map(JSON.stringify).join('\n'),
    }) },
  });
  const runtime = new StageRuntime(f.adapters);
  assert.equal((await runtime.run(request)).code, 'STAGE_REQUIRES_CORRECTION');
  assert.match(f.saved[0].findings[0], /invalid candidate obligations/);
  assert.equal(f.saved[0].requirementsBody, f.context.issue.body);
  assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
});

test('confirmed startup and idle failures report the reason', async t => {
  for (const [code, finding] of [
    ['CODEX_IDLE_TIMEOUT', /without progress/],
    ['SUBSCRIPTION_LOGIN_UNAVAILABLE', /before the role ran/],
  ]) {
    const f = await fixture(t);
    const interrupted = {
      status: 'interrupted',
      executionId: f.context.execution.id,
      terminationHash: 'a'.repeat(64),
      code,
    };
    f.adapters.handlers = stageHandlers({
      agent: { run: async () => interrupted },
      store: { put: async value => digest(value) },
    });
    const runtime = new StageRuntime(f.adapters);
    assert.equal((await runtime.run(request)).code, code);
    assert.equal(f.saved[0].outcome, 'blocked');
    assert.match(f.saved[0].findings[0], finding);
    assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
  }
});

test('runtime persists a trusted receipt after read-back', async (t) => {
  const f = await fixture(t),
    runtime = new StageRuntime(f.adapters);
  const outcome = await runtime.run(request);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.receiptHash, digest(f.saved[0]));
  assert.equal(f.saved[0].execution.actorId, 1);
  assert.equal(
    f.saved[0].binding.scopeHash,
    f.context.approval.record.scope.hash,
  );
  assert.equal((await runtime.run(request)).code, 'REPLAYED_OPERATION');
  assert.equal(f.performed(), 1);
});

test('revocation before admission prevents execution', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const c = structuredClone(f.context);
    if (++reads > 1) c.approval.record.operations = [];
    return c;
  };
  assert.equal(
    (await new StageRuntime(f.adapters).run(request)).status,
    'denied',
  );
  assert.equal(f.performed(), 0);
  assert.equal(f.saved.length, 0);
});

test('unknown effects and lost receipts stay Pending', async (t) => {
  for (const fail of ['perform', 'readBack', 'append']) {
    const f = await fixture(t);
    const unavailable = async () => {
      throw new Error('Unknown provider result');
    };
    if (fail === 'append') f.adapters.receipts.append = unavailable;
    else f.adapters.handlers.shape[fail] = unavailable;
    const runtime = new StageRuntime(f.adapters);
    assert.equal((await runtime.run(request)).status, 'pending');
    assert.equal((await runtime.run(request)).code, 'EXTERNAL_EFFECT_UNKNOWN');
  }
});

test('untrusted requests cannot select arbitrary commands', async (t) => {
  const f = await fixture(t),
    runtime = new StageRuntime(f.adapters);
  for (const invalid of [
    { ...request, authorized: true },
    { ...request, command: 'anything' },
    { ...request, schemaVersion: 2 },
    { ...request, stage: '__proto__' },
    { ...request, stage: 'constructor' },
  ]) {
    assert.equal((await runtime.run(invalid)).code, 'INVALID_STAGE_REQUEST');
  }
  assert.equal(
    (await runtime.run({ ...request, stage: 'deliver' })).code,
    'UNSUPPORTED_STAGE_ADAPTER',
  );
  assert.equal(f.performed(), 0);
});

test('an authorized Issue edit during admission requires a fresh decision', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const c = structuredClone(f.context);
    if (++reads > 1) c.issue.body += 'New acceptance criteria';
    return c;
  };
  assert.equal(
    (await new StageRuntime(f.adapters).run(request)).status,
    'denied',
  );
  assert.equal(f.performed(), 0);
});

test('an admitted stage settles after pause; its next invocation cannot begin',
  async t => {
  const f = await fixture(t);
  const perform = f.adapters.handlers.shape.perform;
  f.adapters.handlers.shape.perform = async () => {
    const result = await perform();
    f.context.pause = { ...f.context.pause, status: 'paused', effective: true,
      visible: true };
    f.context.issue.labels.push({ name: 'pause' });
    return result;
  };
  const runtime = new StageRuntime(f.adapters);
  const settled = await runtime.run(request);
  assert.equal(settled.status, 'completed');
  assert.equal(f.saved.length, 1);
  assert.equal((await runtime.run(request)).code, 'ISSUE_PAUSED');
  assert.equal(f.performed(), 1);
});

test('pause observation changes between stage admission reads prevent execution',
  async t => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    const value = structuredClone(f.context);
    if (++reads > 1) value.pause.observationHash = 'b'.repeat(64);
    return value;
  };
    const result = await new StageRuntime(f.adapters).run(request);
    assert.equal(result.code, 'PAUSE_OBSERVATION_CHANGED');
    assert.deepEqual(result.changedFields, ['pause.observationHash']);
  assert.equal(f.performed(), 0);
});

test('Review reports the changed CI field before it starts', async t => {
  const f = await fixture(t);
  const context = stageFixture('review-pr');
  let reads = 0;
  f.adapters.handlers['review-pr'] = f.adapters.handlers.shape;
  f.adapters.observe = async () => {
    const value = structuredClone(context);
    if (++reads === 2) value.ci.provenanceHash = 'b'.repeat(64);
    return value;
  };
  const result = await new StageRuntime(f.adapters).run({
    schemaVersion: 1, stage: 'review-pr',
  });
  assert.deepEqual(result, {
    schemaVersion: 1, stage: 'review-pr', status: 'pending',
    code: 'CI_CHANGED_DURING_READ',
    changedFields: ['artifacts.ciHash', 'ci.provenanceHash'],
  });
  assert.equal(f.performed(), 0);
  assert.equal(f.saved.length, 0);
});

test('Review retries proof drift and reports both commit observations',
  async t => {
  const f = await fixture(t);
  const context = stageFixture('review-pr');
  const snapshots = ['in_progress', 'completed'].map((status, index) => [{
    source: 'head', sha: context.pr.head, requestIds: [`AB:${index}`],
    count: 1, checks: [{ id: 10, status, conclusion: index ? 'success' : null }],
  }, {
    source: 'testMerge', sha: context.pr.mergePreview,
    requestIds: [`CD:${index}`], count: 0, checks: [],
  }]);
  let reads = 0;
  f.adapters.handlers['review-pr'] = f.adapters.handlers.shape;
  f.adapters.observe = async () => {
    const value = structuredClone(context);
    value.checkObservations = snapshots[reads++];
    value.ci.observedChecks = value.checkObservations[0].checks;
    if (reads === 2) value.ci.provenanceHash = 'b'.repeat(64);
    return value;
  };
  const result = await new StageRuntime(f.adapters).run({
    schemaVersion: 1, stage: 'review-pr',
  });
  assert.equal(result.code, 'CI_CHANGED_DURING_READ');
  assert.deepEqual(result.checkObservationDiff, {
    before: snapshots[0], after: snapshots[1],
  });
  assert.equal(f.performed(), 0);
});

test('Review admission ignores changes to diagnostic checks', async () => {
  const context = stageFixture('review-pr');
  context.ci.observedChecks = [{ id: 99, status: 'queued' }];
  let reads = 0;
  let performed = false;
  const runtime = new StageRuntime({
    clock: () => now,
    observe: async () => {
      const value = structuredClone(context);
      if (++reads === 2) value.ci.observedChecks[0].status = 'in_progress';
      return value;
    },
    journal: {
      run: async (request, { admit, perform, readBack }) => {
        assert.equal(await admit(), request.bindingHash);
        await perform();
        await readBack();
        return { status: 'completed' };
      },
    },
    receipts: { append: async value => digest(value) },
    handlers: {
      'review-pr': {
        perform: async () => { performed = true; },
        readBack: async value => ({
          outcome: 'approved', findings: [], references: ['test'],
          artifacts: decideStage('review-pr', value, now).artifacts,
        }),
      },
    },
  });
  const result = await runtime.run({ schemaVersion: 1, stage: 'review-pr' });
  assert.equal(result.status, 'completed');
  assert.equal(performed, true);
});

test('GitHub API failures can resume before the stage has effects', async t => {
  for (const [rejectOn, status] of [[1, 401], [1, 404], [2, 403], [2, 422], [2, null]]) {
    const f = await fixture(t);
    const reader = new GitHubReader('fixture-token', async () => {
      if (status === null) throw new TypeError('Connection failed');
      return new Response(null, { status });
    });
    let reads = 0;
    f.adapters.observe = async () => {
      if (++reads === rejectOn) await reader.get('/repos/demo/project/issues/1');
      return structuredClone(f.context);
    };
    const result = await new StageRuntime(f.adapters).run(request);
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'GITHUB_API_RETRY_PENDING');
    assert.equal(result.retryAfterMs, 60000);
    assert.equal(f.performed(), 0);
    assert.equal(f.saved.length, 0);
  }
});

test('a rate-limited second admission waits before starting the role', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.adapters.observe = async () => {
    if (++reads === 2) throw Object.assign(new Error('Limited'), {
      status: 403, transientGitHubRead: true, retryAfter: '120',
    });
    return structuredClone(f.context);
  };
  const result = await new StageRuntime(f.adapters).run(request);
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'GITHUB_READ_RETRY_PENDING');
  assert.equal(result.retryAfterMs, 120000);
  assert.equal(f.performed(), 0);
  assert.equal(f.saved.length, 0);
});

test('trusted pressure survives read-back without exposing host observations',
  async t => {
  for (const matching of [true, false]) {
    const f = await fixture(t);
    const objects = {};
    const binding = pressureBinding('shape', f.context);
    const memoryPressure = pressureFixture({ ...binding,
      ...(matching ? {} : { jobId: binding.jobId + 1 }) });
    f.adapters.handlers = stageHandlers({
      agent: { run: async () => ({ status: 'interrupted',
        executionId: f.context.execution.id, terminationHash: 'a'.repeat(64),
        code: hostMemoryPressure, memoryPressure }) },
      store: { put: async value => { objects[digest(value)] = value;
        return digest(value); } },
    });
    const result = await new StageRuntime(f.adapters).run(request);
    if (!matching) {
      assert.notEqual(result.code, hostMemoryPressure);
      assert.equal(result.pressureConfirmed, undefined);
      continue;
    }
    assert.equal(result.code, hostMemoryPressure);
    assert.equal(result.pressureConfirmed, true);
    const reference = f.saved[0].references[0].slice('evidence:'.length);
    assert.deepEqual(objects[reference].memoryPressure, memoryPressure);
    assert.equal(objects[reference].stage, 'shape');
    assert.equal(objects[reference].terminationHash, 'a'.repeat(64));
    assert.equal(JSON.stringify(result).includes(memoryPressure.bootId), false);
  }
});

test('Agent-authored host pressure claims cannot authorize recovery', async t => {
  const f = await fixture(t);
  const { execution } = f.context;
  const message = JSON.stringify({ outcome: 'blocked', body: hostMemoryPressure,
    summary: hostMemoryPressure, rootCause: JSON.stringify(pressureFixture()),
    failureClass: 'external_failure', evidenceReferences: ['untrusted-claim'],
    blockingFindings: [hostMemoryPressure], contractConflicts: [] });
  f.adapters.handlers = stageHandlers({
    store: { put: async value => digest(value) },
    agent: { run: async () => ({
    executionId: execution.id, terminationHash: 'a'.repeat(64), lastMessage: message,
    result: JSON.parse(message),
    stdout: [
      { type: 'thread.started', thread_id: execution.sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: message } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n'),
  }) } });
  const result = await new StageRuntime(f.adapters).run(request);
  assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
  assert.equal(result.pressureConfirmed, undefined);
});

test('Deliver uses the admitted main when it moves during entry observation', async t => {
  const f = await fixture(t, 'deliver');
  let reads = 0;
  f.adapters.observe = async () => {
    const context = structuredClone(f.context);
    if (++reads > 1) context.main.head = '9'.repeat(40);
    return context;
  };
  f.adapters.handlers = { deliver: {
    perform: async context => {
      assert.equal(context.main.head, '9'.repeat(40));
      assert.equal(context.rebaseTarget, context.main.head);
    },
    readBack: async () => ({ outcome: 'ready', findings: [],
      references: ['fixture:admitted-main'], artifacts: {
        shapeHash: f.context.shape.hash,
        candidateHash: digest(f.context.candidate),
      } }),
  } };
  const result = await new StageRuntime(f.adapters).run({
    schemaVersion: 1, stage: 'deliver',
  });
  assert.equal(result.status, 'completed');
});


test('progress is nonterminal and a settled Deliver binding can reenter', async t => {
  const f = await fixture(t, 'deliver');
  let invocations = 0;
  f.adapters.handlers = { deliver: {
    perform: async () => { invocations++; },
    readBack: async () => ({ outcome: invocations > 2 ? 'ready' : 'progress',
      findings: [],
      references: ['fixture:progress'], artifacts: { shapeHash: f.context.shape.hash },
      deliveryCheckpoint: { branch: 'nibfin/deliver-2', head: 'a'.repeat(40) } }),
  } };
  const runtime = new StageRuntime(f.adapters);
  for (let i = 0; i < 2; i++) {
    const result = await runtime.run({ schemaVersion: 1, stage: 'deliver' });
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'DELIVER_PROGRESS_SAVED');
  }
  assert.equal(invocations, 2);
  assert.equal(f.saved[0].outcome, 'progress');
  assert.equal((await runtime.run({ schemaVersion: 1, stage: 'deliver' })).status,
    'completed');
  assert.equal((await runtime.run({ schemaVersion: 1, stage: 'deliver' })).code,
    'REPLAYED_OPERATION');
  assert.equal(invocations, 3);
});
