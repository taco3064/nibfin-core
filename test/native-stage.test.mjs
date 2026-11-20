import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeStageExecutor, runStageInput } from '../src/native-stage.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { evidenceBinding } from '../src/stages.mjs';
import { checkpointMessage } from '../src/delivery-checkpoint.mjs';

async function fixture(t) {
  const f = await nativeFixture(t);
  let effects = 0;
  const agent = {
    run: async (_stage, context) => {
      effects++;
      const lastMessage = JSON.stringify({
        outcome: 'ready',
        body: f.context.shape.body,
        summary: 'Synthetic isolated execution',
        rootCause: '',
        failureClass: 'none',
        evidenceReferences: ['fixture:role'],
        blockingFindings: [],
        contractConflicts: [],
      });
      return {
        executionId: context.execution.id,
        terminationHash: 'a'.repeat(64),
        lastMessage,
        stdout: [
          { type: 'thread.started', thread_id: context.execution.sessionId },
          { type: 'turn.started' },
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: lastMessage },
          },
          { type: 'turn.completed' },
        ]
          .map(JSON.stringify)
          .join('\n'),
      };
    },
  };
  const options = {
    ...f.adapters,
    agent,
    token: 'synthetic-token',
    workspace: {
      push: async () => {
        throw new Error('Unexpected push');
      },
    },
    sandbox: {
      execute: async () => {
        throw new Error('Unexpected hook');
      },
    },
  };
  return { ...f, options, agent, effects: () => effects };
}
const request = JSON.stringify({ schemaVersion: 1, stage: 'shape' });

test('native stage binds live admission and evidence', async (t) => {
  const f = await fixture(t),
    executor = nativeStageExecutor(f.options);
  const result = await runStageInput(request, executor);
  assert.equal(result.status, 'completed');
  assert.equal(f.effects(), 1);
  const observed = await f.observe('shape');
  const store = new EvidenceStore(f.root, evidenceBinding(observed));
  const receipts = await store.load();
  assert.equal(receipts.shape.execution.id, f.options.execution.id);
  assert.equal(
    await store.get(receipts.shape.artifacts.shapeHash),
    f.context.shape.body,
  );
  assert.equal(
    (await runStageInput(request, nativeStageExecutor(f.options))).code,
    'REPLAYED_OPERATION',
  );
  assert.equal(f.effects(), 1);
});

test('revocation prevents Agent execution', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const inspect = f.options.inspectCaller;
  f.options.inspectCaller = async (runner) => {
    const value = await inspect(runner);
    if (++calls === 1)
      f.data['/collaborators/reviewer/permission'].permission = 'read';
    return value;
  };
  assert.equal(
    (await runStageInput(request, nativeStageExecutor(f.options))).status,
    'denied',
  );
  assert.equal(f.effects(), 0);
});

test('unknown outcome fences new executors', async (t) => {
  const f = await fixture(t);
  let effects = 0;
  f.agent.run = async () => {
    effects++;
    throw new Error('Lost process result');
  };
  assert.equal(
    (await runStageInput(request, nativeStageExecutor(f.options))).status,
    'pending',
  );
  assert.equal(
    (await runStageInput(request, nativeStageExecutor(f.options))).code,
    'EXTERNAL_EFFECT_UNKNOWN',
  );
  assert.equal(effects, 1);
});

test('invalid transport inputs never reach the host', async () => {
  let calls = 0;
  const executor = {
    run: async () => {
      calls++;
      throw new Error('private credential detail');
    },
  };
  for (const input of [
    'null',
    '[]',
    '{',
    ' '.repeat(4097),
    '{"schemaVersion":1,"stage":"shape","token":"forged"}',
    '{"schemaVersion":1,"stage":"shape","adapter":"/work/evil.mjs"}',
    '{"schemaVersion":1,"stage":"constructor"}',
  ]) {
    assert.equal(
      (await runStageInput(input, executor)).code,
      'INVALID_STAGE_REQUEST',
    );
  }
  assert.equal(calls, 0);
  const result = await runStageInput(request, executor);
  assert.equal(result.status, 'pending');
  assert.equal(JSON.stringify(result).includes('credential'), false);
});

