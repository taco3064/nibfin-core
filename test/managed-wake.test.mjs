import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueWakeActions, projectManagedWake, issueWakeMode, managedWakeContract }
  from '../src/managed-wake.mjs';
import { produceManagedWake } from '../src/managed-wake-producer.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { readCallerSource } from '../src/caller-source.mjs';
import { includesPackagePath } from '../src/source-package.mjs';

const origin = { repository: 'owner/repo', eventName: 'issues', runId: 20, attempt: 2 };
function event(action = 'opened') {
  return { action, repository: { id: 1, full_name: 'owner/repo', secret: 'omit' },
    issue: { id: 2, number: 3, node_id: 'I_example', state: 'open',
      updated_at: '2026-11-16T00:00:00Z', body: 'omit',
      labels: [{ name: 'scope' }, { name: 'pause' }], assignees: [],
    }, sender: { id: 4, login: 'owner', type: 'User' }, label: { name: 'pause' },
    comment: { body: 'omit' } };
}

test('all supported actions retain bounded handler context, without eligibility', () => {
  for (const action of issueWakeActions) {
    const result = projectManagedWake(event(action), origin);
    assert.equal(result.event.action, action);
    assert.equal(result.runId, 20);
    assert.equal(result.attempt, 2);
    assert.deepEqual(result.event.sender, { id: 4, login: 'owner', type: 'User' });
    assert.deepEqual(result.event.issue.labels, [{ name: 'pause' }]);
    assert.equal(JSON.stringify(result).includes('omit'), false);
    assert.deepEqual(Object.keys(result), ['schemaVersion', 'runId', 'attempt', 'event']);
  }
});

test('malformed identities, unsupported events and oversized context fail closed', () => {
  for (const change of [
    value => { value.repository.id = '1'; },
    value => { value.issue.node_id = '../bad'; },
    value => { value.issue.pull_request = {}; },
    value => { value.action = 'deleted'; },
    value => { value.issue.number = -1; },
    value => { value.sender.login = 'bad\noutput=value'; },
  ]) {
    const value = event();
    change(value);
    assert.throws(() => projectManagedWake(value, origin));
  }
  assert.throws(() => projectManagedWake(event(), { ...origin, runId: NaN }));
  assert.throws(() => projectManagedWake(event(), { ...origin, repository: 'other/r' }));
  const value = event();
  value.issue.assignees = Array(100).fill(value.sender);
  assert.throws(() => projectManagedWake(value, origin), /MANAGED_WAKE_TOO_LARGE/);
  const pause = event('unlabeled');
  delete pause.sender;
  assert.throws(() => projectManagedWake(pause, origin), /INVALID_MANAGED_WAKE_ACTOR/);
  assert.throws(() => projectManagedWake({ ...event('labeled'),
    label: { name: 'unrelated' } }, origin), /UNSUPPORTED_ISSUE_EVENT/);
});

test('managed CLI produces a file without credentials and removes stale failed output',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-wake-'));
    try {
      const path = join(root, 'event.json');
      await writeFile(path, JSON.stringify(event('closed')));
      const env = { RUNNER_TEMP: root, GITHUB_EVENT_PATH: path,
        GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: origin.repository,
        GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '2',
        NIBFIN_ISSUE_WAKE_MODE: 'managed' };
      const child = spawnSync(process.execPath, ['scripts/issue-ci.mjs'], { env });
      assert.equal(child.status, 0, child.stderr.toString());
      const file = join(root, 'nibfin-issue-wake', managedWakeContract.fileName);
      assert.equal(JSON.parse(await readFile(file)).event.action, 'closed');
      assert.equal((await produceManagedWake(env)).artifactName, 'nibfin-issue-wake-v1-2');
      const workflow = await readFile('.github/workflows/issue.yml', 'utf8');
      assert.ok(workflow.includes('name: nibfin-issue-wake-v1-${{ github.run_attempt }}'));
      assert.match(workflow, /if-no-files-found: error/);
      await writeFile(path, JSON.stringify(event('deleted')));
      await assert.rejects(produceManagedWake(env), /UNSUPPORTED_ISSUE_EVENT/);
      await assert.rejects(readFile(file), { code: 'ENOENT' });
      for (const mode of ['', 'invalid']) {
        const failed = spawnSync(process.execPath, ['scripts/issue-ci.mjs'], {
          env: { ...env, NIBFIN_ISSUE_WAKE_MODE: mode },
        });
        assert.notEqual(failed.status, 0);
        await assert.rejects(readFile(file), { code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('legacy default and exact managed recipe remain distinct', async () => {
  assert.equal(issueWakeMode(), 'legacy');
  assert.equal(issueWakeMode('managed'), 'managed');
  assert.throws(() => issueWakeMode('MANAGED'), /INVALID_ISSUE_WAKE_MODE/);
  const commit = 'a'.repeat(40);
  const source = callerRecipe('issue-managed', commit);
  assert.match(source, /mode: managed/);
  assert.doesNotMatch(source, /secrets:|NIBFIN_WAKE_TOKEN/);
  assert.match(callerRecipe('issue', commit), /NIBFIN_WAKE_TOKEN/);
  const workflow = { path: '.github/workflows/nibfin-issue.yml' };
  let content = source;
  const reader = { get: async () => ({ type: 'file', path: workflow.path,
    encoding: 'base64', content: Buffer.from(content).toString('base64') }) };
  const recipe = { kind: 'issue-managed', coreCommit: commit };
  await readCallerSource(reader, 'owner/repo', workflow, commit, recipe);
  content += '# arbitrary change\n';
  await assert.rejects(readCallerSource(reader, 'owner/repo', workflow, commit, recipe),
    /CALLER_NOT_FIXED_RECIPE/);
  for (const path of ['src/managed-wake.mjs', 'src/managed-wake-producer.mjs',
    'src/caller-recipes.json', 'scripts/issue-ci.mjs', 'scripts/routing-output.mjs'])
    assert.equal(includesPackagePath(path), true);
});
