import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWrites } from '../src/native-writes.mjs';
import { decideStage } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

for (const changedByAnotherWriter of [false, true]) {
  test(`PR repair read-back with foreign head: ${changedByAnotherWriter}`, async () => {
    const context = stageFixture('commit-pr');
    const branch = 'nibfin/issue-2-444444444444';
    context.pr.headBranch = branch;
    const committed = {
      head: 'a'.repeat(40),
      base: context.candidate.base,
      tree: context.candidate.tree,
    };
    let writes = 0, waits = 0;
    const assembly = nativeWrites({
      reader: { get: async () => ({
        node_id: context.pr.id, state: 'open',
        head: {
          sha: !writes ? context.pr.head :
            changedByAnotherWriter ? 'b'.repeat(40) :
              waits === 0 ? context.pr.head : committed.head,
          ref: branch, repo: { id: 10 },
        },
        base: { repo: { id: 10 } },
      }) },
      token: 'fixture-token',
      clock: () => now,
      observe: async () => structuredClone(context),
      wait: async () => { waits++; },
      workspace: { push: async () => { writes++; } },
    });
    const result = assembly.publishCommit(
      context, decideStage('commit-pr', context, now), committed,
    );
    if (changedByAnotherWriter) {
      await assert.rejects(result, /PR_REPAIR_READBACK_UNKNOWN/);
      assert.equal(waits, 0);
    } else {
      assert.equal((await result).head, committed.head);
      assert.equal(waits, 1);
    }
    assert.equal(writes, 1);
  });
}
