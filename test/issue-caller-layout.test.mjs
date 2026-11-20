import assert from 'node:assert/strict';
import test from 'node:test';
import { observePeer, refreshInstalledIssueCaller }
  from '../src/shared-peer-adoption.mjs';
import { callerRecipeVariants } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';
import { fixture, name, root, head, source, actionCommit, memberId }
  from './peer-adoption-fixture.mjs';

const treePath = root + '/git/trees/' + head;
const actionPath = '.github/workflows/nibfin-wake.yml';
const issuePath = '.github/workflows/nibfin-issue.yml';

function setup({ action = false, primary = false, kind = 'issue', variant = 0,
  newline = '\n', retained = true } = {}) {
  const reader = fixture();
  const entry = (path, type, sha) => ({ path, type, sha });
  const tree = (entries, sha = head) => ({ sha, truncated: false, tree: entries });
  reader.replies.set(treePath, tree([entry('.github', 'tree', 'd'.repeat(40))]));
  reader.replies.set(root + '/git/trees/' + 'd'.repeat(40),
    tree([entry('workflows', 'tree', 'e'.repeat(40))], 'd'.repeat(40)));
  reader.replies.set(root + '/git/trees/' + 'e'.repeat(40), tree(action
    ? [entry('nibfin-wake.yml', 'blob', reader.replies.get(
      root + '/contents/' + actionPath + '?ref=' + head).sha)] : [],
    'e'.repeat(40)));
  const bytes = callerRecipeVariants(kind, source.commit)[variant]
    .replaceAll('\n', newline);
  const file = reader.replies.get(root + '/contents/' + issuePath + '?ref=' + head);
  file.content = Buffer.from(bytes).toString('base64');
  file.sha = gitBlob(bytes);
  const pin = { ...source, manifestHash: 'f'.repeat(64) };
  const target = { memberId, installation: { pin }, issues: { 7: { state: 'keep' } },
    repository: {
      approval: { repository: name, repositoryId: 123, memberId },
      eventRunner: { workflowId: 11, workflowPath: issuePath, runnerId: 56,
        reusable: { commit: source.commit },
        workflowBlob: gitBlob(callerRecipeVariants(
          kind === 'issue' ? 'issue-managed' : 'issue', source.commit)[variant]) },
      ...(retained ? { runner: { actionCommit, workflowId: 22,
        workflowPath: actionPath, workflowBlob: reader.replies.get(
          root + '/contents/' + actionPath + '?ref=' + head).sha } } : {}),
    } };
  const peerPath = '/etc/nibfin/host.peer-123.json';
  const host = { ...structuredClone(target), sharedRunner: { repositories: [123] },
    wakePeerFiles: primary ? [] : [peerPath] };
  if (!primary) host.repository.approval.repositoryId = 456;
  const files = new Map([['primary', JSON.stringify(host)],
    [peerPath, JSON.stringify(target)]]);
  const targetPath = primary ? 'primary' : peerPath;
  const original = JSON.parse(files.get(targetPath));
  const pool = { repositoryId: primary ? 123 : 456,
    runners: [{ id: 56, name: 'one' }, { id: 57, name: 'two' }] };
  const calls = [];
  let writes = 0;
  const io = {
    hostFile: 'primary', registrations: () => pool,
    requireAdoptionAllowed: async () => { calls.push('admission'); },
    compareProviderViews: () => { calls.push('provider'); },
    verifySource: async value => { assert.deepEqual(value, pin); return source; },
    reader: async () => reader,
    read: async path => ({ path, bytes: files.get(path),
      value: JSON.parse(files.get(path)) }),
    readBytes: async path => files.get(path),
    replace: async (path, value) => {
      writes++;
      files.set(path, JSON.stringify(value));
    },
  };
  reader.replies.set('/repos/taco3064/nibfin-act/contents/core-source.json?ref=' +
    actionCommit, { type: 'file', encoding: 'base64',
    content: Buffer.from(JSON.stringify(pin)).toString('base64') });
  if (!action) {
    reader.replies.delete(root + '/contents/' + actionPath + '?ref=' + head);
    reader.replies.delete('/repos/taco3064/nibfin-act/contents/core-source.json?ref=' +
      actionCommit);
  }
  return { reader, io, files, calls, original, targetPath, pool,
    writes: () => writes,
    run: () => refreshInstalledIssueCaller(name, 123, io) };
}

for (const action of [false, true]) {
  for (const primary of [false, true]) {
    test(`refresh orchestration action=${action} primary=${primary}`, async () => {
      for (const kind of ['issue', 'issue-managed']) {
        for (const variant of [0, 1]) {
          for (const newline of ['\n', '\r\n']) {
            const f = setup({ action, primary, kind, variant, newline });
            assert.deepEqual(await f.run(), { status: 'adopted', repositoryId: 123,
              runners: f.pool.runners });
            const actual = JSON.parse(f.files.get(f.targetPath));
            const expected = structuredClone(f.original);
            expected.repository.eventRunner = actual.repository.eventRunner;
            assert.deepEqual(actual, expected);
            assert.equal((await f.run()).status, 'unchanged');
            assert.equal(f.writes(), 1);
            assert.deepEqual(f.calls, ['admission', 'provider', 'admission', 'provider']);
          }
        }
      }
    });
  }
  for (const committed of [false, true]) {
    test(`orchestration retry action=${action} committed=${committed}`, async () => {
      const f = setup({ action });
      const replace = f.io.replace;
      f.io.replace = async (...args) => {
        if (committed) await replace(...args);
        throw new Error('lost response');
      };
      await assert.rejects(f.run(), /lost response/);
      f.io.replace = replace;
      assert.equal((await f.run()).status, committed ? 'unchanged' : 'adopted');
      assert.equal(f.writes(), 1);
    });
  }
}

