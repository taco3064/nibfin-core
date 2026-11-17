import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoleUpstream } from '../src/role-upstream.mjs';

test('agent roles receive one source tree per admitted upstream repo', async t => {
  const io = await mkdtemp(join(tmpdir(), 'nibfin-upstream-test-'));
  t.after(() => rm(io, { recursive: true, force: true }));
  const input = join(io, 'input');
  await mkdir(input);
  const repository = 'taco3064/nibfin-core';
  const core = { repository, commit: 'a'.repeat(40) };
  const repositoryId = 8;
  const context = {
    approval: { record: { issue: { repositoryId: 7 } } },
    dependencies: { ready: true, identities: [
      { repositoryId: 7, repository: 'taco3064/gh-nibfin', number: 1 },
      { repositoryId, repository, number: 1 },
      { repositoryId, repository, number: 2 },
    ] },
  };
  let count = 0;
  const reader = {
    repository: async () => ({ id: repositoryId, full_name: repository,
      private: false, default_branch: 'main' }),
    get: async () => ({ ref: 'refs/heads/main',
      object: { type: 'commit', sha: 'b'.repeat(40) } }),
  };
  const prepare = async (source, issue, head) => {
    count++;
    assert.equal(issue.repository, repository);
    assert.equal(head, core.commit);
    const directory = join(source, 'work');
    await mkdir(directory, { recursive: true });
    await mkdir(join(source, 'repository.git'));
    await writeFile(join(directory, 'interface.mjs'), 'export const version = 1;');
    return { base: head, directory };
  };
  const options = { context, io, input, reader, core, prepare };
  await prepareRoleUpstream({ ...options, context: {
    ...context, dependencies: { ...context.dependencies, ready: false },
  } });
  assert.deepEqual(await readdir(input), []);
  await prepareRoleUpstream(options);
  assert.equal(count, 1);
  assert.deepEqual(await readdir(join(input, 'upstream', repository)), ['interface.mjs']);
  assert.deepEqual(JSON.parse(await readFile(join(input, 'upstream.json'), 'utf8')), [
    { repository, commit: core.commit, path: '/input/upstream/taco3064/nibfin-core' },
  ]);
  assert.deepEqual(await readdir(io), ['input']);
});
