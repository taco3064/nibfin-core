import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  link,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateWorkspace } from '../src/workspace.mjs';
import { command } from '../src/process.mjs';
import { sha256 } from '../src/identity.mjs';

const shape =
  'Shape\n```kairo-candidate\n' +
  '{"artifacts":[{"path":"proof.txt","purpose":"Proof"}],"hooks":[]}\n```\n';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, 'seed');
  await mkdir(seed, { mode: 0o700 });
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = async (args) =>
    (await command('/usr/bin/git', args, { cwd: seed, env })).stdout
      .toString()
      .trim();
  await git(['init']);
  await writeFile(join(seed, 'source.txt'), 'Original\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture baseline']);
  const base = await git(['rev-parse', 'HEAD']);
  const root = join(directory, 'trusted');
  await mkdir(root, { mode: 0o700 });
  const run = async (executable, args, options) => {
    if (args.includes('fetch')) {
      const adjusted = [...args];
      adjusted[adjusted.indexOf('https://github.com/example/core.git')] = seed;
      adjusted.splice(
        adjusted.indexOf('fetch'),
        0,
        '-c',
        'protocol.file.allow=always',
      );
      return command(executable, adjusted, options);
    }
    try {
      return await command(executable, args, options);
    } catch (error) {
      throw new Error(JSON.stringify(args), { cause: error });
    }
  };
  const workspace = new CandidateWorkspace(
    root,
    { id: 'I_target', repository: 'example/core', repositoryId: 10, number: 2 },
    { run },
  );
  await workspace.prepare(base);
  return { workspace, root, directory, base, seed, git };
}

test('capture and commit bind files, artifacts and tree', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace.work, 'source.txt'), 'Changed\n');
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Passed\n');
  const candidate = await f.workspace.capture(shape);
  assert.equal(candidate.base, f.base);
  assert.equal(candidate.repositoryId, 10);
  assert.deepEqual(candidate.paths, ['proof.txt', 'source.txt']);
  assert.equal(candidate.artifacts[0].sha256, sha256('Passed\n'));
  const commit = await f.workspace.commit(
    candidate,
    shape,
    '2026-11-03T00:00:00Z',
  );
  assert.equal(commit.tree, candidate.tree);
  assert.match(commit.head, /^[a-f0-9]{40}$/);
  await writeFile(
    join(f.workspace.work, 'source.txt'),
    'Changed after acceptance\n',
  );
  await assert.rejects(
    f.workspace.commit(candidate, shape, '2026-11-03T00:00:00Z'),
    /CANDIDATE_CHANGED_AFTER_ACCEPT/,
  );
});

test('retry removes ignored npm dependencies and preserves source', async t => {
  const { workspace } = await fixture(t);
  const work = workspace.work;
  await writeFile(join(work, '.gitignore'), '/node_modules/\n/keep/\n');
  await writeFile(join(work, 'source.txt'), 'Partial Writer changes');
  await writeFile(join(work, 'proof.txt'), 'Candidate proof');
  await mkdir(join(work, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(work, 'node_modules', 'esbuild'), 'binary');
  await link(join(work, 'node_modules', 'esbuild'), join(work, 'node_modules', 'alias'));
  await symlink('../esbuild', join(work, 'node_modules', '.bin', 'esbuild'));
  await mkdir(join(work, 'keep', 'node_modules'), { recursive: true });
  await writeFile(join(work, 'keep', 'node_modules', 'proof.txt'), 'Preserve');
  await workspace.clearIgnoredDependencies(shape);
  await assert.rejects(readFile(join(work, 'node_modules', 'esbuild')), {
    code: 'ENOENT',
  });
  assert.equal(await readFile(join(work, 'source.txt'), 'utf8'),
    'Partial Writer changes');
  assert.equal(await readFile(join(work, 'proof.txt'), 'utf8'), 'Candidate proof');
  assert.equal(await readFile(join(work, 'keep', 'node_modules', 'proof.txt'), 'utf8'),
    'Preserve');
  const snapshot = await workspace.capture(shape);
  assert.deepEqual(snapshot.paths, ['.gitignore', 'proof.txt', 'source.txt']);
});

test('unsafe files and missing artifacts reject capture', async (t) => {
  for (const kind of ['missing', 'metadata', 'symlink', 'hardlink']) {
    const f = await fixture(t);
    await writeFile(join(f.workspace.work, 'source.txt'), 'Changed\n');
    if (kind !== 'missing')
      await writeFile(join(f.workspace.work, 'proof.txt'), 'Proof\n');
    if (kind === 'metadata') await mkdir(join(f.workspace.work, '.git'));
    if (kind === 'symlink')
      await symlink(join(f.directory, 'secret'), join(f.workspace.work, 'link'));
    if (kind === 'hardlink')
      await link(
        join(f.workspace.work, 'source.txt'),
        join(f.workspace.work, 'duplicate'),
      );
    await assert.rejects(f.workspace.capture(shape));
  }
});

test('settled Writer Git scratch is discarded before trusted capture', async (t) => {
  const f = await fixture(t);
  const metadata = join(f.workspace.work, '.git');
  await f.git(['-C', f.workspace.work, 'init']);
  await writeFile(join(f.workspace.work, 'source.txt'), 'Writer changes\n');
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Proof\n');
  await assert.rejects(f.workspace.discardWriterGit(null), {
    code: 'WRITER_NOT_PROVEN_TERMINATED',
  });
  await f.workspace.discardWriterGit('a'.repeat(64));
  assert.deepEqual((await f.workspace.capture(shape)).paths, ['proof.txt', 'source.txt']);
  await symlink(f.seed, metadata);
  await assert.rejects(f.workspace.discardWriterGit('a'.repeat(64)), {
    code: 'UNSAFE_WORKSPACE_PATH',
  });
  assert.equal(await readFile(join(f.seed, 'source.txt'), 'utf8'), 'Original\n');
});

test('capture disables filters and keeps Git metadata private', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.workspace.work, '.gitattributes'),
    '*.txt filter=untrusted\n',
  );
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Exact\r\nBytes\n');
  const candidate = await f.workspace.capture(shape);
  assert.equal(candidate.artifacts[0].sha256, sha256('Exact\r\nBytes\n'));
  await assert.rejects(readFile(join(f.workspace.work, '.git')));
  assert.ok(
    (await readFile(join(f.root, 'repository.git/config'), 'utf8')).includes(
      '[core]',
    ),
  );
  await assert.rejects(f.workspace.prepare(f.base), { code: 'EEXIST' });
});

