import test from 'node:test';
import assert from 'node:assert/strict';
import { readRelayArchive, readRelayPayload } from '../src/relay-artifact.mjs';
import { RelayReader, downloadRelayArtifact, boundedBody } from '../src/relay-http.mjs';
import { sha256 } from '../src/identity.mjs';
import { zip, payload, origin, relayFixture } from './relay-fixture.mjs';

const readZip = bytes => readRelayArchive(bytes, `sha256:${sha256(bytes)}`);

test('single JSON ZIP supports store, deflate and native data descriptors', () => {
  for (const method of [0, 8]) for (const descriptor of [false, true]) {
    assert.equal(readZip(zip(payload(), { method, descriptor })), payload());
    assert.equal(readRelayPayload(payload(), origin, 30).runId, 30);
  }
});

for (const [name, change] of [
  ['extra member', bytes => bytes.writeUInt16LE(2, bytes.length - 12)],
  ['multiple disks', bytes => bytes.writeUInt16LE(1, bytes.length - 18)],
  ['local path mismatch', bytes => bytes[30] = 0x2f],
  ['trailing data', bytes => Buffer.concat([bytes, Buffer.from('trailer')])],
  ['encrypted input', bytes => bytes.writeUInt16LE(1, 6)],
  ['unbounded decompressed output', bytes => bytes.writeUInt32LE(4097,
    bytes.readUInt32LE(bytes.length - 6) + 24)],
  ['forged checksum', bytes => bytes.writeUInt32LE(0, 14)],
  ['local offset', bytes => bytes.writeUInt32LE(1,
    bytes.readUInt32LE(bytes.length - 6) + 42)],
  ['symlink entry', bytes => bytes.writeUInt32LE(0xa0000000,
    bytes.readUInt32LE(bytes.length - 6) + 38)],
]) test(`archive rejects ${name}`, () => {
  const bytes = zip(payload());
  const replacement = change(bytes);
  assert.throws(() => readZip(Buffer.isBuffer(replacement) ? replacement : bytes));
});

test('archive rejects truncation, traversal, bombs, UTF-8 and digest errors', () => {
  for (const length of [0, 20, 50, 97, 120])
    assert.throws(() => readZip(zip(payload()).subarray(0, length)));
  assert.throws(() => readZip(zip(payload(), { name: '../issue-wake.json' })));
  assert.throws(() => readZip(zip('x'.repeat(100000))));
  assert.throws(() => readZip(zip(Buffer.from([0xff, 0xff]))));
  assert.throws(() => readRelayArchive(zip(payload()), 'sha256:' + 'a'.repeat(64)));
});

test('payload rejects forged origin, attempts, extra keys, duplicate keys and huge JSON',
  () => {
    for (const transform of [
      value => { value.schemaVersion = 2; },
      value => { value.attempt = 2; },
      value => { value.runId = 31; },
      value => { value.event.repository.id = 99; },
      value => { value.event.repository.full_name = 'other/repo'; },
      value => { value.event.issue.pull_request = {}; },
      value => { value.tokenFile = '/etc/secret'; },
      value => { value.event.issue.body = 'secret'; },
    ]) {
      const value = JSON.parse(payload()); transform(value);
      assert.throws(() => readRelayPayload(JSON.stringify(value) + '\n', origin, 30));
    }
    assert.throws(() => readRelayPayload(payload().replace('"schemaVersion":1',
      '"schemaVersion":2,"schemaVersion":1'), origin, 30));
    assert.throws(() => readRelayPayload('{"oversized":"' + 'x'.repeat(5000) + '"}',
      origin, 30));
  });

test('storage redirects are bounded and never receive Authorization', async t => {
  let requests = 0;
  const fixture = await relayFixture(t, { storage: () => {
    requests++;
    return new Response(null, { status: 302,
      headers: { location: 'https://next.blob.core.windows.net/archive?secret=value' } });
  } });
  const reader = new RelayReader('fake-controller-token', fixture.fetcher);
  await assert.rejects(downloadRelayArtifact(reader, origin.repository, 40,
    fixture.fetcher), /RELAY_ARTIFACT_REDIRECT_LIMIT/);
  assert.equal(requests, 3);
  assert.ok(fixture.storage.every(headers => !headers.Authorization));
});

test('a storage redirect cannot reach an unsafe destination', async t => {
  const fixture = await relayFixture(t, { storage: () => new Response(null,
    { status: 302, headers: { location: 'http://localhost/private' } }) });
  await assert.rejects(fixture.process(), /RELAY_UNSAFE_ARTIFACT_DESTINATION/);
  assert.equal(fixture.posts, 0);
});

test('HTTP bodies and request counts are bounded; redirects and compression fail closed',
  async () => {
    await assert.rejects(boundedBody(new Response('large'), 4), /TOO_LARGE/);
    await assert.rejects(boundedBody(new Response('x', {
      headers: { 'content-length': '9999' },
    }), 4), /TOO_LARGE/);
    await assert.rejects(boundedBody(new Response('x', {
      headers: { 'content-encoding': 'gzip' },
    }), 4), /COMPRESSED_HTTP/);
    let calls = 0;
    const reader = new RelayReader('fake', async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return new Response('{}');
    });
    for (let count = 0; count < 240; count++) await reader.get('/user');
    await assert.rejects(reader.get('/user'), /RELAY_REQUEST_BUDGET/);
    assert.equal(calls, 240);
  });

test('paginated reconciliation cannot mistake a truncated native listing for uniqueness',
  async () => {
    let reads = 0;
    const reader = new RelayReader('fake', async () => {
      reads++;
      return new Response(JSON.stringify({ total_count: 999,
        workflow_runs: Array.from({ length: 50 }, (_, index) => ({ id: index + 1 })) }));
    });
    await assert.rejects(reader.list('/repos/owner/repo/actions/runs', 'workflow_runs'),
      /RELAY_INCOMPLETE_LISTING/);
    assert.equal(reads, 3);
  });
