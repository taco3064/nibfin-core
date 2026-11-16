import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relayFixture, origin, wakeEvent } from './relay-fixture.mjs';
import { writeRelayState, withRelayGate } from '../src/relay-state.mjs';

const key = { repositoryId: 1, runId: 30, attempt: 1 };

test('authenticated original, rerun and restart dispatch once using the native envelope',
  async t => {
    const fixture = await relayFixture(t, { latestAttempt: 2 });
    assert.equal((await fixture.process()).status, 'consumed');
    assert.equal(fixture.posts, 1);
    assert.equal(fixture.sent.inputs.stage, 'wake');
    assert.equal(fixture.sent.inputs.issue_id, 'I_example');
    const envelope = JSON.parse(fixture.sent.inputs.wake_event);
    assert.equal(envelope.runId, 30);
    assert.equal(envelope.event.issue.number, 3);
    assert.deepEqual(fixture.storage, [{ 'Accept-Encoding': 'identity' }]);
    assert.equal((await fixture.process()).code, 'RELAY_REPLAY');
    assert.equal(fixture.posts, 1);
  });

for (const [name, options] of [
  ['failed original despite successful rerun', { latestAttempt: 2,
    original: { conclusion: 'failure' } }],
  ['forged source', { original: { referenced_workflows: [] } }],
  ['forged workflow', { original: { workflow_id: 200 } }],
  ['private repository', { repository: { private: true } }],
  ['revoked permission', { permission: 'read' }],
  ['changed Controller', { actor: { id: 7, type: 'User' } }],
  ['wrong assignee', { issue: { assignees: [{ id: 7, login: 'other', type: 'User' }] } }],
  ['unresolved dependency', { dependencies: [{ state: 'open', labels: [] }] }],
  ['inactive issue', { issue: { state: 'closed' } }],
  ['wrong artifact attempt', { artifact: { name: 'nibfin-issue-wake-v1-2' } }],
  ['artifact from rerun', { artifact: { updated_at: '2026-11-16T01:00:00Z' } }],
  ['incomplete artifact listing', { incomplete: true }],
  ['digest mismatch', { artifact: { digest: 'sha256:' + 'a'.repeat(64) } }],
  ['unsafe artifact redirect', { location: 'https://attacker.example/secret' }],
]) test(`${name} cannot dispatch`, async t => {
  const fixture = await relayFixture(t, options);
  try { await fixture.process(); }
  catch { /* Refusal may throw before durable intent. */ }
  assert.equal(fixture.posts, 0);
  const record = await fixture.journal.read(key);
  assert.ok(!record || record.status === 'skipped');
});

test('closed and Pause events keep specialized downstream routing', async t => {
  for (const action of ['closed', 'labeled', 'unlabeled']) {
    const fixture = await relayFixture(t, { event: wakeEvent(action),
      issue: { state: 'closed',
        labels: ['scope', 'shaped', 'delivered'].map(name => ({ name })) },
      dependencies: [{ state: 'open' }] });
    assert.equal((await fixture.process()).status, 'consumed');
    assert.equal(fixture.posts, 1);
  }
});

for (const options of [{ artifact: { expired: true } }, { missing: true }])
  test('fresh confirmed expiry/deletion is terminal and never dispatches', async t => {
    const fixture = await relayFixture(t, options);
    assert.equal((await fixture.process()).code, 'RELAY_ORIGINAL_EXPIRED');
    assert.equal((await fixture.process()).code, 'RELAY_REPLAY');
    assert.equal(fixture.posts, 0);
    assert.equal((await fixture.journal.read(key)).status, 'skipped');
  });

for (const status of [403, 429, 504])
  test(`HTTP ${status} is unavailable evidence, never expiry`, async t => {
    const fixture = await relayFixture(t, { intercept: url => {
      if (url.pathname.endsWith('/artifacts')) return new Response(null, { status });
    } });
    await assert.rejects(fixture.process());
    assert.equal(await fixture.journal.read(key), null);
    assert.equal(fixture.posts, 0);
  });

