import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coreRoot } from '../src/host-adoption.mjs';
import { notificationUnitContents } from '../src/relay-unit-contents.mjs';
import { relayUnits } from '../src/relay-host.mjs';

const nodePath = '/opt/nibfin/runtime/node/bin/node';

test('both fixed templates are inspected before reading contents', async () => {
  const calls = [];
  const result = await notificationUnitContents({
    runtime: async () => { calls.push('runtime'); return { nodePath }; },
    inspect: async path => { calls.push(`inspect:${path}`); },
    read: async (path, limit) => {
      calls.push(`read:${path}`);
      assert.equal(limit, 16384);
      return readFile(path, 'utf8');
    },
  });
  assert.deepEqual([...result.keys()], relayUnits);
  const expectedCalls = ['runtime'];
  for (const name of relayUnits) {
    const path = join(coreRoot, 'src/security', name);
    expectedCalls.push(`inspect:${path}`, `read:${path}`);
    const template = await readFile(path, 'utf8');
    assert.equal(result.get(name), template.replaceAll('NODE_RUNTIME', nodePath));
    assert(!result.get(name).includes('NODE_RUNTIME'));
  }
  assert.deepEqual(calls, expectedCalls);
  assert(result.get(relayUnits[0]).includes(`ExecStart=${nodePath} `));
});

for (const step of ['runtime', 'inspect', 'read']) {
  test(`${step} failure propagates before a later resource is accessed`, async () => {
    const failure = new Error(`${step} unavailable`);
    const calls = [];
    const observe = name => {
      calls.push(name);
      if (name === step) throw failure;
    };
    await assert.rejects(notificationUnitContents({
      runtime: async () => { observe('runtime'); return { nodePath }; },
      inspect: async () => { observe('inspect'); },
      read: async () => { observe('read'); return 'NODE_RUNTIME'; },
    }), error => error === failure);
    assert.deepEqual(calls,
      ['runtime', 'inspect', 'read'].slice(0, ['runtime', 'inspect', 'read']
        .indexOf(step) + 1));
  });
}

test('all runtime placeholders use the same installed runtime observation', async () => {
  let runtimes = 0;
  const result = await notificationUnitContents({
    runtime: async () => { runtimes++; return { nodePath }; },
    inspect: async () => {},
    read: async () => 'NODE_RUNTIME NODE_RUNTIME',
  });
  assert.equal(runtimes, 1);
  assert([...result.values()].every(bytes => bytes === `${nodePath} ${nodePath}`));
});
