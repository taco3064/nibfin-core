import { relayFixture } from './relay-fixture.mjs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retireManagedPool } from '../src/managed-retirement.mjs';
import {
  poolAdmission, withPoolGate, requirePoolConsumersSettled, requirePoolOpen,
} from '../src/retirement-admission.mjs';
import { RelayJournal, readRelayState, writeRelayState } from '../src/relay-state.mjs';
import {
  RetirementSlotResources, retirementSlotEffects,
} from '../src/retirement-resources.mjs';
import {
  observeRetirementUnit, observeRetirementRegistrations, assertRetirementJobs,
  assertRetirementCgroups,
} from '../src/retirement-observe.mjs';
import { resourceIdentity } from '../src/retirement-files.mjs';
import { managedSettlement } from '../src/managed-credential-settlement.mjs';
import {
  retirementCopies, observeRetirementCopies, removeRetirementCopies,
} from '../src/retirement-copies.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retirement-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state'), parent = join(root, 'runners');
  const relayRoot = join(root, 'relay');
  for (const path of [stateRoot, parent, relayRoot]) await mkdir(path, { mode: 0o700 });
  const host = { stateRoot, uid: process.getuid(), gid: process.getgid() };
  const pool = { repository: 'owner/execution', repositoryId: 5, memberId: 4,
    runners: [{ id: 10, name: 'slot-1' }, { id: 11, name: 'slot-2' }] };
  const slots = [];
  for (const slot of [1, 2]) {
    const path = join(parent, `slot-${slot}`);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, 'provider-copy'), 'fake-profile');
    const runner = pool.runners[slot - 1];
    await writeFile(join(path, '.runner'), JSON.stringify({ agentId: runner.id,
      agentName: runner.name, gitHubUrl: 'https://github.com/' + pool.repository,
      workFolder: '_work' }));
    slots.push({ slot, path, runner, service: `nibfin-shared-runner@${slot}.service`,
      identity: resourceIdentity(await lstat(path)) });
  }
  const binding = { pool, slots, provider: 'codex' };
  const marker = join(root, 'drain.json');
  const relay = new RelayJournal(relayRoot);
  await writeRelayState(relayRoot, 'control.json', { schemaVersion: 1, paused: false });
  const native = ['present', 'present'], disabled = new Set();
  const calls = [];
  const resources = new RetirementSlotResources({ parent,
    inspect: async path => {
      if (path === '/usr/bin/systemctl') return;
      assert(path === parent || path.startsWith(parent + '/'));
      assert(!(await lstat(path)).isSymbolicLink());
    },
    run: async (_program, [verb, unit]) => {
      calls.push([verb, unit]);
      if (verb === 'disable') disabled.add(unit);
      return { stdout: Buffer.from(disabled.has(unit) ? 'disabled' : 'enabled') };
    } });
  const ports = {
    read: () => readRelayState(stateRoot, 'retirement.json'),
    write: state => writeRelayState(stateRoot, 'retirement.json', state),
    inspectBinding: async () => {},
    assertClosed: async () => {
      assert.equal((await relay.control()).paused, true);
      await assert.rejects(requirePoolOpen(marker), { code: 'MANAGED_POOL_RETIRING' });
    },
    settle: async () => {
      await relay.requireSettled();
      await requirePoolConsumersSettled(host);
      await managedSettlement(host);
    },
    registrations: async () => native,
    cleanupEffects: retirementSlotEffects,
    retryableEffects: ['close-admission', 'relay-pause', ...retirementSlotEffects],
    observeEffect: async (name, state) => {
      if (name === 'relay-pause')
        return (await relay.control()).paused ? 'done' : 'absent';
      if (name === 'close-admission') return await lstat(marker)
        .then(() => 'done', error => {
          if (error.code === 'ENOENT') return 'absent';
          throw error;
        });
      return resources.observe(name, state);
    },
    performEffect: async (name, state) => {
      if (name === 'relay-pause') return relay.setPaused(true);
      if (name === 'close-admission') return withPoolGate(host,
        () => writeFile(marker, JSON.stringify({ id: state.id })));
      return resources.perform(name, state);
    },
  };
  return { root, host, binding, marker, relay, ports, native, resources, calls,
    run: () => retireManagedPool(binding, ports) };
}