for (const boundary of ['entry', 'handoff'])
  test(`native Deliver aligns moving main at ${boundary} before Accept`, async t => {
    const prior = stageFixture('deliver');
    const f = await nativeFixture(t, prior.approval.record);
    const publisher = { id: 1, login: 'writer', type: 'User' };
    f.data['/pulls/7'].merged_by = publisher;
    f.data['/rulesets/rule-suites/60'].actor_id = 1;
    f.data['/collaborators/writer/permission'].permission = 'admin';
    const approved = await f.observe('shape');
    const binding = evidenceBinding(approved);
    const store = new EvidenceStore(f.root, binding);
    await store.put(prior.shape.body);
    for (const stage of ['shape', 'validate-shape', 'publish-shape'])
      await store.append({ ...prior.receipts[stage], binding });
    f.issue.body = prior.shape.body;
    f.issue.labels.push({ name: 'shaped' });
    if (boundary === 'entry')
      f.data['/git/ref/heads/main'].object.sha = '9'.repeat(40);
    const actions = [];
    let current = prior.candidate;
    const checkpoint = 'f'.repeat(40), branch = 'nibfin/deliver-2';
    const originalGet = f.adapters.reader.get;
    f.adapters.reader.get = async path => {
      if (path.endsWith('/branches/nibfin%2Fdeliver-2') &&
          !f.data['/branches/nibfin%2Fdeliver-2'])
        throw Object.assign(new Error('branch absent'), {
          status: 404, githubApiRead: true,
        });
      return originalGet(path);
    };
    let observedCommit;
    const workspace = {
      async commit(candidate, _shape, _timestamp, _partial, binding) {
        observedCommit = { sha: checkpoint, tree: { sha: candidate.tree },
          parents: [{ sha: candidate.base }],
          message: checkpointMessage(prior.approval.record.issue, binding, candidate) };
        return { head: checkpoint };
      },
      async push(head, target, _token, guard, expected, operation) {
        await guard({ operation, targetHash: 'c'.repeat(64) });
        assert.deepEqual([head, target, expected], [checkpoint, branch, null]);
        actions.push('save');
        f.data['/branches/nibfin%2Fdeliver-2'] = { name: branch, commit: observedCommit };
        f.data[`/git/commits/${checkpoint}`] = observedCommit;
        f.data[`/commits/${checkpoint}/pulls`] = [];
      },
      rebase: async (candidate, _shape, target) => {
        actions.push('rebase');
        assert.deepEqual(candidate, prior.candidate);
        assert.equal(target, '9'.repeat(40));
        current = { ...candidate, base: target };
        return { status: 'rebased', candidate: current, contentChanged: false };
      },
      discardWriterGit: async proof => {
        assert.equal(proof, 'a'.repeat(64));
        actions.push('discard-writer-git');
      },
      capture: async () => {
        return current;
      },
      hookBaseline: async () => '/trusted/baseline',
    };
    const sandbox = { execute: async () => assert.fail('no declared hooks') };
    for (const stage of ['deliver', 'pre-accept-hooks', 'accept']) {
      const execution = {
        ...stageFixture(stage).execution,
        runId: f.runner.expected.runId,
        attempt: f.runner.expected.attempt,
        jobId: f.runner.expected.jobId,
      };
      const agent = {
        run: async (role, context) => {
          actions.push(role);
          if (role === 'deliver' && boundary === 'handoff')
            f.data['/git/ref/heads/main'].object.sha = '9'.repeat(40);
          const lastMessage = JSON.stringify({
            outcome: role === 'accept' ? 'accepted' : 'ready',
            body: '',
            summary: 'Verified fixture',
            rootCause: '',
            failureClass: 'none',
            evidenceReferences: ['fixture:role'],
            blockingFindings: [],
            contractConflicts: [],
          });
          const items = [
            { type: 'thread.started', thread_id: context.execution.sessionId },
            { type: 'turn.started' },
            {
              type: 'item.completed',
              item: { type: 'agent_message', text: lastMessage },
            },
            { type: 'turn.completed' },
          ];
          return {
            executionId: execution.id,
            terminationHash: 'a'.repeat(64),
            lastMessage,
            stdout: items.map((item) => JSON.stringify(item)).join('\n'),
          };
        },
      };
      const executor = nativeStageExecutor({
        ...f.adapters,
        execution,
        workspace,
        agent,
        sandbox,
        token: 'synthetic-token',
        fetcher: async () => ({ ok: true, json: async () => publisher }),
        inspectIsolation: async () => ({
          ...prior.isolation,
          executionId: execution.id,
        }),
      });
      const result = await executor.run({ schemaVersion: 1, stage });
      assert.equal(result.status, 'completed', JSON.stringify(result));
    }
    const saved = await store.load();
    assert.deepEqual(saved.deliver.deliveryCheckpoint, { branch, head: checkpoint });
    assert.deepEqual(
      await store.get(saved.deliver.artifacts.candidateHash),
      current,
    );
    assert.equal(
      saved.deliver.artifacts.candidateHash,
      saved.accept.artifacts.candidateHash,
    );
    assert.deepEqual(actions, boundary === 'entry'
      ? ['rebase', 'deliver', 'discard-writer-git', 'save', 'accept']
      : ['deliver', 'discard-writer-git', 'rebase', 'save', 'accept']);
  });
