import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  recoverSelectedDeliverFence, recoverAdoptedDeliverFence,
} from '../src/recover-deliver-fence.mjs';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';

for (const staged of [false, true]) {
  for (const additional of [false, true]) {
    for (const failAt of [undefined, 1, 2, 3, 4]) {
      const label = `${staged ? 'staged' : 'installed'}; ` +
        `additional slot ${additional}; inspection failure ${failAt ?? 'none'}`;
      test(label, async t => {
        const f = await deliverRecoveryFixture(t);
        const loads = [];
        const inspections = [];
        const selected = staged ? 'installed' : 'local';
        const initial = additional ? {
          ...f.context,
          adopted: { ...f.context.adopted,
            runner: { ...f.runner, runnerId: 41 } },
        } : f.context;
        f.context.host.sharedRunner = { additionalRunner: { id: 40, uid: 1002 } };
        let recorded = false;
        f.options.afterRecord = async () => { recorded = true; };
        const implementation = name => ({
          loadHostAdoption: async (...args) => {
            loads.push({ name, args });
            assert.equal(name, selected);
            return args[2] === undefined ? initial : f.context;
          },
          inspectHostAdoption: async context => {
            assert.equal(context, f.context);
            inspections.push(name);
            assert.equal(name, selected);
            if (inspections.length === 4) assert.equal(recorded, true);
            if (inspections.length === failAt)
              throw Object.assign(new Error('adoption changed'),
                { code: 'INVALID_HOST_ADOPTION' });
          },
        });
        const local = implementation('local');
        const installed = implementation('installed');
        let recoveryCalls = 0;
        const result = await recoverSelectedDeliverFence('2', {
          directory: staged ? '/tmp/verified-stage' : '/opt/nibfin/core',
          target: '10', local, installed,
          recover: async (context, options) => {
            recoveryCalls++;
            assert.equal(context, f.context);
            const expected = staged ? installed : local;
            assert.equal(options.inspectAdoption, expected.inspectHostAdoption);
            return recoverAdoptedDeliverFence(context, { ...f.options, ...options });
          },
        });
        assert.equal(recoveryCalls, 1);
        assert.deepEqual(loads, [
          { name: selected, args: ['2', '10', undefined, true] },
          ...(additional ? [{ name: selected, args: ['2', '10', 1002, true] }] : []),
        ]);
        assert.deepEqual(inspections, Array(failAt ?? 4).fill(selected));
        if (failAt) {
          assert.deepEqual(result, { status: 'pending', code: 'INVALID_HOST_ADOPTION' });
          assert.equal(await readFile(f.fencePath, 'utf8'), f.fenceBytes);
        } else {
          assert.equal(result.status, 'completed');
          await assert.rejects(readFile(f.fencePath), { code: 'ENOENT' });
        }
      });
    }
  }
}