test('capture binds required evidence outside the tree', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.workspace.work, '.gitignore'),
    'proof.txt\ncache/\nsource.txt\n',
  );
  await writeFile(
    join(f.workspace.work, 'source.txt'),
    'Tracked changes remain included\n',
  );
  await writeFile(
    join(f.workspace.work, 'proof.txt'),
    'Ignored but required proof\n',
  );
  await mkdir(join(f.workspace.work, 'cache'));
  await symlink('/unavailable/host-file', join(f.workspace.work, 'cache/link'));
  const candidate = await f.workspace.capture(shape);
  assert.deepEqual(candidate.paths, ['.gitignore', 'source.txt']);
  assert.equal(
    candidate.artifacts[0].sha256,
    sha256('Ignored but required proof\n'),
  );
  assert.deepEqual(await f.workspace.capture(shape), candidate);
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Changed proof\n');
  await assert.rejects(
    f.workspace.commit(candidate, shape, '2026-11-03T00:00:00Z'),
    /CANDIDATE_CHANGED_AFTER_ACCEPT/,
  );
});

test('real Git rebase preserves content evidence across a parallel merge', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace.work, 'source.txt'), 'Delivered change\n');
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Proof\n');
  const previous = await f.workspace.capture(shape);
  await writeFile(join(f.seed, 'parallel.txt'), 'Other Issue merged\n');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Parallel Issue']);
  const latest = await f.git(['rev-parse', 'HEAD']);
  const result = await f.workspace.rebase(
    previous,
    shape,
    latest,
    '2026-11-03T00:00:00Z',
  );
  assert.equal(result.status, 'rebased');
  assert.equal(result.candidate.base, latest);
  assert.equal(result.contentChanged, false);
  assert.notEqual(result.candidate.tree, previous.tree);
  assert.equal(
    await readFile(join(f.workspace.work, 'parallel.txt'), 'utf8'),
    'Other Issue merged\n',
  );
  assert.equal(
    await readFile(join(f.workspace.work, 'source.txt'), 'utf8'),
    'Delivered change\n',
  );
});

test('Git conflicts require repair and new content evidence', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace.work, 'source.txt'), 'Candidate change\n');
  await writeFile(join(f.workspace.work, 'proof.txt'), 'Proof\n');
  const previous = await f.workspace.capture(shape);
  await writeFile(join(f.seed, 'source.txt'), 'Parallel change\n');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Conflicting parallel Issue']);
  const latest = await f.git(['rev-parse', 'HEAD']);
  const conflict = await f.workspace.rebase(
    previous,
    shape,
    latest,
    '2026-11-03T00:00:00Z',
  );
  assert.equal(conflict.status, 'changes_required');
  assert.deepEqual(conflict.paths, ['source.txt']);
  await assert.rejects(
    f.workspace.continueRebase(shape, latest, null),
    /REPAIR_WRITER_TERMINATION_REQUIRED/,
  );
  await writeFile(
    join(f.workspace.work, 'source.txt'),
    'Both approved changes resolved\n',
  );
  const result = await f.workspace.continueRebase(shape, latest, 'a'.repeat(64));
  assert.equal(result.status, 'rebased');
  assert.equal(result.candidate.base, latest);
  assert.equal(
    await readFile(join(f.workspace.work, 'source.txt'), 'utf8'),
    'Both approved changes resolved\n',
  );
  await assert.rejects(
    f.workspace.commit(previous, shape, '2026-11-03T00:00:00Z'),
    /CANDIDATE_CHANGED_AFTER_ACCEPT/,
  );
});