test('Issue-only has no Action prerequisite, but other consumers still require it',
  async () => {
    const f = setup({ retained: false });
    assert.equal((await f.run()).status, 'adopted');
    await assert.rejects(observePeer(f.reader, name, 123, memberId, source,
      actionCommit));
  });

test('failed and malformed tree observations never establish absence', async () => {
  for (const reply of [null, {}, { sha: head, truncated: true, tree: [] },
    { sha: head, truncated: false, tree: [{ path: '.github', type: 'blob' }] }]) {
    const f = setup();
    f.reader.replies.set(treePath, reply);
    await assert.rejects(f.run(), /PEER_WORKFLOW_TREE_UNVERIFIED/);
    assert.equal(f.writes(), 0);
  }
  const f = setup();
  const get = f.reader.get;
  f.reader.get = async path => {
    if (path === treePath) throw new Error('provider unavailable');
    return get(path);
  };
  await assert.rejects(f.run(), /provider unavailable/);
  assert.equal(f.writes(), 0);
});

test('present Action retains recipe, source and adopted identity checks', async () => {
  for (const change of ['recipe', 'source', 'identity', 'member']) {
    const f = setup({ action: true });
    if (change === 'recipe' || change === 'member') {
      const file = f.reader.replies.get(root + '/contents/' + actionPath +
        '?ref=' + head);
      const body = change === 'recipe' ? 'foreign workflow\n' :
        callerRecipeVariants('action-dispatch', source.commit,
          { actionCommit, memberId: memberId + 1 })[0];
      file.content = Buffer.from(body).toString('base64');
      file.sha = gitBlob(body);
      f.reader.replies.get(root + '/git/trees/' + 'e'.repeat(40))
        .tree[0].sha = file.sha;
    } else if (change === 'source') {
      const file = f.reader.replies.get(
        '/repos/taco3064/nibfin-act/contents/core-source.json?ref=' + actionCommit);
      file.content = Buffer.from('{}').toString('base64');
    } else {
      f.reader.replies.get(root + '/actions/workflows/nibfin-wake.yml').id = 99;
    }
    await assert.rejects(f.run(), new RegExp(change === 'source'
      ? 'PEER_ACTION_SOURCE_MISMATCH' : change === 'identity'
        ? 'MANAGED_ISSUE_TRANSITION_CONFLICT' : 'CALLER_NOT_FIXED_RECIPE'));
    assert.equal(f.writes(), 0);
  }
});

test('layout-aware observation still rejects default-branch movement', async () => {
  const f = setup();
  const get = f.reader.get;
  let branches = 0;
  f.reader.get = async path => {
    const value = await get(path);
    if (path === root + '/branches/main' && ++branches === 2)
      return { ...value, commit: { sha: 'f'.repeat(40) } };
    return value;
  };
  await assert.rejects(f.run(), /PEER_DEFAULT_BRANCH_CHANGED/);
  assert.equal(f.writes(), 0);
});

test('contradictory tree identities and Action content fail closed', async () => {
  for (const path of [root + '/git/trees/' + 'd'.repeat(40),
    root + '/git/trees/' + 'e'.repeat(40)]) {
    const f = setup({ action: true });
    f.reader.replies.get(path).sha = 'f'.repeat(40);
    await assert.rejects(f.run(), /PEER_WORKFLOW_TREE_UNVERIFIED/);
    assert.equal(f.writes(), 0);
  }
  const f = setup({ action: true });
  f.reader.replies.get(root + '/git/trees/' + 'e'.repeat(40))
    .tree[0].sha = 'f'.repeat(40);
  await assert.rejects(f.run(), /PEER_WORKFLOW_NOT_VERIFIED/);
  assert.equal(f.writes(), 0);
});

test('orchestration keeps host admission and consistency failures', async () => {
  for (const dependency of ['requireAdoptionAllowed', 'compareProviderViews',
    'verifySource', 'reader', 'readBytes']) {
    const f = setup();
    f.io[dependency] = () => { throw new Error('controlled refusal'); };
    await assert.rejects(f.run(), /controlled refusal/);
    assert.equal(f.writes(), 0);
  }
});

test('retained Action fields do not select the Issue-only layout', async () => {
  const f = setup();
  const prior = JSON.parse(f.files.get(f.targetPath));
  prior.repository.runner.actionCommit = 'obsolete historical value';
  f.files.set(f.targetPath, JSON.stringify(prior));
  assert.equal((await f.run()).status, 'adopted');
  assert.deepEqual(JSON.parse(f.files.get(f.targetPath)).repository.runner,
    prior.repository.runner);
});
