import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { coreRolloutProvider, rolloutProviderRoute }
  from '../src/core-rollout-provider.mjs';
import { GitHubReader } from '../src/github-read.mjs';
import { rolloutFailure } from '../src/core-rollout-result.mjs';

const root = 'repos/taco3064/nibfin-core', head = 'a'.repeat(40);
const fields = 'number,headRefOid,isDraft,mergeStateStatus,' +
  'isCrossRepository,files,statusCheckRollup';
const list = ['pr', 'list', '-R', 'taco3064/nibfin-core', '--base', 'main', '--head',
  'cd/consumers-' + 'a'.repeat(12) + '-' + 'b'.repeat(12), '--json', fields];

test('bounded native provider closure retains JSON, GraphQL and binary semantics',
  async () => {
    const seen = [], zip = Buffer.from([0, 255, 80, 75, 1]);
    const ports = { reader: { get: async path => {
      seen.push(path); return { id: 42 };
    } },
      run: async (program, args) => {
        assert.equal(program, '/usr/bin/gh');
        seen.push(args);
        return { stdout: args[0] === 'pr' ? Buffer.from('[{"number":1}]') : zip };
      } };
    const json = await coreRolloutProvider(['api', root], 'fixture', ports);
    assert.deepEqual(JSON.parse(Buffer.from(json.bytes, 'base64')), { id: 42 });
    const binary = await coreRolloutProvider(['api', root + '/actions/artifacts/1/zip'],
      'fixture', ports);
    assert.deepEqual(Buffer.from(binary.bytes, 'base64'), zip);
    await coreRolloutProvider(list, 'fixture', ports);
    assert.deepEqual(seen[2], list);
    for (const request of [
      ['api', root + '/pulls/1/update-branch', '--method', 'PUT', '-f',
        'expected_head_sha=' + head],
      ['api', root + '/pulls/1', '--method', 'PATCH', '-f', 'state=closed'],
      ['pr', 'merge', '-R', 'taco3064/nibfin-core', '1', '--rebase',
        '--match-head-commit', head],
    ]) assert.equal(rolloutProviderRoute(request).kind, 'write');
  });

test('JSON GET preserves typed 585 errors; local CLI errors never claim API HTTP',
  async () => {
    for (const [response, kind] of [[new Response('', { status: 422 }), 'http'],
      [new Response('invalid-json'), 'invalid-response']]) {
      const reader = new GitHubReader('fixture', async () => response);
      await assert.rejects(coreRolloutProvider(['api', root], 'fixture', { reader }),
        error => rolloutFailure(error).githubApi.kind === kind);
    }
    for (const code of ['PROCESS_FAILED', 'PROCESS_UNAVAILABLE', 'PROCESS_TIMEOUT',
      'PROCESS_OUTPUT_LIMIT']) {
      await assert.rejects(coreRolloutProvider(list, 'fixture', { run: async () => {
        throw Object.assign(Error('gh HTTP 422 private token'), { code });
      } }), error => {
        assert.deepEqual(rolloutFailure(error), { status: 'pending', code });
        return true;
      });
    }
    for (const request of [['repo', 'delete'], [...list, '--web'],
      ['api', 'https://example.com/private'], ['api', root, '--input', 'secrets'],
      ['api', root + '/pulls/1', '--method', 'DELETE', '-f', 'state=closed'],
      ['pr', 'merge', '-R', 'taco3064/nibfin-core', '1', '--admin']]) {
      assert.throws(() => rolloutProviderRoute(request),
        { code: 'INVALID_ROLLOUT_PROVIDER_REQUEST' });
    }
  });

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
for (const kind of ['ready', 'behind', 'merged']) {
  test(`actual Python load_runtime/read_consumer delegates native ${kind} closure`, {
    skip: !python && 'Python is unavailable in this assigned environment',
  }, () => {
    const child = spawnSync('python3', ['-B', 'test/core-rollout-consumer-probe.py',
      process.execPath, kind], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}
