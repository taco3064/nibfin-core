import test from 'node:test';
import assert from 'node:assert/strict';
import { continueStages } from '../src/stage-continuation.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { stageSuccess } from '../src/stage-runtime.mjs';
import { codexPreflightExits } from '../src/codex-bootstrap.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

async function fixture(code = 'SANDBOX_PROBE_FAILED') {
  const context = stageFixture('deliver');
  const receipts = {}, objects = {}, calls = [];
  const store = {
    load: async () => structuredClone(receipts),
    get: async hash => structuredClone(objects[hash]),
    put: async value => {
      const hash = digest(value);
      objects[hash] = structuredClone(value);
      return hash;
    },
  };
  objects[context.shape.hash] = context.shape.body;
  for (const stage of ['shape', 'validate-shape', 'publish-shape'])
    receipts[stage] = structuredClone(context.receipts[stage]);
  const handlers = stageHandlers({
    store, workspace: { discardWriterGit: async () => {} },
    persistReport: async () => {},
  });
  const stopped = await handlers.deliver.readBack(context, {
    status: 'interrupted', code, executionId: context.execution.id,
    terminationHash: 'a'.repeat(64), artifacts: { shapeHash: context.shape.hash },
  });
  receipts.deliver = {
    stage: 'deliver', execution: context.execution, ...stopped,
  };
  const options = {
    store,
    inspect: async () => { calls.push('inspect'); },
    wait: async () => assert.fail('No retry wait expected'),
    execute: async stage => {
      calls.push(stage);
      const receipt = { stage, outcome: stageSuccess[stage] };
      receipts[stage] = receipt;
      return { stage, status: 'completed', receiptHash: await store.put(receipt) };
    },
  };
  const replaceProof = async change => {
    const receipt = receipts.deliver;
    const proof = objects[receipt.references[0].slice('evidence:'.length)];
    change(proof);
    receipt.references = ['evidence:' + await store.put(proof)];
  };
  return { receipts, objects, calls, options, replaceProof };
}

test('Core preflight receipts re-enter Deliver after current inspection', async () => {
  for (const code of Object.keys(codexPreflightExits)) {
    const f = await fixture(code);
    assert.equal(f.receipts.deliver.report.producer, 'core-native');
    assert.equal((await continueStages(f.options)).stage, 'close');
    assert.deepEqual(f.calls.slice(0, 2), ['inspect', 'deliver']);
    for (const stage of ['shape', 'validate-shape', 'publish-shape'])
      assert.equal(f.calls.includes(stage), false);
    for (const stage of ['commit-pr', 'merge', 'close'])
      assert.equal(f.calls.filter(call => call === stage).length, 1);
    const count = f.calls.length;
    assert.equal((await continueStages(f.options)).code, 'DELIVERY_ALREADY_RECORDED');
    assert.equal(f.calls.length, count);
  }
});

test('missing historical termination digest does not block a Core preflight',
  async () => {
    const f = await fixture();
    await f.replaceProof(proof => { delete proof.terminationHash; });
    delete f.receipts.deliver.report;
    assert.equal((await continueStages(f.options)).stage, 'close');
    assert.deepEqual(f.calls.slice(0, 2), ['inspect', 'deliver']);
  });

test('startup classification requires stored evidence for the same execution',
  async () => {
    for (const change of [
      f => { f.receipts.deliver.code = 'SANDBOX_PROBE_FAILED';
        f.receipts.deliver.references = []; },
      f => { f.receipts.deliver.references = ['evidence:' + 'b'.repeat(64)]; },
      f => { delete f.receipts.deliver.execution; },
      f => f.replaceProof(proof => { proof.executionId = 'another-execution'; }),
      f => f.replaceProof(proof => { proof.code = 'ACTOR_CHOSEN_STARTUP_ERROR'; }),
    ]) {
      const f = await fixture();
      await change(f);
      const result = await continueStages(f.options);
      assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
      assert.equal(result.stage, 'deliver');
      assert.deepEqual(f.calls, []);
    }
  });

