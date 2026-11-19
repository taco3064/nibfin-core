import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, realpath }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { recoverStaleOrigin } from '../src/rollout-recovery.mjs';
import { settleLifecycleNotifications } from '../src/lifecycle-settlement.mjs';
import { readRelayState } from '../src/relay-state.mjs';
import { cleanupNotifications } from '../src/notification-cleanup.mjs';
import { NotificationCleanupFiles } from '../src/notification-cleanup-files.mjs';
import { NotificationCleanupServices } from '../src/notification-cleanup-service.mjs';
import { relayUnits, relayUnitDirectory } from '../src/relay-host.mjs';
import { RelayJournal, writeRelayState, withRelayGate } from '../src/relay-state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'notification-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'journal'), units = join(directory, 'units');
  const config = join(directory, 'notification.json');
  await mkdir(root, { mode: 0o700 });
  await mkdir(units);
  const contents = new Map(relayUnits.map(name => [name, `owned ${name}\n`]));
  for (const [name, bytes] of contents) await writeFile(join(units, name), bytes);
  await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: false });
  await writeRelayState(root, 'poll-1.json', { nextAt: 1, etag: null });
  const origin = { repository: 'owner/project', repositoryId: 1, ref: 'main',
    workflow: { id: 20, path: '.github/workflows/nibfin-issue.yml',
      commit: 'a'.repeat(40), blob: 'b'.repeat(40) } };
  await writeFile(config, JSON.stringify({ schemaVersion: 1, origins: [origin] }));
  const calls = [];
  let failAfter, unknown = false, changed = false, blockedCgroup = false;
  const state = new Map(relayUnits.map(name => [name, {
    Id: name, LoadState: 'loaded', FragmentPath: join(relayUnitDirectory, name),
    DropInPaths: '', NeedDaemonReload: 'no', ActiveState: 'active',
    MainPID: name.endsWith('.service') ? '100' : '', ControlGroup: '',
    User: 'root', Group: 'root',
    UnitFileState: name.endsWith('.service') ? 'static' : 'enabled',
  }]));
  const services = new NotificationCleanupServices(async (program, args) => {
    assert.equal(program, '/usr/bin/systemctl');
    const [verb, name] = args;
    if (unknown) throw new Error('observation unavailable');
    const unit = state.get(name);
    if (verb === 'show') return { stdout: Buffer.from(Object.entries(unit)
      .map(([key, value]) => `${key}=${value}`).join('\n')) };
    calls.push(args);
    if (verb === 'stop') Object.assign(unit, { ActiveState: 'inactive', MainPID: '0' });
    if (verb === 'disable') unit.UnitFileState = 'disabled';
    if (verb === 'daemon-reload') {
      for (const [id, current] of state) {
        try { await lstat(join(units, id)); }
        catch (error) {
          assert.equal(error.code, 'ENOENT');
          Object.assign(current, { LoadState: 'not-found', FragmentPath: '',
            UnitFileState: '', MainPID: '0' });
        }
      }
    }
    if (failAfter === verb) { failAfter = null; throw new Error('lost response'); }
    return { stdout: Buffer.alloc(0) };
  }, async () => {}, async () => {
    assert.equal(blockedCgroup, false, 'remaining service process');
  });
  const inspect = async path => {
    const within = relative(directory, path);
    assert.ok(within === '' || (!within.startsWith('..') &&
      !within.startsWith('/')), 'resource must remain within the fixture');
    assert.equal(await realpath(path), path, 'fixture path must not use symlinks');
    for (let current = path; ; current = dirname(current)) {
      const stat = await lstat(current);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.uid, process.getuid(), 'fixture owner must match test identity');
      assert.equal(stat.mode & 0o022, 0, 'fixture must not permit untrusted writes');
      if (current === directory) break;
    }
  };
  const files = new NotificationCleanupFiles(contents, { config, root, units, inspect });
  const consumers = [{ ...origin, route: 'native' }];
  const ports = {
    consumers: async () => consumers,
    inspectBindings: async () => {
      if (changed) throw Object.assign(new Error(), { code: 'HOST_ADOPTION_CHANGED' });
    },
    recheckConsumers: async previous => assert.deepEqual(previous, consumers),
    verifyOwnership: async () => {
      await files.ownedUnits(); await files.configuration(consumers);
      await services.observe();
    },
    stopAndDisable: () => services.stopAndDisable(),
    requireStopped: () => services.requireStopped(),
    resources: () => files.resources(consumers),
    remove: file => files.remove(file), absent: file => files.absent(file),
    reload: () => services.reload(),
  };
  return { root, units, config, files, state, calls, ports, consumers,
    journal: new RelayJournal(root),
    failAfter: value => { failAfter = value; },
    unknown: value => { unknown = value; },
    changed: () => { changed = true; },
    blockedCgroup: () => { blockedCgroup = true; },
    run: () => withRelayGate(root, () => cleanupNotifications(ports)) };
}

