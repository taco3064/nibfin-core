import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLifecycleCleanupPool } from '../src/notification-cleanup-pool.mjs';
import { retirementPath } from '../src/retirement-admission.mjs';

function fixture() {
  const identity = { repository: 'owner/pool', repositoryId: 10, memberId: 5,
    runners: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] };
  const pool = { schemaVersion: 1, ...identity, adoptedRepositoryIds: [20] };
  const adoption = { value: 'current binding' };
  const state = { id: 'retirement', phase: 'retired', pending: null,
    binding: { pool: identity,
      adoptions: [{ path: 'adopted', bytes: JSON.stringify(adoption) }],
      repositories: [{ repository: 'owner/source', repositoryId: 20 }] } };
  const marker = { schemaVersion: 1, retirementId: state.id, pool: identity };
  const calls = [];
  const ports = {
    stateFile: async path => path === retirementPath ? state : marker,
    registrations: async () => ['absent', 'absent'],
    unit: async slot => { calls.push(slot); },
    cgroups: async () => { calls.push('cgroups'); },
    poolOpen: async () => {}, runningServices: async () => {},
  };
  const reader = { list: async () => pool.runners.map(runner => ({ ...runner,
    status: 'online', busy: false, os: 'Linux',
    labels: [{ name: 'nibfin-shared' }, { name: 'nibfin-user-5' }],
  })) };
  return { state, marker, ports, pool, calls, reader,
    run: () => verifyLifecycleCleanupPool({ memberId: 5 }, pool, reader,
      async () => adoption, ports) };
}

test('retired cleanup requires exact drain, adoption and independent termination',
  async () => {
    const f = fixture();
    assert.deepEqual(await f.run(), [{ repository: 'owner/source',
      repositoryId: 20, route: 'retired' }]);
    assert.deepEqual(f.calls, [1, 2, 'cgroups']);
    f.marker.retirementId = 'different';
    await assert.rejects(f.run(), { code: 'NOTIFICATION_RETIREMENT_UNVERIFIED' });
  });

test('stale retirement, changed consumers and remaining registrations are refused',
  async () => {
    for (const change of [
      f => { f.ports.registrations = async () => ['present', 'absent']; },
      f => { f.pool.adoptedRepositoryIds.push(99); },
      f => { f.state.binding.adoptions[0].bytes = '{}'; },
      f => { f.ports.cgroups = async () => { throw new Error('live cgroup'); }; },
    ]) {
      const f = fixture(); change(f);
      await assert.rejects(f.run());
    }
  });

test('active cleanup verifies authoritative replacement identity and ready services',
  async () => {
    const f = fixture();
    f.state.replacement = { phase: 'released', pool: structuredClone(f.pool) };
    delete f.state.replacement.pool.schemaVersion;
    delete f.state.replacement.pool.adoptedRepositoryIds;
    f.state.binding.pool = { ...f.state.binding.pool, runners: [{ id: 3 }, { id: 4 }] };
    assert.equal(await f.run(), null);
    f.state.replacement.pool.repositoryId = 99;
    await assert.rejects(f.run(), { code: 'NOTIFICATION_REPLACEMENT_UNVERIFIED' });
  });
