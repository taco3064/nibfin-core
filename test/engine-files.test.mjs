import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileDouble } from './file-store-fixture.mjs';

test('filesystem creation, exact adoption and atomic journal updates leave no scratch',
  async () => {
    const { nodes, store } = fileDouble();
    await store.ownedDirectory('/owned/dir');
    await store.ownedDirectory('/owned/dir');
    await store.installEngineFile('/owned/config', 'fixed');
    await store.installEngineFile('/owned/config', 'fixed');
    await store.saveEngineState('/owned/state.json', { effect: 'pending' }, null);
    assert.deepEqual(await store.readEngineState('/owned/state.json'),
      { effect: 'pending' });
    await store.saveEngineState('/owned/state.json', { effect: 'complete' },
      { effect: 'pending' });
    assert.deepEqual(await store.readEngineState('/owned/state.json'),
      { effect: 'complete' });
    assert.deepEqual([...nodes.keys()].sort(), [
      '/owned', '/owned/config', '/owned/dir', '/owned/state.json',
    ]);
    assert.equal(nodes.get('/owned/config').nlink, 1);
  });

test('conflicting bytes, links, ownership and permissions are never overwritten',
  async () => {
    for (const change of [node => { node.bytes = 'unrelated'; },
      node => { node.kind = 'link'; }, node => { node.uid = 1000; },
      node => { node.mode = 0o666; }, node => { node.nlink = 2; }]) {
      const { nodes, store } = fileDouble();
      await store.installEngineFile('/owned/config', 'fixed');
      change(nodes.get('/owned/config'));
      const before = structuredClone(nodes.get('/owned/config'));
      await assert.rejects(store.installEngineFile('/owned/config', 'fixed'));
      assert.deepEqual(nodes.get('/owned/config'), before);
    }
  });

test('changed journal contents and directory owners prevent adoption', async () => {
  const { nodes, store } = fileDouble();
  await store.saveEngineState('/owned/state.json', { effect: 'pending' }, null);
  await assert.rejects(store.saveEngineState('/owned/state.json', {}, {}),
    { code: 'ENGINE_FILE_CONFLICT' });
  await store.ownedDirectory('/owned/dir');
  nodes.get('/owned/dir').gid = 1000;
  await assert.rejects(store.ownedDirectory('/owned/dir'),
    { code: 'ENGINE_DIRECTORY_CONFLICT' });
});

test('unexpected managed directory entries are refused and preserved', async () => {
  const { nodes, store } = fileDouble();
  await store.installEngineFile('/owned/config', 'fixed');
  await store.requireDirectoryEntries('/owned', ['config']);
  await store.installEngineFile('/owned/unrelated', 'preserve');
  await assert.rejects(store.requireDirectoryEntries('/owned', ['config']),
    { code: 'ENGINE_UNEXPECTED_RESOURCE' });
  assert.equal(nodes.get('/owned/unrelated').bytes, 'preserve');
});

test('new owned directories receive their exact mode despite a restrictive umask',
  async () => {
    const { store, nodes } = fileDouble(0o077);
    await store.ownedDirectory('/owned/public', 0o755);
    assert.equal(nodes.get('/owned/public').mode, 0o755);
    nodes.get('/owned/public').mode = 0o700;
    await assert.rejects(store.ownedDirectory('/owned/public', 0o755),
      { code: 'ENGINE_DIRECTORY_CONFLICT' });
    assert.equal(nodes.get('/owned/public').mode, 0o700);
  });