test('offline recovery within retention consumes; confirmed expiry cannot be replaced',
  async t => {
    let offline = true;
    const fixture = await relayFixture(t, { intercept: url => {
      if (offline && url.pathname.endsWith('/artifacts')) throw new Error('timeout');
    } });
    await assert.rejects(fixture.process());
    offline = false;
    assert.equal((await fixture.process()).status, 'consumed');
    assert.equal(fixture.posts, 1);
    const expired = await relayFixture(t, { missing: true, latestAttempt: 2 });
    assert.equal((await expired.process()).code, 'RELAY_ORIGINAL_EXPIRED');
    assert.equal(expired.posts, 0);
  });

for (const response of ['lost', 'absent'])
  test(`${response} dispatch ID stays pending after restart despite one matching run`,
    async t => {
      const fixture = await relayFixture(t, { post: () => {
        if (response === 'lost') throw new Error('lost response with storage secret');
        return new Response('{}', { status: 200 });
      } });
      assert.equal((await fixture.process()).status, 'pending');
      assert.equal((await fixture.journal.read(key)).status, 'pending');
      assert.equal((await fixture.process()).status, 'pending');
      assert.equal((await fixture.journal.read(key)).runId, undefined);
      assert.equal(fixture.posts, 1);
    });

for (const ids of [[], [60], [60, 61]])
  test(`${ids.length} matches cannot reconcile or authorize another POST`, async t => {
    const fixture = await relayFixture(t, { post: () => { throw new Error('lost'); } });
    await fixture.process();
    fixture.ids = ids;
    for (let restart = 0; restart < 2; restart++)
      assert.equal((await fixture.process()).status, 'pending');
    assert.equal(fixture.posts, 1);
  });

test('a generic or wrong Issue run cannot reconcile unknown effects', async t => {
  const fixture = await relayFixture(t, { post: () => { throw new Error('lost'); },
    nativeRun: { display_title: 'Nibfin 1 #99 wake' } });
  await fixture.process();
  assert.equal((await fixture.process()).status, 'pending');
  assert.equal(fixture.posts, 1);
});

test('returned native ID is durable before failed exact readback and retained on restart',
  async t => {
    let fail = true;
    const fixture = await relayFixture(t, { intercept: url => {
      if (url.pathname.endsWith('/runs/60') && fail) throw new Error('offline');
    } });
    assert.equal((await fixture.process()).status, 'pending');
    assert.equal((await fixture.journal.read(key)).runId, 60);
    fail = false;
    assert.equal((await fixture.process()).status, 'consumed');
    assert.equal(fixture.posts, 1);
  });

for (const nativeRun of [{ actor: { id: 99 } }, { head_sha: 'c'.repeat(40) },
  { workflow_id: 99 }, { head_branch: 'other' },
  { repository: { id: 99, full_name: 'other/repo' } }])
  test('wrong exact run identity remains pending', async t => {
    const fixture = await relayFixture(t, { nativeRun });
    assert.equal((await fixture.process()).status, 'pending');
    assert.equal((await fixture.journal.read(key)).runId, 60);
    assert.equal((await fixture.process()).status, 'pending');
    assert.equal(fixture.posts, 1);
  });

test('concurrent origin and pause serialize through the same kernel lock', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fixture = await relayFixture(t, { post: async () => {
    entered(); await held; throw new Error('lost');
  } });
  const active = fixture.process();
  await started;
  assert.equal((await fixture.process()).code, 'RELAY_BUSY');
  assert.equal((await fixture.journal.setPaused(true)).code, 'RELAY_BUSY');
  release(); await active;
  assert.equal((await fixture.journal.setPaused(true)).status, 'paused');
  assert.equal((await fixture.process()).status, 'pending');
  assert.equal(fixture.posts, 1);
});

test('pause and unknown control block new POST; resume preserves immutable receipts',
  async t => {
    const fixture = await relayFixture(t);
    await fixture.journal.setPaused(true);
    assert.equal((await fixture.process()).status, 'paused');
    assert.equal(fixture.posts, 0);
    await writeRelayState(fixture.root, 'control.json', { paused: 'unknown' });
    await assert.rejects(fixture.process(), /RELAY_CONTROL_UNKNOWN/);
    assert.equal(fixture.posts, 0);
    await writeRelayState(fixture.root, 'control.json',
      { schemaVersion: 1, paused: true });
    await fixture.journal.setPaused(false);
    await fixture.process();
    const record = await fixture.journal.read(key);
    await assert.rejects(fixture.journal.write({ ...record, status: 'pending',
      intent: { ...record.intent, actor: { id: 99 } } }), /RELAY_IMMUTABLE_INTENT/);
    assert.equal(fixture.posts, 1);
  });

