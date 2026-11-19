import test from 'node:test';
import assert from 'node:assert/strict';
import { relayControllerRequest } from '../src/host-relay.mjs';

test('lost privileged handoff responses stay Pending without retry', async () => {
  for (const fault of ['PROCESS_TIMEOUT', 'PROCESS_FAILED', 'invalid-json']) {
    let calls = 0;
    const result = await relayControllerRequest(
      { command: 'stage', stage: 'continue' },
      999,
      async () => {
        calls += 1;
        if (fault === 'invalid-json') return { stdout: Buffer.from('{') };
        throw Object.assign(new Error(fault), { code: fault });
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
  }
});

test('one fixed command receives stdin and its native result is preserved', async () => {
  const request = { command: 'dispatch-event', event: '{"issue":{}}' };
  const result = await relayControllerRequest(request, 999, async (exe, args, opts) => {
    assert.equal(exe, '/usr/bin/sudo');
    assert.deepEqual(args, [
      '-n',
      '-u',
      '#999',
      '--',
      '/opt/nibfin/core/bin/nibfin-controller',
    ]);
    assert.deepEqual(JSON.parse(opts.input), request);
    assert.deepEqual(Object.keys(opts.env).sort(), ['LANG', 'PATH']);
    return { stdout: Buffer.from('{"status":"scheduled","code":"READ_BACK"}') };
  });
  assert.equal(result.status, 'scheduled');
});

test('lost responses reconcile through the Controller contract', async () => {
  const { dispatchControllerRequest } = await import('../src/controller-dispatch.mjs');
  const { reconcileDelivery } = await import('../src/stage-reconciliation.mjs');
  const { reconciliationFixture } = await import('./reconciliation-fixture.mjs');
  const { validateControllerRequest } = await import('../src/controller-contract.mjs');
  for (const fault of ['transport', 'json', 'status']) {
    const f = reconciliationFixture();
    const calls = [];
    const request = { schemaVersion: 1, command: 'stage', issue: '443',
      stage: 'continue', context: {
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '21',
        GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
        RUNNER_ENVIRONMENT: 'self-hosted',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic',
      } };
    const result = await relayControllerRequest(request, 999, async (_, __, options) => {
      const parsed = validateControllerRequest(JSON.parse(options.input));
      calls.push(parsed.command);
      if (parsed.command === 'stage') {
        if (fault === 'transport') throw new Error('private stderr');
        return { stdout: Buffer.from(fault === 'json' ? '{' : '{}') };
      }
      assert.deepEqual(parsed, { ...request, command: 'reconcile-stage' });
      const recovered = await dispatchControllerRequest(parsed, 997, {
        stage: () => assert.fail('Original delivery must never be replayed'),
        event: () => assert.fail('No dispatch mutations during reconciliation'),
        reconcile: (issue, stage, context, uid) => {
          assert.equal(issue, request.issue);
          assert.equal(stage, request.stage);
          assert.deepEqual(context, request.context);
          assert.equal(uid, 997);
          return reconcileDelivery(f.input, f.dependencies);
        },
      });
      return { stdout: Buffer.from(JSON.stringify(recovered)) };
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.terminalStage, 'close');
    assert.deepEqual(calls, ['stage', 'reconcile-stage']);
  }
});

test('unproven reconciliation gives sanitized reasons without retry claims', async () => {
  for (const second of ['transport', '{', '{}', '{"status":"denied"}',
    '{"status":"completed"}']) {
    let calls = 0;
    const result = await relayControllerRequest({ command: 'stage', stage: 'continue' },
      999, async () => {
        if (++calls === 1 || second === 'transport') throw new Error('private data');
        return { stdout: Buffer.from(second) };
      });
    assert.equal(calls, 2);
    assert.equal(result.status, 'pending');
    assert.equal(result.initialFailure, 'TRANSPORT_FAILED');
    assert.equal(Object.hasOwn(result, 'retrySettled'), false);
    assert.equal(JSON.stringify(result).includes('private data'), false);
    assert.ok(result.reconciliationFailure);
  }
});

test('stage responses pass through and failed events do not reconcile', async () => {
  for (const status of ['completed', 'denied', 'pending']) {
    let calls = 0;
    const expected = { status, code: 'NATIVE' };
    assert.deepEqual(await relayControllerRequest({ command: 'stage' }, 999,
      async () => { calls++; return { stdout: Buffer.from(JSON.stringify(expected)) }; }),
    expected);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await relayControllerRequest({ command: 'dispatch-event' }, 999,
    async () => { calls++; throw new Error('transport'); });
  assert.equal(calls, 1);
});

test('lost review correction response returns the verified bounded result', async t => {
  const { premergeFixture } = await import('./reconciliation-fixture.mjs');
  const { reconcileDelivery } = await import('../src/stage-reconciliation.mjs');
  const f = await premergeFixture(t);
  const request = { command: 'stage', stage: 'continue', issue: '443',
    context: { unchanged: 'synthetic' } };
  const calls = [];
  const result = await relayControllerRequest(request, 999, async (_, __, options) => {
    const value = JSON.parse(options.input);
    calls.push(value);
    if (calls.length === 1) throw new Error('response lost');
    return { stdout: Buffer.from(JSON.stringify(
      await reconcileDelivery(f.input, f.dependencies))) };
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
  assert.equal(result.terminalStage, 'review-pr');
  assert.equal(result.resultHash, (await f.evidence.read()).hash);
  assert.equal(result.retrySettled, undefined);
  assert.deepEqual(calls, [request, { ...request, command: 'reconcile-stage' }]);
});

test('recovered results require an explicit validated form', async () => {
  const valid = { schemaVersion: 1, stage: 'continue', terminalStage: 'review-pr',
    status: 'denied', code: 'STAGE_REQUIRES_CORRECTION', recoveredResult: true,
    resultHash: 'a'.repeat(64), receiptHash: 'b'.repeat(64) };
  for (const change of [
    { recoveredResult: undefined }, { resultHash: 'invalid' },
    { stage: 'review-pr' }, { terminalStage: 'merge', status: 'completed' },
    { terminalStage: 'close' },
    { terminalStage: 'unknown' }, { status: 'scheduled' }, { code: 'private text' },
    { receiptHash: 'invalid' },
  ]) {
    let calls = 0;
    const result = await relayControllerRequest({ command: 'stage', stage: 'continue' },
      999, async () => {
        if (++calls === 1) throw new Error('lost');
        return { stdout: Buffer.from(JSON.stringify({ ...valid, ...change })) };
      });
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
  }
});