test('fake slots use real relay control, durable state and bounded resource cleanup',
  async t => {
    const f = await fixture(t);
    const unrelated = join(f.root, 'unrelated-login');
    await writeFile(unrelated, 'preserve');
    await symlink(unrelated, join(f.binding.slots[0].path, 'external-link'));
    assert.equal((await f.run()).phase, 'removal');
    assert.equal(f.calls.filter(([verb]) => verb === 'disable').length, 0);
    f.native[0] = 'absent';
    assert.equal((await f.run()).phase, 'removal');
    f.native[1] = 'absent';
    const result = await f.run();
    assert.equal(result.status, 'retired', JSON.stringify(result));
    assert.equal((await f.relay.control()).paused, true);
    assert.equal(await readFile(unrelated, 'utf8'), 'preserve');
    assert.deepEqual(await readdir(join(f.root, 'runners')), []);
    assert.equal((await f.run()).status, 'retired');
    assert.equal(f.calls.filter(([verb]) => verb === 'disable').length, 2);
  });

test('admission crossing closure either holds a lease or is refused', async t => {
  const f = await fixture(t);
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const admitted = poolAdmission(f.host, async () => {
    entered(); await done;
  }, f.marker);
  await started;
  assert.equal((await f.run()).code, 'RETIREMENT_CONSUMER_PENDING');
  await assert.rejects(poolAdmission(f.host, async () => assert.fail(), f.marker),
    { code: 'MANAGED_POOL_RETIRING' });
  finish();
  await admitted;
  assert.equal((await f.run()).phase, 'removal');
});

test('unknown native registration readback preserves closure and resources', async t => {
  const f = await fixture(t);
  f.ports.registrations = async () => { throw new Error('native unavailable'); };
  assert.equal((await f.run()).code, 'RETIREMENT_OBSERVATION_UNKNOWN');
  assert.equal((await f.relay.control()).paused, true);
  assert((await lstat(f.binding.slots[0].path)).isDirectory());
  assert((await lstat(f.binding.slots[1].path)).isDirectory());
});

test('quarantine crash reconciles inode readback without another rename', async t => {
  const f = await fixture(t);
  const perform = f.ports.performEffect;
  let renames = 0;
  f.ports.performEffect = async (name, state) => {
    await perform(name, state);
    if (name === 'quarantine-1') { renames++; throw new Error('interrupted'); }
  };
  f.native.fill('absent');
  const result = await f.run();
  assert.equal(result.status, 'retired', JSON.stringify(result));
  assert.equal(renames, 1);
  assert.equal((await f.run()).status, 'retired');
});

test('native service identity and local cgroups are independent termination evidence',
  async t => {
    const f = await fixture(t);
    const unit = { Id: 'nibfin-shared-runner@1.service', LoadState: 'loaded',
      FragmentPath: '/etc/systemd/system/nibfin-shared-runner@.service',
      DropInPaths: '', NeedDaemonReload: 'no', User: 'nibfin-runner-1',
      Group: 'nibfin-runner-1', ActiveState: 'inactive', SubState: 'dead',
      MainPID: '0', ControlGroup: '' };
    const run = async () => ({ stdout: Buffer.from(Object.entries(unit)
      .map(([key, value]) => `${key}=${value}`).join('\n')) });
    await observeRetirementUnit(1, run);
    unit.MainPID = '42';
    await assert.rejects(observeRetirementUnit(1, run),
      { code: 'RETIREMENT_SERVICE_PENDING' });
    unit.MainPID = '0'; unit.DropInPaths = '/untrusted.conf';
    await assert.rejects(observeRetirementUnit(1, run),
      { code: 'RETIREMENT_SERVICE_IDENTITY_CHANGED' });
    const cgroup = join(f.root, 'cgroup');
    const nested = join(cgroup, 'nibfin-shared-runner@2.service', 'child');
    await mkdir(nested, { recursive: true });
    await writeFile(join(cgroup, 'cgroup.controllers'), 'cpu memory');
    await writeFile(join(nested, '..', 'cgroup.procs'), '');
    await writeFile(join(nested, 'cgroup.procs'), '123\n');
    await assert.rejects(assertRetirementCgroups(cgroup),
      { code: 'RETIREMENT_CGROUP_PENDING' });
    await writeFile(join(nested, 'cgroup.procs'), '');
    await assertRetirementCgroups(cgroup);
  });

