import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWrites } from '../src/native-writes.mjs';
import { decideStage } from '../src/stages.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { digest } from '../src/identity.mjs';

test('admitted publication preserves a new pause while retaining fresh write authority',
  async () => {
    for (const revoke of [false, true]) {
      const admitted = stageFixture('publish-shape');
      const decision = decideStage('publish-shape', admitted, now);
      assert.equal(decision.status, 'allowed');
      const current = structuredClone(admitted);
      current.issue.labels.push({ name: 'pause' });
      current.pause.status = 'paused';
      assert.equal(decideStage('publish-shape', current, now).status, 'denied');
      if (revoke) current.approval.record.operations = [];
      let writes = 0;
      const reader = { get: async () => assert.fail('Unexpected reader GET'),
        repository: async () => ({ id: 10, full_name: 'example/core', private: false }),
        issue: async () => structuredClone(current.issue) };
      const assembly = nativeWrites({ reader, token: 'fixture-only',
        clock: () => now, observe: async () => structuredClone(current),
        workspace: { push: async () => assert.fail('No push for Shape publication') },
        fetcher: async (url, options) => {
          if (url === 'https://api.github.com/user')
            return { ok: true, json: async () => ({ id: 1, type: 'User' }) };
          writes++;
          assert.equal(options.method, 'PATCH');
          const body = JSON.parse(options.body);
          current.issue.body = body.body;
          current.issue.labels = body.labels.map(name => ({ name }));
          return { ok: true, json: async () => current.issue };
        } });
      const writer = assembly.writerFor('publish-shape', admitted, decision);
      const write = writer.publishShape({ issue: admitted.approval.record.issue,
        expectedBodyHash: digest(admitted.issue.body), expectedLabels: ['scope'],
        body: admitted.shape.body });
      if (revoke) {
        await assert.rejects(write, /WRITE_AUTHORITY_CHANGED/);
        assert.equal(writes, 0);
      } else {
        await write;
        assert.equal(writes, 1);
        assert.deepEqual(current.issue.labels.map(label => label.name),
          ['pause', 'scope', 'shaped']);
      }
    }
  });
