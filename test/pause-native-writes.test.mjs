import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWrites } from '../src/native-writes.mjs';
import { decideStage } from '../src/stages.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';

for (const revoke of [false, true]) {
  test(`publication settles with pause; revocation=${revoke}`, async () => {
    const context = stageFixture('publish-shape');
    context.issue.body = context.shape.body;
    context.issue.labels.push({ name: 'shaped' });
    const decision = decideStage('publish-shape', context, now);
    assert.equal(decision.status, 'allowed');
    const live = structuredClone(context);
    live.issue.labels.push({ name: 'pause' });
    live.pause = { ...live.pause, status: 'paused', effective: true, visible: true };
    if (revoke) live.dependencies.ready = false;
    const assembly = nativeWrites({
      token: 'fixture-token',
      clock: () => now,
      observe: async () => live,
      reader: {
        repository: async () => ({
          id: 10,
          full_name: 'example/core',
          private: false,
        }),
        issue: async () => live.issue,
        get: async () => {
          throw new Error('Unexpected');
        },
      },
      fetcher: async () => Response.json({ id: 1, type: 'User' }),
      workspace: { push: async () => assert.fail('No push') },
    });
    const writer = assembly.writerFor('publish-shape', context, decision);
    const action = writer.confirmShape({
      issue: context.approval.record.issue,
      expectedLabels: context.issue.labels.map((label) => label.name),
      expectedBodyHash: digest(context.issue.body),
      body: context.issue.body,
    });
    if (revoke) await assert.rejects(action, /WRITE_AUTHORITY_CHANGED/);
    else assert.equal((await action).bodyHash, digest(context.issue.body));
    assert.equal(decideStage('publish-shape', live, now).code, 'ISSUE_PAUSED');
  });
}

for (const stage of ['publish-shape', 'close']) {
  for (const initiallyPaused of [false, true]) {
    for (const raceAt of [1, 2]) {
      const faults =
        raceAt === 2 && !initiallyPaused
          ? [null, 'revoked', 'body', 'lost-label', 'disconnect']
          : [null];
      for (const fault of faults) {
        test(
          `${stage} preserves pause change at guard ${raceAt}; ` +
            `initially paused=${initiallyPaused}; fault=${fault}`,
          async () => {
            const context = stageFixture(stage);
            const live = structuredClone(context);
            live.issue.labels.push({ name: 'unrelated' });
            context.issue.labels.push({ name: 'unrelated' });
            // Pause arrives only after stage admission, so settlement remains valid.
            const decision = decideStage(stage, context, now);
            assert.equal(decision.status, 'allowed');
            if (initiallyPaused) live.issue.labels.push({ name: 'pause' });
            let guards = 0;
            const calls = [];
            const assembly = nativeWrites({
              token: 'fixture-token',
              clock: () => now,
              observe: async () => {
                if (++guards === raceAt) {
                  live.issue.labels = live.issue.labels.filter(
                    (x) => x.name !== 'pause',
                  );
                  if (!initiallyPaused) live.issue.labels.push({ name: 'pause' });
                }
                if (guards === 2) {
                  if (fault === 'revoked') live.dependencies.ready = false;
                  if (fault === 'body') live.issue.body = 'Concurrent edit';
                  if (fault === 'lost-label')
                    live.issue.labels = live.issue.labels.filter(
                      (x) => x.name !== (stage === 'close' ? 'delivered' : 'shaped'),
                    );
                }
                return structuredClone(live);
              },
              reader: {
                repository: async () => ({
                  id: 10,
                  full_name: 'example/core',
                  private: false,
                }),
                issue: async () => structuredClone(live.issue),
                get: async () => assert.fail('Unexpected GET'),
              },
              fetcher: async (url, options) => {
                if (url.endsWith('/user'))
                  return Response.json({ id: 1, type: 'User' });
                const body = JSON.parse(options.body);
                calls.push({ method: options.method, body });
                if (fault === 'disconnect' && calls.length === 2)
                  throw new Error('Lost response');
                if (options.method === 'POST') {
                  assert.ok(url.endsWith('/labels'));
                  live.issue.labels.push(...body.labels.map((name) => ({ name })));
                } else {
                  assert.equal(Object.hasOwn(body, 'labels'), false);
                  Object.assign(live.issue, body);
                }
                return Response.json(live.issue);
              },
              workspace: { push: async () => assert.fail('No push') },
            });
            const writer = assembly.writerFor(stage, context, decision);
            const request = {
              issue: context.approval.record.issue,
              expectedBodyHash: digest(context.issue.body),
              expectedLabels: context.issue.labels.map((x) => x.name),
              body: context.shape.body,
            };
            const action =
              stage === 'close'
                ? writer.closeDelivered(request)
                : writer.publishShape(request);
            if (fault) {
              const code =
                fault === 'lost-label'
                  ? 'WRITE_SETTLEMENT_MISMATCH'
                  : fault === 'disconnect'
                    ? 'EXTERNAL_EFFECT_UNKNOWN'
                    : 'WRITE_AUTHORITY_CHANGED';
              await assert.rejects(action, { code });
              assert.equal(calls.length, fault === 'disconnect' ? 2 : 1);
              assert.equal(live.issue.state, 'open');
              return;
            }
            await action;
            assert.equal(guards, 2);
            assert.equal(calls.length, 2);
            assert.equal(
              live.issue.labels.some((x) => x.name === 'pause'),
              !initiallyPaused,
            );
            assert.ok(live.issue.labels.some((x) => x.name === 'unrelated'));
            assert.equal(live.issue.body, context.shape.body);
            assert.equal(live.issue.state, stage === 'close' ? 'closed' : 'open');
            assert.deepEqual(calls[0].body.labels, [
              stage === 'close' ? 'delivered' : 'shaped',
            ]);
          },
        );
      }
    }
  }
}