test('registration absence, busy state, identity conflicts and target Jobs reconcile',
  async t => {
    const f = await fixture(t);
    const registrations = f.binding.pool.runners.map(runner => ({ ...runner,
      os: 'Linux', status: 'offline', busy: false,
      labels: [{ name: 'nibfin-shared' }, { name: 'nibfin-user-4' }] }));
    let active = false;
    const reader = {
      get: async () => ({ id: 5, full_name: 'owner/execution' }),
      list: async path => path.endsWith('/actions/runners') ? registrations :
        path.includes('/jobs') ? [{ runner_id: 10, status: 'in_progress' }] :
          active ? [{ id: 20 }] : [],
    };
    assert.deepEqual(await observeRetirementRegistrations(reader, f.binding.pool),
      ['present', 'present']);
    registrations[0].busy = true;
    await assert.rejects(observeRetirementRegistrations(reader, f.binding.pool),
      { code: 'RETIREMENT_NATIVE_BUSY' });
    registrations[0].busy = false; registrations[0].id = 99;
    await assert.rejects(observeRetirementRegistrations(reader, f.binding.pool),
      { code: 'RETIREMENT_NATIVE_IDENTITY_CHANGED' });
    registrations.length = 0;
    assert.deepEqual(await observeRetirementRegistrations(reader, f.binding.pool),
      ['absent', 'absent']);
    active = true;
    await assert.rejects(assertRetirementJobs(reader,
      [{ repository: 'owner/execution', repositoryId: 5 }], f.binding.pool),
    { code: 'RETIREMENT_JOB_PENDING' });
  });

test('only bounded settled provider copies are removed; Writer evidence survives',
  async t => {
    const f = await fixture(t);
    const issue = join(f.host.stateRoot, 'issue-5-1');
    const agent = join(issue, 'agent');
    const session = join(agent, 'session-' + 'a'.repeat(64));
    const home = join(session, 'home');
    const execution = join(agent, 'execution-' + 'a'.repeat(36));
    const auth = join(execution, 'agent-auth-Ab12Cd');
    for (const path of [issue, agent, session, home, execution, auth])
      await mkdir(path, { mode: 0o700 });
    await writeFile(join(auth, 'auth.json'), 'fake-copy');
    const evidence = join(execution, 'output');
    await mkdir(evidence); await writeFile(join(evidence, 'result.json'), '{}');
    await writeFile(join(session, 'active.lock'), 'unresolved');
    await assert.rejects(retirementCopies(f.host), { code: 'RETIREMENT_WRITER_PENDING' });
    await rm(join(session, 'active.lock'));
    const copies = await retirementCopies(f.host);
    assert.equal(copies.length, 2);
    assert.equal(await observeRetirementCopies(copies), 'absent');
    await removeRetirementCopies(copies);
    assert.equal(await observeRetirementCopies(copies), 'done');
    assert.equal(await readFile(join(evidence, 'result.json'), 'utf8'), '{}');
  });

test('a Claude pool lists only session homes; the Codex listing is unchanged',
  async t => {
    const f = await fixture(t);
    const agent = join(f.host.stateRoot, 'issue-6-1', 'agent');
    const home = join(agent, 'session-' + 'b'.repeat(64), 'home');
    const execution = join(agent, 'execution-' + 'b'.repeat(36));
    await mkdir(home, { recursive: true, mode: 0o700 });
    // A Claude execution has no per-run credential copy: its credential
    // travels on container stdin, so only its own input and output remain.
    for (const name of ['input', 'output'])
      await mkdir(join(execution, name), { recursive: true, mode: 0o700 });
    const listed = async () => (await retirementCopies(f.host)).map(copy => copy.path);
    assert.deepEqual(await listed(), [home]);
    const auth = join(execution, 'agent-auth-Ef34Gh');
    await mkdir(auth, { mode: 0o700 });
    assert.deepEqual((await listed()).sort(), [auth, home].sort());
  });