test('started-role failures retain their existing termination requirement',
  async () => {
    for (const code of ['PROCESS_TIMEOUT', 'AGENT_PROCESS_FAILED',
      'CODEX_IDLE_TIMEOUT']) {
      const f = await fixture(code);
      await f.replaceProof(proof => { delete proof.terminationHash; });
      assert.equal((await continueStages(f.options)).code,
        'STAGE_REQUIRES_CORRECTION');
      assert.deepEqual(f.calls, []);
    }
  });

test('preflight recovery does not restart another role or product findings',
  async () => {
    for (const stage of ['shape', 'validate-shape', 'accept']) {
      const f = await fixture();
      const stopped = structuredClone(f.receipts.deliver);
      for (const name of Object.keys(f.receipts)) delete f.receipts[name];
      const earlier = stageFixture(stage).receipts;
      for (const name of Object.keys(stageSuccess)) {
        if (name === stage) break;
        f.receipts[name] = structuredClone(earlier[name]);
        if (f.receipts[name]?.artifacts.candidateHash) {
          const candidate = stageFixture().candidate;
          f.objects[digest(candidate)] = candidate;
        }
      }
      f.receipts[stage] = { ...stopped, stage };
      const result = await continueStages(f.options);
      assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
      assert.equal(result.stage, stage);
      assert.deepEqual(f.calls, []);
    }
    const f = await fixture();
    f.receipts.deliver.references = ['fixture:agent-product-failure'];
    f.receipts.deliver.findings = ['Implementation does not satisfy the requirement.'];
    assert.equal((await continueStages(f.options)).code, 'STAGE_REQUIRES_CORRECTION');
    assert.deepEqual(f.calls, []);
  });

test('a failed current inspection or admission does not grant startup recovery',
  async () => {
    const f = await fixture();
    const pause = Object.assign(new Error('Owner paused the Issue'),
      { code: 'OWNER_PAUSED' });
    f.options.inspect = async () => { throw pause; };
    await assert.rejects(continueStages(f.options), error => error === pause);
    assert.deepEqual(f.calls, []);
    const g = await fixture();
    g.options.execute = async stage => {
      g.calls.push(stage);
      return { stage, status: 'denied', code: 'OWNER_PAUSED' };
    };
    assert.equal((await continueStages(g.options)).code, 'OWNER_PAUSED');
    assert.deepEqual(g.calls, ['inspect', 'deliver']);
  });

test('a fresh startup failure and an unknown effect do not loop internally',
  async () => {
    for (const code of ['STAGE_REQUIRES_CORRECTION', 'EXTERNAL_EFFECT_UNKNOWN']) {
      const f = await fixture();
      f.options.execute = async stage => {
        f.calls.push(stage);
        return { stage, status: code === 'EXTERNAL_EFFECT_UNKNOWN'
          ? 'pending' : 'denied', code,
        receiptHash: await f.options.store.put(f.receipts.deliver) };
      };
      const result = await continueStages(f.options);
      assert.equal(result.code, code);
      assert.equal(result.stage, 'deliver');
      assert.deepEqual(f.calls, ['inspect', 'deliver']);
    }
  });

test('a transient current inspection retries before admitting recovered Deliver',
  async () => {
    const f = await fixture();
    let observations = 0;
    const waits = [];
    f.options.inspect = async () => {
      f.calls.push('inspect');
      if (++observations === 1)
        throw Object.assign(new Error('Temporary GitHub read failure'),
          { transientGitHubRead: true, status: 503 });
    };
    f.options.wait = async delay => { waits.push(delay); };
    assert.equal((await continueStages(f.options)).stage, 'close');
    assert.deepEqual(f.calls.slice(0, 3), ['inspect', 'inspect', 'deliver']);
    assert.equal(waits.length, 1);
    assert.equal(f.calls.filter(stage => stage === 'commit-pr').length, 1);
  });
