import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocationPlan, allocateSubordinate, subordinateRows, verifySubordinateChange,
} from '../src/engine-subids.mjs';
import { verifyEngineUtilities } from '../src/engine-host.mjs';
import { engineAccounts, installSubordinates } from '../src/engine-accounts.mjs';

import { accountDouble } from './engine-account-fixture.mjs';

const rejectsCode = (use, code) => assert.throws(use, { code });

test('independent subordinate allocation avoids ranges and protected identities', () => {
  const plan = allocationPlan({
    subuid: 'alice:65536:65536\n', subgid: 'bob:131072:65536\n',
  }, { subuid: [0, 131073], subgid: [0, 65537] },
  { subuid: 900, subgid: 901 });
  assert.deepEqual(plan, { size: 65536, uidStart: 131074, gidStart: 196608 });
  const text = 'alice:65536:65536\nnibfin-remap:196608:65536\n';
  assert.equal(allocateSubordinate(text, [0, 1000], 900, 196608), 196608);
});

test('malformed, overlapping, ambiguous and unowned mappings fail closed', () => {
  for (const text of ['bad', 'alice:0:65536', 'alice:65536:0',
    'alice:4294967296:65536', 'alice:65536:65536\nbob:70000:65536']) {
    assert.throws(() => subordinateRows(text));
  }
  rejectsCode(() => allocateSubordinate('alice:65536:65536', [70000], 900),
    'ENGINE_SUBID_PROTECTED_IDENTITY');
  rejectsCode(() => allocateSubordinate('nibfin-remap:65536:65536', [0], 900),
    'ENGINE_SUBID_OWNERSHIP_UNPROVEN');
  rejectsCode(() => allocateSubordinate('900:65536:65536', [0], 900, 65536),
    'ENGINE_SUBID_OWNERSHIP_UNPROVEN');
  rejectsCode(() => allocateSubordinate('nibfin-remap:65536:100', [0], 900, 65536),
    'ENGINE_SUBID_OWNERSHIP_UNPROVEN');
  rejectsCode(() => allocateSubordinate(
    'nibfin-remap:65536:65536\n900:131072:65536', [0], 900, 65536),
  'ENGINE_SUBID_AMBIGUOUS');
  rejectsCode(() => allocateSubordinate('alice:65536:65536', [0], 900, 65536),
    'ENGINE_SUBID_CONFLICT');
});

test('subordinate readback preserves unrelated rows and detects changed effects', () => {
  const before = 'alice:65536:65536\n';
  verifySubordinateChange(before, before + 'nibfin-remap:131072:65536\n', 131072);
  rejectsCode(() => verifySubordinateChange(before,
    'alice:65536:65535\nnibfin-remap:131072:65536\n', 131072),
  'ENGINE_SUBID_RECONCILIATION_REQUIRED');
});

test('missing getfacl has a specific diagnostic before dependent effects', async () => {
  const inspected = [];
  await assert.rejects(verifyEngineUtilities(async path => {
    inspected.push(path);
    if (path === '/usr/bin/getfacl') throw Error('missing');
  }), { code: 'ENGINE_REQUIRED_GETFACL_UNAVAILABLE', utility: '/usr/bin/getfacl' });
  assert.equal(inspected.at(-1), '/usr/bin/getfacl');
});

test('actual account preparation creates fixed locked accounts and reuses exact IDs',
  async () => {
    const io = accountDouble();
    const accounts = await engineAccounts(io);
    assert.equal(io.commands.length, 5);
    assert.deepEqual(await engineAccounts(io, true, accounts), accounts);
    assert.equal(io.commands.length, 5);
    io.memberships.set('nibfin-runner-1', `${accounts.gid} 897`);
    await assert.rejects(engineAccounts(io, true, accounts),
      { code: 'ENGINE_ACCOUNT_GROUP_CONFLICT' });
  });

test('actual subordinate mutation reconciles each table and refuses lost outcomes',
  async () => {
    const tables = { subuid: '', subgid: '' };
    const commands = [];
    const plan = { tables: { ...tables },
      namespace: { size: 65536, uidStart: 131072, gidStart: 196608 } };
    const io = {
      subordinate: async name => tables[name],
      async run(path, args) {
        commands.push([path, args]);
        const table = args[0] === '--add-subuids' ? 'subuid' : 'subgid';
        const start = args[1].split('-')[0];
        tables[table] = `nibfin-remap:${start}:65536\n`;
        throw Error('lost response after effect');
      },
    };
    await installSubordinates(io, plan, false);
    await installSubordinates(io, plan, true);
    assert.equal(commands.length, 2);
    tables.subgid = '';
    await assert.rejects(installSubordinates(io, plan, true),
      { code: 'ENGINE_SUBID_RECONCILIATION_REQUIRED' });
    assert.equal(commands.length, 2);
  });