test('native cleanup removes settled material, retains stable coordination, repeats',
  async t => {
    const f = await fixture(t);
    const result = await f.run();
    assert.equal(result.status, 'cleaned');
    assert.equal(result.removed.length, 5);
    assert.match(result.retained[0].purpose, /serialization/);
    assert.equal(await f.files.absent({ path: f.config }), true);
    const calls = f.calls.filter(([verb]) => ['stop', 'disable'].includes(verb));
    assert.deepEqual(calls, [
      ['stop', relayUnits[1]], ['disable', relayUnits[1]], ['stop', relayUnits[0]],
    ]);
    assert.equal((await f.run()).status, 'cleaned');
    assert.equal(f.calls.filter(([verb]) => verb === 'stop').length, 2);
  });

test('artifact and mixed consumers retain working shared resources', async t => {
  const f = await fixture(t);
  f.consumers.push({ repositoryId: 2, repository: 'owner/other', route: 'artifact' });
  const result = await f.run();
  assert.equal(result.status, 'retained');
  assert.equal(result.retained[0].repositoryId, 2);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.files.absent({ path: f.config }), false);
});

test('pending effects survive while settled records and cache are disposed', async t => {
  const f = await fixture(t);
  for (const [runId, status] of [[30, 'pending'], [31, 'consumed']]) {
    const origin = { repositoryId: 1, runId, attempt: 1 };
    await f.journal.write({ origin, status, intent: { origin } });
  }
  const result = await f.run();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.code, 'NOTIFICATION_EVIDENCE_RETAINED');
  assert.match(result.retained.find(item => item.unresolved).purpose, /dispatch/);
  assert.equal((await f.journal.records()).length, 1);
  assert.equal((await f.journal.records())[0].status, 'pending');
  assert.equal(await f.files.absent({ path: join(f.root, 'control.json') }), true);
  assert.equal((await f.run()).status, 'incomplete');
});

test('conflicting units, symlinks and unexpected references cannot disable services',
  async t => {
    for (const conflict of ['content', 'symlink', 'consumer', 'dropin']) {
      const f = await fixture(t);
      const path = join(f.units, relayUnits[0]);
      if (conflict === 'content') await writeFile(path, 'unrelated service');
      if (conflict === 'symlink') {
        await rm(path); await symlink(f.config, path);
      }
      if (conflict === 'consumer') f.consumers[0].repositoryId = 99;
      if (conflict === 'dropin') f.state.get(relayUnits[0]).DropInPaths = '/unexpected';
      assert.equal((await f.run()).status, 'incomplete');
      assert.deepEqual(f.calls, []);
    }
  });

test('lost stop and disable responses reuse observations on retry', async t => {
  for (const verb of ['stop', 'disable']) {
    const f = await fixture(t);
    f.failAfter(verb);
    assert.equal((await f.run()).status, 'incomplete');
    assert.equal((await f.run()).status, 'cleaned');
    assert.equal(f.calls.filter(args => args[0] === verb &&
      args[1] === relayUnits[1]).length, 1);
  }
});

test('lost removal retries without recreating resources', async t => {
  const f = await fixture(t);
  let lose = true;
  f.ports.remove = async file => {
    await f.files.remove(file);
    if (lose) { lose = false; throw new Error('lost removal response'); }
  };
  assert.equal((await f.run()).status, 'incomplete');
  assert.equal((await f.run()).status, 'cleaned');
  assert.equal((await f.run()).status, 'cleaned');
});

