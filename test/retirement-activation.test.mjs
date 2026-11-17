import assert from 'node:assert/strict';
import test from 'node:test';
import { commitReplacementAdmission } from '../src/retirement-rebind.mjs';
import { verifyReplacementRunners } from '../src/retirement-activate.mjs';

const old = { runners: [{ id: 1 }, { id: 2 }] };
const pool = { memberId: 32, runners: [{ id: 3, name: 'a' }, { id: 4, name: 'b' }] };
const registrations = pool.runners.map(runner => ({
  ...runner, status: 'online', busy: false, os: 'Linux',
  labels: [{ name: 'nibfin-shared' }, { name: 'nibfin-user-32' }],
}));

test('replacement requires two exact ready registrations and removal of old IDs', () => {
  verifyReplacementRunners(pool, old, registrations);
  for (const invalid of [
    registrations.slice(0, 1),
    [registrations[0], { ...registrations[1], busy: true }],
    [...registrations, { id: old.runners[0].id }],
  ]) {
    assert.throws(() => verifyReplacementRunners(pool, old, invalid),
      { code: 'RETIREMENT_REPLACEMENT_RUNNERS_UNVERIFIED' });
  }
});

test('failed or interrupted activation keeps admission closed', async () => {
  let state = { id: 'one', binding: { pool: old }, replacement: { phase: 'prepared' } };
  let marker = { schemaVersion: 1, retirementId: state.id, pool: old };
  const effects = [];
  const ports = {
    readDrain: async () => marker,
    verify: async () => { throw new Error('INCOMPLETE'); },
    write: async value => { effects.push('write'); state = value; },
    open: async () => { effects.push('open'); throw new Error('INTERRUPTED'); },
  };
  await assert.rejects(commitReplacementAdmission(state, ports), /INCOMPLETE/);
  assert.deepEqual(effects, []);
  assert.ok(marker);
  ports.verify = async () => { effects.push('verify'); };
  await assert.rejects(commitReplacementAdmission(state, ports), /INTERRUPTED/);
  assert.equal(state.replacement.phase, 'released');
  assert.ok(marker);
  ports.open = async () => { effects.push('open'); marker = null; };
  assert.deepEqual(await commitReplacementAdmission(state, ports), { released: true });
  assert.deepEqual(await commitReplacementAdmission(state, ports), { released: true });
  assert.deepEqual(effects, ['verify', 'write', 'open', 'verify', 'write', 'open']);
});
