import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverEngine } from '../src/engine-install.mjs';
import { verifyManagedEngine } from '../src/engine-verify.mjs';
import { engineFixture } from './engine-fixture.mjs';

test('resource preparation verifies existing Engine without starting or repairing it',
  async () => {
    const io = engineFixture();
    await assert.rejects(verifyManagedEngine(io),
      { code: 'ENGINE_PREPARATION_NOT_COMPLETE' });
    assert.deepEqual(io.commands, []);
    await deliverEngine(io);
    const previous = structuredClone(io.commands);
    const state = structuredClone(io.state);
    const result = await verifyManagedEngine(io);
    assert.deepEqual(result.accounts, state.accounts);
    assert.deepEqual(result.namespace, state.allocation.namespace);
    assert.deepEqual(io.commands, previous);
    assert.deepEqual(io.state, state);
    io.units['nibfin-engine.service'].ActiveState = 'inactive';
    await assert.rejects(verifyManagedEngine(io), { code: 'ENGINE_NOT_RUNNING' });
    assert.deepEqual(io.commands, previous);
  });
