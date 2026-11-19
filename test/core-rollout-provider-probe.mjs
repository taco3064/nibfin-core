// Test-only provider ports; production validation/dispatch remains unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { coreRolloutProvider } from '../src/core-rollout-provider.mjs';
import { rolloutFailure } from '../src/core-rollout-result.mjs';
import { writeCommandResult } from '../src/command-result.mjs';

const path = resolve(process.env.CORE_PROVIDER_FIXTURE);
assert(path.startsWith(resolve('.deliver-test-tmp') + sep));
const state = JSON.parse(await readFile(path));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks));
const sha = character => character.repeat(40);
const branch = 'cd/consumers-' + 'a'.repeat(12) + '-' + 'b'.repeat(12);
const pins = { core: { commit: sha('a') }, action: { commit: sha('b') }, artifact: {} };
const issue = '.github/workflows/nibfin-issue.yml';
const pinPath = '.nibfin/producer-pins.json';
const head = state.updated ? sha('1') : sha('f');
const file = value => ({ content: Buffer.from(value).toString('base64'), sha: sha('9') });
try {
  const result = await coreRolloutProvider(request, 'fake-private-token', {
    reader: { get: async route => {
      state.calls.push(route);
      if (route.endsWith('/branches/main')) return {
        commit: { sha: state.merged ? sha('f') : sha('e') } };
      if (route.includes('/contents/.github/workflows?')) return [{ path: issue }];
      if (route.includes('/contents/' + pinPath))
        return file(route.endsWith(sha('e')) ? '{}' : JSON.stringify(pins));
      if (route.includes('/contents/' + issue))
        return file('# Core source: ' + (route.endsWith(sha('e')) ? sha('c') : sha('a')));
      if (route.endsWith('/pulls/1')) return { number: 1, state: 'open', draft: false,
        base: { ref: 'main', repo: { full_name: 'taco3064/nibfin-core' } },
        head: { ref: branch, sha: head, repo: { full_name: 'taco3064/nibfin-core' } },
        mergeable: true, mergeable_state: 'behind' };
      throw Error('Unexpected fixture API route ' + route);
    } },
    run: async (program, args) => {
      state.calls.push(args);
      if (args.slice(0, 2).join(' ') === 'pr merge') {
        state.merged = true;
        throw Object.assign(Error('write response lost'), { code: 'PROCESS_FAILED' });
      }
      if (args[0] === 'pr') return { stdout: Buffer.from(JSON.stringify([{
        number: 1, headRefOid: head, isDraft: false, isCrossRepository: false,
        files: [{ path: issue }, { path: pinPath }],
        mergeStateStatus: state.behind ? state.updated ? 'BLOCKED' : 'BEHIND' : 'CLEAN',
        statusCheckRollup: [{ conclusion: state.behind ? null : 'SUCCESS' }],
      }])) };
      assert.equal(args[3], 'PUT');
      assert.equal(args[5], 'expected_head_sha=' + sha('f'));
      state.updated = true;
      return { stdout: Buffer.from('{"message":"updating"}') };
    },
  });
  await writeFile(path, JSON.stringify(state));
  writeCommandResult(result);
} catch (error) {
  await writeFile(path, JSON.stringify(state));
  writeCommandResult(rolloutFailure(error));
}
