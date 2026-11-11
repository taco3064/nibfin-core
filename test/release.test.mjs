import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  releaseAssets,
  planRelease,
  ReleaseDraft,
  verifyPublishedRelease,
} from '../src/release.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { digest, sha256 } from '../src/identity.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
      repository: 'taco3064/nibfin-core',
      commit: 'a'.repeat(40),
      files: [],
    },
    bytes = Buffer.from('Synthetic archive');
  const built = {
    manifest,
    manifestHash: digest(manifest),
    bytes,
    sha256: sha256(bytes),
  };
  let release,
    assets = [],
    effects = 0,
    fault;
  const repo = {
    id: 10,
    full_name: manifest.repository,
    private: false,
    default_branch: 'main',
  };
  const tag = {
    ref: 'refs/tags/v1.0.0',
    object: { type: 'commit', sha: manifest.commit },
  };
  const reader = {
    repository: async () => structuredClone(repo),
    get: async (path) => {
      if (path.includes('/git/ref/tags/')) return structuredClone(tag);
      if (path.endsWith('/releases/20')) return structuredClone(release);
      throw new Error(`Unexpected path ${path}`);
    },
    list: async (path) =>
      path.endsWith('/assets')
        ? structuredClone(assets)
        : release
          ? [structuredClone(release)]
          : [],
  };
  const plan = await planRelease(reader, { version: 'v1.0.0', built });
  const adapter = new ReleaseDraft({
    reader,
    token: 'synthetic-token',
    journal: new OperationJournal(root, { repositoryId: 10, id: 'release-v1.0.0' }),
    admit: async (p) => {
      if (fault === 'revoked' && effects > 0) throw new Error('Revoked');
      return digest(p);
    },
    fetcher: async (url, options) => {
      effects++;
      assert.equal(options.redirect, 'error');
      if (fault === 'lost') throw new Error('Lost response');
      if (url.startsWith('https://api.github.com/')) {
        release = { ...JSON.parse(options.body), id: 20, published_at: null };
        assert.equal(release.draft, true);
        return { ok: true, json: async () => release };
      }
      assert.ok(
        url.startsWith(
          'https://uploads.github.com/repos/taco3064/nibfin-core/releases/20/assets?',
        ),
      );
      const name = new URL(url).searchParams.get('name'),
        asset = {
          id: 30 + assets.length,
          name,
          size: options.body.length,
          state: 'uploaded',
          digest: `sha256:${sha256(options.body)}`,
          browser_download_url:
            `https://github.com/taco3064/nibfin-core/releases/download/v1.0.0/${name}`,
        };
      assets.push(asset);
      return { ok: true, json: async () => asset };
    },
  });
  const expected = {
    repository: repo.full_name,
    repositoryId: 10,
    releaseId: 20,
    version: 'v1.0.0',
    publisherId: 9,
    commit: manifest.commit,
    archiveHash: built.sha256,
    manifestHash: built.manifestHash,
  };
  const download = async (url) =>
    releaseAssets(built).find((f) => url.endsWith('/' + f.name)).bytes;
  return {
    reader,
    built,
    plan,
    adapter,
    tag,
    expected,
    download,
    effects: () => effects,
    fault: (value) => {
      fault = value;
    },
    publish: () => {
      Object.assign(release, {
        draft: false,
        immutable: true,
        published_at: '2026-11-03T00:00:00Z',
        author: { id: 9 },
      });
    },
    mutate: (fn) => fn(release, assets),
  };
}

test('release plan requires the matching tag and reproducible build', async (t) => {
  const f = await fixture(t);
  assert.equal(f.plan.draft, true);
  assert.equal(f.effects(), 0);
  f.tag.object.sha = 'b'.repeat(40);
  await assert.rejects(
    planRelease(f.reader, { version: 'v1.0.0', built: f.built }),
    /SOURCE_CHANGED/,
  );
  assert.throws(
    () => releaseAssets({ ...f.built, bytes: Buffer.from('Changed') }),
    /INVALID_RELEASE_BUILD/,
  );
});

test('draft uploads exact assets, verifies them and stays unpublished', async (t) => {
  const f = await fixture(t),
    result = await f.adapter.create(f.plan, f.built);
  assert.equal(result.status, 'draft-created');
  assert.equal(result.published, false);
  assert.equal(f.effects(), 4);
  await assert.rejects(
    planRelease(f.reader, { version: 'v1.0.0', built: f.built }),
    /ALREADY_EXISTS/,
  );
  assert.equal(
    (await f.adapter.create(f.plan, f.built)).code,
    'REPLAYED_OPERATION',
  );
  assert.equal(f.effects(), 4);
});

test('lost effects and revoked upload authority stay Pending', async (t) => {
  for (const fault of ['lost', 'revoked']) {
    const f = await fixture(t);
    f.fault(fault);
    assert.equal((await f.adapter.create(f.plan, f.built)).status, 'pending');
    const effects = f.effects();
    assert.equal((await f.adapter.create(f.plan, f.built)).status, 'pending');
    assert.equal(f.effects(), effects);
  }
});

test('published release binds its tag, publisher, assets and pin', async (t) => {
  const f = await fixture(t);
  await f.adapter.create(f.plan, f.built);
  await assert.rejects(
    verifyPublishedRelease(f.reader, f.expected, f.download),
    /NOT_IMMUTABLY_PUBLISHED/,
  );
  f.publish();
  const result = await verifyPublishedRelease(f.reader, f.expected, f.download);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.archive, f.built.bytes);
  await assert.rejects(
    verifyPublishedRelease(
      f.reader,
      { ...f.expected, commit: 'b'.repeat(40) },
      f.download,
    ),
    /SOURCE_CHANGED/,
  );
});

test('invalid publication identity or assets fail verification', async (t) => {
  for (const mutate of [
    (r) => {
      r.immutable = false;
    },
    (r) => {
      r.author.id = 99;
    },
    (_r, a) => {
      a.pop();
      a.pop();
    },
    (_r, a) => {
      a[0].browser_download_url = 'https://attacker.invalid/archive';
    },
  ]) {
    const f = await fixture(t);
    await f.adapter.create(f.plan, f.built);
    f.publish();
    f.mutate(mutate);
    await assert.rejects(verifyPublishedRelease(f.reader, f.expected, f.download));
  }
});
