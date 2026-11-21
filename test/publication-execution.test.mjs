import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './native-observer-fixture.mjs';
import { nativeObserver } from '../src/native-observer.mjs';
import { stageHandlers } from '../src/stage-handlers.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { publicationFixture } from './publication-wake-fixture.mjs';
import { digest } from '../src/identity.mjs';
import { decideStage } from '../src/stages.mjs';
import { now } from './approval-fixture.mjs';

for (const continuation of [true, false]) {
  test(`only an admitted continuing invocation carries provenance (${continuation})`,
    async t => {
      const f = await nativeFixture(t);
      f.adapters.config.continuation = continuation;
      const context = await nativeObserver(f.adapters)('shape');
      assert.deepEqual(context.publicationExecution,
        continuation ? f.adapters.config.runner : undefined);
    });
}

test('publication handler retains operation-scoped provenance with its receipt',
  async () => {
    const context = stageFixture('publish-shape');
    const p = publicationFixture();
    context.publicationExecution = p.runner;
    const objects = new Map();
    const result = { bodyHash: context.shape.hash, reference: context.issue.url,
      publication: { ...p.publication.transition, after: context.shape.hash } };
    const handlers = stageHandlers({ store: { put: async value => {
      const hash = digest(value);
      objects.set(hash, structuredClone(value));
      return hash;
    } } });
    const receipt = await handlers['publish-shape'].readBack(context, result);
    assert.deepEqual(objects.get(receipt.artifacts.publicationHash), {
      issue: context.approval.record.issue, shapeHash: context.shape.hash,
      transition: result.publication, execution: context.execution, runner: p.runner,
    });
    delete context.publicationExecution;
    assert.equal((await handlers['publish-shape'].readBack(context, result))
      .artifacts.publicationHash, undefined);
    context.publicationExecution = p.runner;
    delete result.publication;
    assert.equal((await handlers['publish-shape'].readBack(context, result))
      .artifacts.publicationHash, undefined);
  });

for (const provenance of [true, false]) {
  test(`published receipt admits ordinary continuation (provenance=${provenance})`,
    async () => {
      const context = stageFixture('deliver');
      if (provenance) context.publicationExecution = publicationFixture().runner;
      const handlers = stageHandlers({ store: { put: async value => digest(value) } });
      const result = await handlers['publish-shape'].readBack(context, {
        bodyHash: context.shape.hash, reference: context.issue.url,
        publication: publicationFixture().publication.transition,
      });
      const receipt = context.receipts['publish-shape'];
      Object.assign(receipt, result);
      assert.equal(Boolean(receipt.artifacts.publicationHash), provenance);
      const decision = decideStage('deliver', context, now);
      assert.equal(decision.status, 'allowed', decision.code);
      assert.deepEqual(decision.artifacts, { shapeHash: context.shape.hash });
      if (provenance) {
        receipt.artifacts.publicationHash = 'invalid';
        assert.equal(decideStage('deliver', context, now).status, 'denied');
      }
    });
}
