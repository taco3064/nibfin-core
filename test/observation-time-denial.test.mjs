import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeStageExecutor } from '../src/native-stage.mjs';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';

const deny = () => {
  throw Object.assign(new Error('must-not-appear: synthetic-private-credential'),
    { code: 'OIDC_NOT_YET_ACTIVE' });
};

test('native admission exposes signed-time reason before any effect', async t => {
  const f = await nativeFixture(t);
  const executor = nativeStageExecutor({ ...f.adapters, inspectCaller: deny,
    agent: { run: deny }, workspace: { push: deny },
    sandbox: { execute: deny }, token: 'synthetic-token' });
  const result = await executor.run({ schemaVersion: 1, stage: 'shape' });
  assert.deepEqual(result, { schemaVersion: 1, stage: 'shape',
    status: 'denied', code: 'OIDC_NOT_YET_ACTIVE' });
  assert.equal(JSON.stringify(result).includes('must-not-appear'), false);
});

test('runtime preserves bounded time reason without invoking writes', async () => {
  let effects = 0;
  const unexpected = () => { effects++; throw Error('Unexpected effect'); };
  const runtime = new StageRuntime({ observe: deny,
    handlers: { shape: { perform: unexpected, readBack: unexpected } },
    journal: { run: unexpected }, receipts: { append: unexpected } });
  const result = await runtime.run({ schemaVersion: 1, stage: 'shape' });
  assert.deepEqual(result, { schemaVersion: 1, stage: 'shape',
    status: 'denied', code: 'OIDC_NOT_YET_ACTIVE' });
  assert.equal(effects, 0);
});
