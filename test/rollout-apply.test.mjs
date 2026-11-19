import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRolloutTransaction } from '../src/rollout-apply.mjs';

function fixture(crashAt = Infinity) {
  const packages = { live: 'old', staged: 'new', backup: 'absent' };
  const files = new Map([['one', 'old-one'], ['two', 'old-two']]);
  const plan = { pin: { commit: 'a'.repeat(40) }, phase: 'applying', apply: {
    oldPin: { commit: 'b'.repeat(40) }, source: {}, completed: false,
    targets: [...files].map(([path, current]) => ({ path, current,
      next: JSON.stringify({ repository: { runner: { repository: path } } }) + '\n' })),
    resources: [{ path: 'relay', current: null, next: '{}\n' }],
  } };
  let mutations = 0, saved;
  const crash = () => { if (++mutations === crashAt) throw new Error('interrupted'); };
  const ports = { backup: 'backup',
    package: async name => packages[name],
    move: async (from, to) => {
      assert.equal(packages[to], 'absent');
      packages[to] = packages[from]; packages[from] = 'absent'; crash();
    },
    read: async path => files.get(path) ?? null,
    replace: async (path, value) => { files.set(path, value); crash(); },
    save: async value => { saved = value; crash(); },
  };
  return { plan, ports, packages, files, saved: () => saved };
}

test('promotion resumes from every filesystem mutation without repeating effects',
  async () => {
    for (let interruption = 1; interruption <= 6; interruption++) {
      const f = fixture(interruption);
      await assert.rejects(applyRolloutTransaction(f.plan, f.ports), /interrupted/);
      const result = await applyRolloutTransaction(f.plan, f.ports);
      assert.equal(result.status, 'installed');
      assert.deepEqual(f.packages, { live: 'new', staged: 'absent', backup: 'old' });
      assert.equal(f.saved().phase, 'verifying');
      assert.equal(f.saved().apply.completed, true);
      assert.equal(f.files.get('relay'), '{}\n');
    }
  });

test('unknown package or binding contents remain pending without overwrite', async () => {
  const badPackage = fixture();
  badPackage.packages.live = 'unknown';
  await assert.rejects(applyRolloutTransaction(badPackage.plan, badPackage.ports),
    { code: 'ROLLOUT_PACKAGE_STATE_UNKNOWN' });
  assert.equal(badPackage.packages.staged, 'new');
  const badBinding = fixture();
  badBinding.files.set('one', 'unknown');
  await assert.rejects(applyRolloutTransaction(badBinding.plan, badBinding.ports),
    { code: 'ROLLOUT_HOST_STATE_UNKNOWN' });
  assert.equal(badBinding.files.get('one'), 'unknown');
  assert.equal(badBinding.saved(), undefined);
});