test('revocation after artifact read blocks the fresh admission', async t => {
  let inspections = 0;
  const fixture = await relayFixture(t, { inspect: async () => {
    if (++inspections === 2) throw Object.assign(new Error('revoked'),
      { code: 'HOST_ADOPTION_CHANGED' });
  } });
  await assert.rejects(fixture.process(), /revoked/);
  assert.equal(fixture.posts, 0);
});

test('discovery, backoff and diagnostics are bounded without secrets', async t => {
  const fixture = await relayFixture(t);
  assert.equal((await fixture.relay().poll()).status, 'observed');
  assert.equal(fixture.posts, 1);
  const reads = fixture.reads;
  await fixture.relay().poll();
  assert.equal(fixture.reads, reads);
  fixture.now += 60001;
  await fixture.relay().poll();
  assert.equal(fixture.posts, 1);
  const unavailable = await relayFixture(t, { intercept: () => new Response(null,
    { status: 429, headers: { 'retry-after': '300' } }) });
  const result = await unavailable.relay().poll();
  assert.equal(result.results[0].code, 'RELAY_HTTP_UNAVAILABLE');
  const before = unavailable.reads;
  unavailable.now += 60001;
  await unavailable.relay().poll();
  assert.equal(unavailable.reads, before);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('kernel gate releases after callback failure and leaves only maintained state',
  async t => {
    const fixture = await relayFixture(t);
    await assert.rejects(withRelayGate(fixture.root, () => {
      throw new Error('failure');
    }));
    assert.equal(await withRelayGate(fixture.root, () => 'acquired'), 'acquired');
    const path = join(fixture.root, 'control.json');
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes, { mode: 0o600 });
    assert.equal((await fixture.journal.control()).paused, false);
  });


test('conditional discovery can skip only fully consumed notifications', async t => {
  let conditional = 0;
  const fixture = await relayFixture(t, { intercept: (url, init) => {
    if (url.pathname.endsWith('/actions/workflows/20/runs') &&
      init.headers['If-None-Match'] === '"example"') {
      conditional++;
      return new Response(null, { status: 304 });
    }
  } });
  await fixture.relay().poll();
  fixture.now += 60001;
  await fixture.relay().poll();
  assert.equal(conditional, 1);
  assert.equal(fixture.posts, 1);
});

test('current workflow revocation blocks polling and dispatch', async t => {
  const fixture = await relayFixture(t, { intercept: url => {
    if (url.pathname.endsWith('/actions/workflows/20'))
      return new Response(JSON.stringify({ id: 20, path: origin.workflow.path,
        state: 'disabled_manually' }));
  } });
  await assert.rejects(fixture.process(), /RELAY_ORIGIN_WORKFLOW_CHANGED/);
  assert.equal(fixture.posts, 0);
});


test('second-precision timestamps can read back same-second dispatches', async t => {
  const fixture = await relayFixture(t);
  fixture.now = Date.parse('2026-11-16T00:02:01.999Z');
  assert.equal((await fixture.process()).status, 'consumed');
  assert.equal(fixture.posts, 1);
});


test('two origin intents cannot adopt the same generic Issue run', async t => {
  const fixture = await relayFixture(t, { post: () => { throw new Error('lost'); } });
  await fixture.process();
  const first = await fixture.journal.read(key);
  const secondKey = { ...key, runId: 31 };
  const inputs = { ...first.intent.inputs };
  const envelope = JSON.parse(inputs.wake_event);
  inputs.wake_event = JSON.stringify({ ...envelope, runId: 31 });
  await fixture.journal.write({ ...first, origin: secondKey,
    intent: { ...first.intent, origin: secondKey, inputs } });
  for (let restart = 0; restart < 2; restart++) {
    await fixture.relay().poll();
    for (const originKey of [key, secondKey]) {
      const record = await fixture.journal.read(originKey);
      assert.equal(record.status, 'pending');
      assert.equal(record.runId, undefined);
    }
  }
  assert.equal(fixture.posts, 1);
});
