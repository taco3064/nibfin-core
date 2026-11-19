import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runnerEntryIdentity } from '../src/runner-refresh-files.mjs';
import { cleanupRefreshEntries, requireNoRefreshReferences }
  from '../src/runner-refresh-cleanup.mjs';
import { createRefreshWorkspace, recoverRunnerRefresh, runnerRefreshMarker }
  from '../src/runner-refresh-workspace.mjs';

const supported = process.platform === 'linux' && process.getuid?.() === 0;
const options = { skip: !supported && 'requires eligible root-owned Linux fixtures' };

async function fixture(t) {
  const parent = resolve('.deliver-test-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'refresh-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'previous');
  await mkdir(directory, { mode: 0o700 });
  const known = join(directory, 'known');
  await writeFile(known, 'verified old package bytes', { mode: 0o600 });
  const entries = [{ name: 'known', previous: await runnerEntryIdentity(known) }];
  return { root, directory, known, entries };
}

test('open file descriptors preserve known material and unknown files remain untouched',
  options, async t => {
    const f = await fixture(t);
    const foreign = join(f.directory, 'foreign');
    await writeFile(foreign, 'user-owned unrelated fixture');
    const proc = join(f.root, 'proc');
    await mkdir(proc, { mode: 0o700 });
    await symlink(`/proc/${process.pid}`, join(proc, String(process.pid)));
    const file = await open(f.known, 'r');
    const ports = { references: path => requireNoRefreshReferences(path, { proc }) };
    try {
      const held = await cleanupRefreshEntries(f.directory, f.entries, 'previous', ports);
      assert(held.retained.some(entry => entry.path === f.known &&
        entry.code === 'RUNNER_REFRESH_PREVIOUS_IN_USE'));
      assert.equal(await readFile(foreign, 'utf8'), 'user-owned unrelated fixture');
    } finally { await file.close(); }
    const settled = await cleanupRefreshEntries(f.directory, f.entries,
      'previous', ports);
    assert(settled.removed.includes(f.known));
    assert(settled.retained.some(entry => entry.path === foreign));
    assert.equal(await readFile(foreign, 'utf8'), 'user-owned unrelated fixture');
  });

test('changed prior and a failed reference read preserve affected entries', options,
  async t => {
    const f = await fixture(t);
    await writeFile(f.known, 'unknown changed prior');
    const changed = await cleanupRefreshEntries(f.directory, f.entries, 'previous');
    assert.equal(changed.retained[0].code, 'RUNNER_REFRESH_RESOURCE_CHANGED');
    assert.equal(await readFile(f.known, 'utf8'), 'unknown changed prior');
    f.entries[0].previous = await runnerEntryIdentity(f.known);
    const unknown = await cleanupRefreshEntries(f.directory, f.entries, 'previous', {
      references: async () => {
        throw Object.assign(Error('read failed'), { code: 'EIO' });
      },
    });
    assert.equal(unknown.retained[0].code, 'EIO');
    assert.equal(await readFile(f.known, 'utf8'), 'unknown changed prior');
  });

test('lost delete response reuses confirmed native absence', options, async t => {
  const f = await fixture(t);
  let deletes = 0;
  const result = await cleanupRefreshEntries(f.directory, f.entries, 'previous', {
    references: async () => {},
    remove: async path => { deletes++; await rm(path); throw Error('response lost'); },
  });
  assert.deepEqual(result.removed, [f.known]);
  assert.deepEqual(result.retained, []);
  await cleanupRefreshEntries(f.directory, f.entries, 'previous', {
    remove: async () => { deletes++; },
  });
  assert.equal(deletes, 1);
});

test('owned marker recovers required facts without a second state journal', options,
  async t => {
    const f = await fixture(t), parent = join(f.root, 'operations');
    const workspace = await createRefreshWorkspace(parent);
    const binding = { pool: { runners: [{ id: 1 }, { id: 2 }] } };
    const state = { schemaVersion: 1, phase: 'applying', workspace, binding,
      selected: { artifact: { name: 'selected official package' } },
      running: [true, false], slots: { 1: { entries: [] }, 2: { entries: [] } } };
    const marker = runnerRefreshMarker(state);
    const recovered = await recoverRunnerRefresh(marker, binding, { parent });
    assert.equal(recovered.phase, 'draining');
    assert.deepEqual(recovered.running, [true, false]);
    assert.deepEqual(recovered.workspace, workspace);
    recovered.slots[1].staged = 'new observation';
    assert.equal(marker.recovery.slots[1].staged, undefined,
      'mutable observation must not rewrite the admitted recovery facts');
    await assert.rejects(recoverRunnerRefresh(marker, { different: true }, { parent }),
      { code: 'RUNNER_REFRESH_BINDING_CHANGED' });
    await rename(workspace.path, workspace.path + '-retained');
    await mkdir(workspace.path, { mode: 0o700 });
    await assert.rejects(recoverRunnerRefresh(marker, binding, { parent }),
      { code: 'RUNNER_REFRESH_WORKSPACE_CHANGED' });
  });

test('a foreign admission marker is preserved by runtime recovery', async () => {
  const marker = { schemaVersion: 1, retirementId: 'some other operation' };
  assert.equal(await recoverRunnerRefresh(marker, {}), null);
  assert.deepEqual(marker, { schemaVersion: 1, retirementId: 'some other operation' });
});