test('process death after quarantine keeps durable intent for a fresh invocation',
  async t => {
    const f = await fixture(t);
    f.native.fill('absent');
    const perform = f.ports.performEffect;
    f.ports.performEffect = async (name, state) => {
      if (name === 'quarantine-1') throw new Error('before effect');
      return perform(name, state);
    };
    assert.equal((await f.run()).code, 'CLEANUP_EFFECT_UNKNOWN');
    const machine = new URL('../src/managed-retirement.mjs', import.meta.url).href;
    const resources = new URL('../src/retirement-resources.mjs', import.meta.url).href;
    const relay = new URL('../src/relay-state.mjs', import.meta.url).href;
    const script = `
      import { retireManagedPool } from ${JSON.stringify(machine)};
      import { RetirementSlotResources } from ${JSON.stringify(resources)};
      import { readRelayState, writeRelayState } from ${JSON.stringify(relay)};
      const root = process.argv[1], parent = process.argv[2];
      const state = await readRelayState(root, 'retirement.json');
      const resources = new RetirementSlotResources({ parent,
        inspect: async () => {} });
      await retireManagedPool(state.binding, {
        read: () => readRelayState(root, 'retirement.json'),
        write: state => writeRelayState(root, 'retirement.json', state),
        inspectBinding: async () => {}, assertClosed: async () => {},
        settle: async () => {}, registrations: async () => ['absent', 'absent'],
        cleanupEffects: ['quarantine-1'], retryableEffects: ['quarantine-1'],
        observeEffect: (name, state) => resources.observe(name, state),
        performEffect: async (name, state) => {
          await resources.perform(name, state);
          process.kill(process.pid, 'SIGKILL');
        },
      });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      f.host.stateRoot, join(f.root, 'runners')], { timeout: 5000, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const pending = await readRelayState(f.host.stateRoot, 'retirement.json');
    assert.equal(pending.effects['quarantine-1'], 'intent');
    f.ports.performEffect = perform;
    assert.equal((await f.run()).status, 'retired');
  });

test('changed local registration cannot authorize destructive slot effects', async t => {
  const f = await fixture(t);
  await f.run();
  await writeFile(join(f.binding.slots[0].path, '.runner'), JSON.stringify({
    agentId: 99, agentName: 'replacement',
    gitHubUrl: 'https://github.com/owner/execution', workFolder: '_work',
  }));
  f.native.fill('absent');
  const result = await f.run();
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'SHARED_RUNNER_REGISTRATION_MISMATCH');
  assert.equal(result.removal.permitted, false);
  assert.equal(f.calls.filter(([verb]) => verb === 'disable').length, 0);
  assert((await lstat(f.binding.slots[0].path)).isDirectory());
  assert((await lstat(f.binding.slots[1].path)).isDirectory());
});

for (const knownId of [false, true]) {
  test(`relay unresolved effect (known ID: ${knownId}) prevents retirement`, async t => {
    let unavailable = true;
    const notification = await relayFixture(t, knownId ? {
      intercept: url => {
        if (unavailable && url.pathname.endsWith('/runs/60')) throw new Error('offline');
      },
    } : { post: () => { throw new Error('lost response'); } });
    assert.equal((await notification.process()).status, 'pending');
    const f = await fixture(t);
    const settle = f.ports.settle;
    f.ports.settle = async () => {
      await notification.journal.requireSettled();
      await settle();
    };
    await notification.journal.setPaused(true);
    f.native.fill('absent');
    const key = { repositoryId: 1, runId: 30, attempt: 1 };
    const before = await notification.journal.read(key);
    for (let restart = 0; restart < 2; restart++) {
      const result = await f.run();
      assert.equal(result.status, 'pending');
      assert.equal(result.code, 'RETIREMENT_RELAY_EFFECT_PENDING');
      assert.equal(result.removal.permitted, false);
      assert.equal(f.calls.length, 0);
      for (const slot of f.binding.slots) assert((await lstat(slot.path)).isDirectory());
      assert.equal((await f.relay.control()).paused, true);
      assert.deepEqual(await notification.journal.read(key), before);
    }
    unavailable = false;
    const recovered = await notification.process();
    assert.equal(recovered.status, knownId ? 'consumed' : 'pending');
    assert.equal(notification.posts, 1);
    assert.equal((await f.run()).status, knownId ? 'retired' : 'pending');
  });
}

test('relay settlement refuses an in-flight gate, unknown control and corrupt journal',
  async t => {
    const f = await fixture(t);
    const { withRelayGate } = await import('../src/relay-state.mjs');
    await f.relay.setPaused(true);
    await withRelayGate(f.relay.root, async () => {
      await assert.rejects(f.relay.requireSettled(), { code: 'RETIREMENT_RELAY_BUSY' });
    });
    await f.relay.requireSettled();
    await writeRelayState(f.relay.root, 'control.json', { paused: 'unknown' });
    await assert.rejects(f.relay.requireSettled(), { code: 'RELAY_CONTROL_UNKNOWN' });
    await writeRelayState(f.relay.root, 'control.json',
      { schemaVersion: 1, paused: true });
    await writeRelayState(f.relay.root, 'origin-1-30-1.json', { status: 'consumed' });
    await assert.rejects(f.relay.requireSettled());
  });