test('failed observations or live cgroups retain resources', async t => {
  for (const failure of ['unknown', 'changed', 'blockedCgroup']) {
    const f = await fixture(t);
    f[failure](true);
    assert.equal((await f.run()).status, 'incomplete');
    assert.equal(await f.files.absent({ path: f.config }), false);
  }
});

test('unknown material is retained; conflicting removal is refused', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'user-data');
  await writeFile(path, 'preserve');
  assert.equal((await f.run()).status, 'incomplete');
  assert.equal(await readFile(path, 'utf8'), 'preserve');
  const file = await f.files.snapshot(path);
  await writeFile(path, 'changed');
  await assert.rejects(f.files.remove(file), { code: 'NOTIFICATION_RESOURCE_CHANGED' });
});

test('native installation without obsolete files cleans without recreating them',
  async t => {
    const f = await fixture(t);
    await rm(f.root, { recursive: true });
    await rm(f.config);
    for (const name of relayUnits) {
      await rm(join(f.units, name));
      Object.assign(f.state.get(name), { LoadState: 'not-found', ActiveState: 'inactive',
        MainPID: '0', FragmentPath: '', UnitFileState: '' });
    }
    const result = await cleanupNotifications(f.ports);
    assert.equal(result.status, 'cleaned');
    assert.deepEqual(result.removed, []);
    assert.equal(await f.files.absent({ path: f.root }), true);
    assert.deepEqual(f.calls, [['daemon-reload']]);
  });

test('verified retired consumers permit the same owned resource cleanup', async t => {
  const f = await fixture(t);
  f.consumers[0].route = 'retired';
  assert.equal((await f.run()).status, 'cleaned');
});


test('cleanup preserves replacement attribution, recovery and unrelated retirement',
  async t => {
    for (const scenario of ['scheduled', 'lost-association', 'lost-removal']) {
      const f = await fixture(t);
      const record = { status: 'consumed', runId: 10,
        origin: { repositoryId: 1, runId: 2, attempt: 1 },
        intent: { source: { coreCommit: 'a'.repeat(40) },
          destination: { repositoryId: 20 },
          issue: { id: 'I_one', repositoryId: 1 } } };
      record.intent.origin = record.origin;
      await f.journal.write(record);
      const name = 'replacement-' + digest(record.origin) + '.json';
      const directory = join(f.root, name.slice(0, -5));
      await mkdir(directory, { mode: 0o700 });
      const operation = new OperationJournal(directory, record.intent.issue);
      const bindingHash = digest({ replacement: 1 });
      let posts = 0;
      const ports = {
        reconcile: async () => {},
        attempt: async () => ({ id: 10, run_attempt: 1,
          status: 'completed', conclusion: 'failure' }),
        read: () => readRelayState(f.root, name),
        write: (unused, value) => writeRelayState(f.root, name, value),
        admit: async () => {}, settle: async () => {},
        dispatch: () => operation.run({ operation: 'wake', bindingHash }, {
          admit: async () => bindingHash,
          perform: async () => { posts++; return 30; },
          readBack: async () => { throw new Error('lost response'); },
        }),
      };
      const recover = () => withRelayGate(f.root, () =>
        recoverStaleOrigin(record, 'b'.repeat(40), ports));
      const settle = id => settleLifecycleNotifications({
        pool: { repositoryId: id }, repositories: [],
      }, false, { root: f.root });
      await recover();
      await settle(99);
      for (let retry = 0; retry < 2; retry++) {
        assert.equal((await f.run()).code, 'NOTIFICATION_EVIDENCE_RETAINED');
        assert.deepEqual(await f.journal.read(record.origin),
          { schemaVersion: 1, ...record });
        await assert.rejects(settle(20), { code: 'EXTERNAL_EFFECT_UNKNOWN' });
        await settle(99);
      }
      ports.dispatch = assert.fail;
      ports.recover = async () => {
        const result = await operation.recoverWake(bindingHash, async runId => {
          assert.equal(runId, 30);
          return bindingHash;
        });
        return { status: 'scheduled', runId: result.runId };
      };
      // A completed effect with a still-pending association needs normal recovery.
      await operation.recoverWake(bindingHash, async () => bindingHash);
      assert.equal((await f.run()).code, 'NOTIFICATION_EVIDENCE_RETAINED');
      await recover();
      await writeRelayState(f.root, 'replacement-poll.json', { position: 0 });
      await settle(20);
      if (scenario === 'lost-association') await rm(join(f.root, name));
      if (scenario === 'lost-removal') {
        let lose = true;
        f.ports.remove = async file => {
          await f.files.remove(file);
          if (lose && file.path.startsWith(directory + '/')) {
            lose = false;
            throw new Error('lost replacement removal response');
          }
        };
        assert.equal((await f.run()).status, 'incomplete');
        assert.deepEqual(await f.journal.read(record.origin),
          { schemaVersion: 1, ...record });
      }
      const result = await f.run();
      assert.equal(result.status, 'cleaned');
      assert.equal(result.retained.some(item => item.unresolved), false);
      assert.equal(await f.files.absent({ path: directory }), true);
      assert.equal(await f.files.absent({ path: join(f.root, name) }), true);
      assert.equal(await f.journal.read(record.origin), null);
      assert.equal((await f.run()).status, 'cleaned');
      await settle(20);
      await settle(99);
      assert.equal(posts, 1);
    }
  });


