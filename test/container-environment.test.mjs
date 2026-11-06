import test from 'node:test';
import assert from 'node:assert/strict';
import { sameContainerEnvironment } from '../src/container-environment.mjs';

test('container environment identity tolerates order, never authority changes', () => {
  const expected = ['PATH=/usr/bin', 'NIBFIN_MCP_POLICY_DIRECTORY=/mcp-policy'];
  assert.equal(sameContainerEnvironment([...expected].reverse(), expected), true);
  for (const actual of [
    expected.slice(1), [...expected, 'GITHUB_TOKEN=foreign'],
    ['PATH=/bin', expected[1]], [...expected, 'PATH=/usr/bin'],
    [...expected, 'PATH=/foreign'], [...expected, 'malformed'],
    [...expected, '=nameless'], [...expected, null], null,
  ]) assert.equal(sameContainerEnvironment(actual, expected), false);
  assert.equal(sameContainerEnvironment(['VALUE=a=b'], ['VALUE=a=b']), true);
  assert.equal(sameContainerEnvironment([], ['DUP=1', 'DUP=1']), false);
});
