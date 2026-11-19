import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshObservedIssueCaller } from '../src/shared-peer-adoption.mjs';
import { callerRecipe, callerRecipeVariants } from '../src/caller-recipes.mjs';
import { gitBlob } from '../src/identity.mjs';

const commit = 'b'.repeat(40);
const head = 'a'.repeat(40);
const workflowPath = '.github/workflows/nibfin-issue.yml';
const blob = (kind, crlf = false) => gitBlob(crlf
  ? callerRecipe(kind, commit).replaceAll('\n', '\r\n')
  : callerRecipe(kind, commit));

function fixture(titleless = false) {
  const original = {
    memberId: 77, providerBinding: { provider: 'codex' }, roles: ['writer'],
    sharedRunner: { repositories: [123, 456] },
    repository: {
      approval: { repositoryId: 123, memberId: 77 },
      runner: { runnerId: 56, workflowId: 22 },
      eventRunner: {
        workflowId: 11, workflowPath,
        workflowBlob: gitBlob(callerRecipeVariants('issue-managed', commit)
          [titleless ? 1 : 0]),
        sourceCommit: 'd'.repeat(40), reusable: { commit }, runnerId: 56,
      },
    },
  };
  const files = new Map([['primary', JSON.stringify({ pool: 'unchanged' })],
    ['peer', JSON.stringify(original)]]);
  const pool = { runners: [{ id: 56, name: 'one' }, { id: 57, name: 'two' }] };
  const observed = { head, issue: {
    workflowId: 11, workflowPath, workflowBlob: blob('issue'),
  } };
  let writes = 0;
  const io = {
    readBytes: async path => files.get(path),
    read: async path => ({ path, bytes: files.get(path),
      value: JSON.parse(files.get(path)) }),
    replace: async (path, value) => {
      writes++;
      files.set(path, JSON.stringify(value));
    },
  };
  const run = async () => refreshObservedIssueCaller(
    await io.read('primary'), await io.read('peer'), pool, observed, commit, io,
  );
  return { original, files, pool, observed, io, run, writes: () => writes };
}

test('native refresh preserves all unrelated adoption and both Runner identities',
  async () => {
    const f = fixture();
    assert.deepEqual(await f.run(), {
      status: 'adopted', repositoryId: 123, runners: f.pool.runners,
    });
    const expected = structuredClone(f.original);
    Object.assign(expected.repository.eventRunner, f.observed.issue,
      { sourceCommit: head });
    assert.deepEqual(JSON.parse(f.files.get('peer')), expected);
    assert.equal((await f.run()).status, 'unchanged');
    assert.equal(f.writes(), 1);
  });

for (const titleless of [false, true]) {
  for (const committed of [false, true]) {
    const description = `refresh response loss, committed=${committed}, old=${titleless}`;
    test(description, async () => {
      const f = fixture(titleless);
      const replace = f.io.replace;
      f.io.replace = async (...args) => {
        if (committed) await replace(...args);
        throw new Error('response lost');
      };
      await assert.rejects(f.run(), /response lost/);
      f.io.replace = replace;
      assert.equal((await f.run()).status, committed ? 'unchanged' : 'adopted');
      assert.equal(f.writes(), 1);
    });
  }
}

test('refresh rejects changed adoption and failed reads', async () => {
  const f = fixture();
  const readBytes = f.io.readBytes;
  f.io.readBytes = async () => 'changed';
  await assert.rejects(f.run(), { code: 'HOST_ADOPTION_CHANGED' });
  assert.equal(f.writes(), 0);
  f.io.readBytes = async () => { throw new Error('observation unavailable'); };
  await assert.rejects(f.run(), /observation unavailable/);
  assert.equal(f.writes(), 0);
  f.io.readBytes = readBytes;
  const read = f.io.read;
  f.io.read = async path => {
    const result = await read(path);
    if (f.writes()) result.value.memberId = 99;
    return result;
  };
  await assert.rejects(f.run(), { code: 'PEER_ADOPTION_UNVERIFIED' });
  f.io.read = read;
  assert.equal((await f.run()).status, 'unchanged');
  assert.equal(f.writes(), 1);
});

test('refresh accepts both line endings and rejects caller identity/source drift',
  async () => {
    for (const kind of ['issue', 'issue-managed']) {
      const f = fixture();
      f.observed.issue.workflowBlob = blob(kind, true);
      assert.equal((await f.run()).status, 'adopted');
      assert.equal((await f.run()).status, 'unchanged');
    }
    for (const mismatch of [
      { workflowId: 12 }, { workflowPath: '.github/workflows/other.yml' },
      { workflowBlob: 'e'.repeat(40) },
    ]) {
      const f = fixture();
      Object.assign(f.observed.issue, mismatch);
      await assert.rejects(f.run(), { code: 'MANAGED_ISSUE_TRANSITION_CONFLICT' });
      assert.equal(f.writes(), 0);
    }
    const f = fixture();
    const prior = JSON.parse(f.files.get('peer'));
    prior.repository.eventRunner.reusable.commit = 'c'.repeat(40);
    f.files.set('peer', JSON.stringify(prior));
    await assert.rejects(f.run(), { code: 'MANAGED_ISSUE_TRANSITION_CONFLICT' });
  });

test('refresh recognizes titleless Issue blobs with either line ending', async () => {
  for (const kind of ['issue', 'issue-managed']) {
    for (const newline of ['\n', '\r\n']) {
      const f = fixture();
      f.observed.issue.workflowBlob = gitBlob(
        callerRecipeVariants(kind, commit)[1].replaceAll('\n', newline));
      assert.equal((await f.run()).status, 'adopted');
      assert.equal((await f.run()).status, 'unchanged');
      assert.equal(f.writes(), 1);
    }
  }
});