test('association without an operation journal retains its consumed origin', async t => {
  const f = await fixture(t);
  const origin = { repositoryId: 1, runId: 40, attempt: 1 };
  await f.journal.write({ origin, status: 'consumed', runId: 41,
    intent: { origin, destination: { repositoryId: 20 } } });
  const name = 'replacement-' + digest(origin) + '.json';
  await writeRelayState(f.root, name, { status: 'pending', origin, originRunId: 41 });
  const result = await f.run();
  assert.equal(result.code, 'NOTIFICATION_EVIDENCE_RETAINED');
  assert.match(result.retained.find(item => item.path.endsWith(
    'origin-1-40-1.json')).purpose, /source attribution/);
  await settleLifecycleNotifications({ pool: { repositoryId: 99 }, repositories: [] },
    false, { root: f.root });
  await assert.rejects(settleLifecycleNotifications({
    pool: { repositoryId: 20 }, repositories: [],
  }, false, { root: f.root }), { code: 'ROLLOUT_REPLACEMENT_PENDING' });
});


test('settled replacement evidence retains locks, unknown files and changed directories',
  async t => {
    for (const conflict of ['execution.lock', 'recovery.lock', 'user-data', 'changed']) {
      const f = await fixture(t);
      const origin = { repositoryId: 1, runId: 50, attempt: 1 };
      const issue = { id: 'I_one', repositoryId: 1 };
      await f.journal.write({ origin, status: 'consumed', runId: 51,
        intent: { origin, issue, destination: { repositoryId: 20 } } });
      const name = 'replacement-' + digest(origin);
      const directory = join(f.root, name);
      await mkdir(directory, { mode: 0o700 });
      const operation = new OperationJournal(directory, issue);
      const bindingHash = digest({ replacement: 1 });
      await operation.run({ operation: 'wake', bindingHash }, {
        admit: async () => bindingHash, perform: async () => 52,
        readBack: async () => bindingHash,
      });
      await writeRelayState(f.root, name + '.json', {
        status: 'scheduled', origin, originRunId: 51, replacementRunId: 52,
      });
      const child = join(directory,
        digest({ issueId: issue.id, repositoryId: issue.repositoryId }));
      if (conflict === 'changed') {
        const snapshot = await f.files.directorySnapshot(child);
        await assert.rejects(f.files.remove(snapshot),
          { code: 'NOTIFICATION_RESOURCE_CHANGED' });
      } else {
        const path = join(child, conflict);
        await writeFile(path, 'preserve', { mode: 0o600 });
        const result = await f.run();
        assert.equal(result.code, 'NOTIFICATION_EVIDENCE_RETAINED');
        assert.equal(await readFile(path, 'utf8'), 'preserve');
        assert.ok(await f.journal.read(origin));
        assert.equal(await f.files.absent({ path: join(child, 'receipts.json') }), false);
        // Removing the controlled obstruction permits normal cleanup re-entry.
        await rm(path);
      }
      assert.equal((await f.run()).status, 'cleaned');
      assert.equal((await f.run()).status, 'cleaned');
    }
  });
