import test from 'node:test';
import assert from 'node:assert/strict';
import { StageRuntime } from '../src/stage-runtime.mjs';
import { nativeStageExecutor } from '../src/native-stage.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { pendingCIObservation } from '../src/github-ci.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

const codes = ['USER_MCP_DISCOVERY_UNRESOLVED',
  'USER_MCP_DISCOVERY_SESSION_UNRESOLVED', 'USER_MCP_CONFIG_TERMINATION_UNKNOWN'];
const request = { schemaVersion: 1, stage: 'shape' };
test('unknown MCP during admission cannot become a retryable denial', async () => {
  let reads = 0;
  const code = 'USER_MCP_DISCOVERY_UNRESOLVED';
  const runtime = new StageRuntime({
    observe: async () => {
      if (++reads === 1) return stageFixture();
      throw Object.assign(Error(code), { code });
    },
    clock: () => now,
    handlers: { shape: { perform: async () => {}, readBack: async () => {} } },
    receipts: { append: async () => {} },
    journal: { async run(_request, callbacks) {
      try { await callbacks.admit(); }
      catch { return { status: 'denied', code: 'ADMISSION_FAILED' }; }
    } },
  });
  assert.deepEqual(await runtime.run(request), {
    schemaVersion: 1, stage: 'shape', status: 'pending', code,
  });
});
test('unknown MCP observations remain Pending before handlers and retain the fence',
  async () => {
    for (const code of codes) {
      let called = false;
      const runtime = new StageRuntime({
        observe: async () => { throw Object.assign(Error(code), { code }); },
        handlers: { shape: { perform: async () => { called = true; },
          readBack: async () => {} } },
        journal: { run: async () => { called = true; } },
        receipts: { append: async () => {} },
      });
      const result = await runtime.run(request);
      assert.equal(result.status, 'pending');
      assert.equal(result.code, code);
      assert.equal(called, false);
      // CI waits release/retry; unresolved MCP observations must never use it.
      assert.equal(pendingCIObservation(code), false);
    }
  });

test('native initial MCP observation preserves the unresolved status and cause', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await nativeFixture(t);
  for (const code of codes) {
    const executor = nativeStageExecutor({
      ...fixture.adapters,
      inspectIsolation: async () => { throw Object.assign(Error(code), { code }); },
      agent: { run: async () => { throw Error('Must not run'); } },
      workspace: { push: async () => {} },
      sandbox: { execute: async () => {} },
    });
    const result = await executor.run(request);
    assert.equal(result.status, 'pending');
    assert.equal(result.code, code);
  }
});
