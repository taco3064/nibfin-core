import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../scripts/routing-output.mjs', import.meta.url).href;

async function invoke(t, expression) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-routing-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'github-output');
  await writeFile(output, 'existing=value\n');
  const source = [
    `import {routingOutput} from ${JSON.stringify(moduleUrl)};`,
    `await routingOutput(async () => { ${expression} },`,
    "['issue_number', 'member_id']);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.ifError(result.error);
  return { ...result, output: await readFile(output, 'utf8') };
}

test('routing success retains exact validated outputs', async (t) => {
  const result = await invoke(t,
    "return {status:'resolved',issue_number:'2',member_id:'127829492'};");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).status, 'resolved');
  assert.equal(result.output,
    'existing=value\nissue_number=2\nmember_id=127829492\n');
});

test('read failures expose bounded codes without credentials or routing', async (t) => {
  const secret = 'PRIVATE_SENTINEL_https://example.invalid/?credential=hidden';
  for (const [property, value, expected] of [
    ['status', 401, 'GITHUB_READ_HTTP_401'],
    ['status', 403, 'GITHUB_READ_HTTP_403'],
    ['status', '401', 'WAKE_RESOLUTION_FAILED'],
    ['code', 'UNTRUSTED_ISSUE_EVENT_RUN', 'UNTRUSTED_ISSUE_EVENT_RUN'],
    ['code', 'WAKE_TARGET_NOT_READY', 'WAKE_TARGET_NOT_READY'],
    ['code', secret, 'WAKE_RESOLUTION_FAILED'],
  ]) {
    const result = await invoke(t,
      `throw Object.assign(new Error(${JSON.stringify(secret)}),` +
      `{${property}:${JSON.stringify(value)}});`);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.output, 'existing=value\n');
    assert.ok(!result.stderr.includes(secret));
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), {
      schemaVersion: 1, status: 'denied', code: expected, stageAdmitted: false,
    });
  }
});

test('malformed success cannot publish injected workflow output', async (t) => {
  const result = await invoke(t,
    "return {status:'resolved',issue_number:'2\\nsecret=bad',member_id:'1'};");
  assert.equal(result.status, 1);
  assert.equal(result.output, 'existing=value\n');
  assert.equal(JSON.parse(result.stderr.trim().split('\n')[1]).code,
    'INVALID_ROUTING_OUTPUT');
});

test('accessor errors do not execute getters while formatting a denial', async (t) => {
  const result = await invoke(t,
    "const e = new Error('private');" +
    "Object.defineProperty(e,'code',{get(){throw Error('getter executed')}});" +
    'throw e;');
  assert.equal(result.status, 1);
  assert.equal(result.output, 'existing=value\n');
  assert.equal(JSON.parse(result.stderr.trim().split('\n')[1]).code,
    'WAKE_RESOLUTION_FAILED');
});
