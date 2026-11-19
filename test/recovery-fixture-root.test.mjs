import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile }
  from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recoveryFixtureRoot } from './recovery-fixture-root.mjs';
import { deliverRecoveryFixture } from './deliver-recovery-fixture.mjs';
import { safePath } from '../src/local-work-files.mjs';

const linux = { skip: process.platform !== 'linux' };
const childScript = fileURLToPath(new URL('./fixtures/recovery-root-child.mjs',
  import.meta.url));
const contained = (base, path) => {
  const value = relative(base, path);
  assert.ok(value && value !== '..' && !value.startsWith('../'));
};
const hooks = () => {
  const callbacks = [];
  return { after: fn => callbacks.push(fn),
    close: async () => {
      for (const callback of callbacks.reverse()) await callback();
    } };
};

test('unsupported hosts report setup separately before creating a fixture', {
  skip: process.platform === 'linux',
}, async t => {
  await assert.rejects(recoveryFixtureRoot(t), error => {
    assert.equal(error.code, 'RECOVERY_FIXTURE_SETUP_UNAVAILABLE');
    assert.equal(error.cause.code, 'UNSUPPORTED_JOURNAL_HOST');
    assert.equal(error.root, undefined);
    return true;
  });
});

test('explicit base overrides an unusable standard default without env mutation',
  linux, async t => {
    const base = (await recoveryFixtureRoot(t)).root;
    const badDefault = join(base, 'missing-default');
    const original = process.env.TMPDIR;
    const result = spawnSync(process.execPath, [childScript, base], {
      encoding: 'utf8', env: { ...process.env,
        TMPDIR: badDefault, TMP: badDefault, TEMP: badDefault },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    contained(base, observed.root);
    contained(observed.root, observed.output);
    contained(observed.root, observed.child.root);
    assert.equal(observed.temporary, badDefault);
    assert.equal(observed.child.temporary, observed.root);
    assert.equal(process.env.TMPDIR, original);
    await assert.rejects(lstat(observed.root), { code: 'ENOENT' });
    await assert.rejects(lstat(badDefault), { code: 'ENOENT' });
  });

test('missing selected base fails with original cause and never falls back',
  linux, async t => {
    const parent = (await recoveryFixtureRoot(t)).root;
    const selected = join(parent, 'absent');
    await assert.rejects(recoveryFixtureRoot(t, { base: selected }), error => {
      assert.equal(error.code, 'RECOVERY_FIXTURE_SETUP_UNAVAILABLE');
      assert.equal(error.cause.code, 'ENOENT');
      assert.equal(error.base, selected);
      return true;
    });
    assert.deepEqual(await readdir(parent), []);
  });

test('concurrent fixtures isolate output and cleanup only the owning root',
  linux, async t => {
    const base = (await recoveryFixtureRoot(t)).root;
    const firstHooks = hooks(), secondHooks = hooks();
    t.after(() => secondHooks.close());
    const [first, second] = await Promise.all([
      recoveryFixtureRoot(firstHooks, { base }),
      recoveryFixtureRoot(secondHooks, { base }),
    ]);
    assert.notEqual(first.root, second.root);
    for (const fixture of [first, second]) {
      contained(base, fixture.root);
      await writeFile(join(fixture.root, 'output'), fixture.root, { mode: 0o600 });
      await safePath(join(fixture.root, 'output'), process.getuid());
    }
    await writeFile(join(base, 'user-file'), 'retain');
    await firstHooks.close();
    await assert.rejects(lstat(first.root), { code: 'ENOENT' });
    assert.equal(await readFile(join(second.root, 'output'), 'utf8'), second.root);
    assert.equal(await readFile(join(base, 'user-file'), 'utf8'), 'retain');
    await first.cleanup();
  });

test('unsafe ancestry is setup unavailable, not a recovery result', linux, async t => {
  const parent = (await recoveryFixtureRoot(t)).root;
  const base = join(parent, 'unsafe');
  await mkdir(base, { mode: 0o777 });
  await chmod(base, 0o777);
  const owned = hooks();
  let rejectedRoot;
  await assert.rejects(recoveryFixtureRoot(owned, { base }), error => {
    assert.equal(error.code, 'RECOVERY_FIXTURE_SETUP_UNAVAILABLE');
    assert.equal(error.cause.code, 'UNTRUSTED_EVIDENCE');
    rejectedRoot = error.root;
    return true;
  });
  assert.equal((await lstat(rejectedRoot)).mode & 0o777, 0o700);
  await owned.close();
  assert.deepEqual(await readdir(base), []);
  assert.equal((await lstat(base)).mode & 0o777, 0o777);
});

test('symlink base is refused before any fixture is generated', linux, async t => {
  const parent = (await recoveryFixtureRoot(t)).root;
  const target = join(parent, 'target'), link = join(parent, 'link');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  await assert.rejects(recoveryFixtureRoot(t, { base: link }), error => {
    assert.equal(error.cause.code, 'RECOVERY_FIXTURE_DIRECTORY_CHANGED');
    return true;
  });
  assert.deepEqual(await readdir(target), []);
});

test('cleanup refuses a replaced root and preserves replacement data', linux,
  async t => {
    const base = (await recoveryFixtureRoot(t)).root;
    const owned = hooks();
    const fixture = await recoveryFixtureRoot(owned, { base });
    const original = join(base, 'original');
    await rename(fixture.root, original);
    await mkdir(fixture.root, { mode: 0o700 });
    await writeFile(join(fixture.root, 'retain'), 'replacement');
    await assert.rejects(owned.close(), { code: 'RECOVERY_FIXTURE_DIRECTORY_CHANGED' });
    assert.equal(await readFile(join(fixture.root, 'retain'), 'utf8'), 'replacement');
    await rm(fixture.root, { recursive: true });
    await rename(original, fixture.root);
    await fixture.cleanup();
  });

test('explicit recovery root reaches durable recovery and inert repeat', linux,
  async t => {
    const base = (await recoveryFixtureRoot(t)).root;
    const fixture = await deliverRecoveryFixture(t, 'shape', { base });
    contained(base, fixture.root);
    assert.equal(fixture.environment.TMPDIR, fixture.root);
    const journalPath = join(fixture.journalRoot, 'receipts.json');
    const journal = await readFile(journalPath, 'utf8');
    const receipts = await fixture.store.load();
    assert.equal((await fixture.recover()).status, 'completed');
    assert.equal(fixture.observations(), 3);
    const archiveName = (await readdir(fixture.issueRoot))
      .find(name => name.startsWith('settled-'));
    const archive = join(fixture.issueRoot, archiveName);
    const recorded = await lstat(archive);
    assert.equal((await fixture.recover()).status, 'completed');
    assert.equal(fixture.observations(), 3);
    assert.equal((await lstat(archive)).mtimeMs, recorded.mtimeMs);
    assert.equal(await readFile(journalPath, 'utf8'), journal);
    assert.deepEqual(await fixture.store.load(), receipts);
    assert.equal(fixture.effects, 1);
  });

test('explicit recovery root retains changed-evidence refusal after recording',
  linux, async t => {
    const base = (await recoveryFixtureRoot(t)).root;
    const fixture = await deliverRecoveryFixture(t, 'deliver', { base });
    fixture.options.afterRecord = async () => {
      await writeFile(fixture.inputPath, '{}', { mode: 0o644 });
    };
    const result = await fixture.recover();
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'RECOVERY_EVIDENCE_CHANGED');
    assert.equal(await readFile(fixture.fencePath, 'utf8'), fixture.fenceBytes);
    assert.equal((await lstat(dirname(fixture.inputPath))).mode & 0o777, 0o700);
  });
