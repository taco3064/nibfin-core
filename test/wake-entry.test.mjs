import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWakeDispatch } from '../src/wake-entry.mjs';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';
import { gitBlob } from '../src/identity.mjs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function fixture() {
  const record = approvalRecord(); record.operations.push('wake'); record.source.repository = 'taco3064/nibfin-core';
  const f = approvalProviderFixture(record), member = { id: 1, login: 'writer', type: 'User' };
  const issue = { node_id: record.issue.id, number: 2, state: 'open', body: record.scope.body,
    url: 'https://api.github.com/repos/example/core/issues/2', labels: [{ name: 'scope' }], assignees: [member] };
  const body = 'Protected dispatcher caller\n';
  const workflow = { id: 5, path: '.github/workflows/nibfin.yml', commit: '9'.repeat(40), blob: gitBlob(body) };
  f.data['/collaborators/writer/permission'] = { user: member, permission: 'write' };
  f.data['/actions/workflows/5'] = { id: 5, path: workflow.path, state: 'active' };
  f.data[`/contents/${workflow.path}?ref=${workflow.commit}`] = { type: 'file', path: workflow.path,
    sha: workflow.blob, encoding: 'base64', content: Buffer.from(body).toString('base64'), size: Buffer.byteLength(body) };
  const run = { id: 80, run_attempt: 1, event: 'workflow_dispatch', status: 'in_progress', workflow_id: 5,
    path: workflow.path, head_sha: workflow.commit, head_branch: 'main', repository: f.repo, head_repository: f.repo,
    actor: f.pr.merged_by, triggering_actor: f.pr.merged_by,
    referenced_workflows: [{ path: `taco3064/nibfin-core/.github/workflows/wake.yml@${record.source.commit}`, sha: record.source.commit }] };
  f.data['/actions/runs/80'] = run;
  const original = f.reader.get;
  f.reader.get = async path => path === '/user' ? structuredClone(f.pr.merged_by) : original(path);
  f.reader.issue = async () => structuredClone(issue); f.reader.blockedBy = async () => [];
  const adoption = { schemaVersion: 1, coreCommit: record.source.commit,
    issues: [{ approvalPin: f.pin, workflow, actorId: 3 }] };
  const event = { repository: f.repo, inputs: { issue_number: '2', issue_id: record.issue.id, repository_id: '10' } };
  const invocation = { coreCommit: record.source.commit, repository: 'example/core', eventName: 'workflow_dispatch', runId: 80, attempt: 1 };
  return { ...f, issue, run, adoption, event, invocation,
    resolve: () => resolveWakeDispatch(f.reader, adoption, event, invocation, () => now) };
}

test('dispatch Issue identity resolves to current authorized stage/member inputs with no execution grant', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve(), { status: 'resolved', issue_number: '2', member_id: '1', stage: 'shape', stageAdmitted: false });
  f.issue.labels.push({ name: 'shaped' }); f.issue.body = 'Current published Shape';
  assert.equal((await f.resolve()).stage, 'deliver');
});

test('untrusted dispatch overrides, source/caller changes and ineligible work cannot select a Runner', async () => {
  const mutations = [
    f => { f.event.inputs.stage = 'merge'; }, f => { f.event.inputs.member_id = '999'; },
    f => { f.event.inputs.issue_number = '3'; }, f => { f.event.inputs.repository_id = '99'; },
    f => { f.invocation.eventName = 'pull_request'; }, f => { f.invocation.attempt = 2; },
    f => { f.run.actor = { id: 99 }; }, f => { f.run.triggering_actor = { id: 99 }; },
    f => { f.run.head_sha = 'b'.repeat(40); }, f => { f.run.referenced_workflows = []; },
    f => { f.run.referenced_workflows[0].path = 'taco3064/nibfin-core/.github/workflows/wake.yml@main'; },
    f => { f.run.referenced_workflows.push({ path: 'other/core/.github/workflows/evil.yml@main', sha: f.adoption.coreCommit }); },
    f => { f.adoption.coreCommit = 'b'.repeat(40); }, f => { f.adoption.issues.push(f.adoption.issues[0]); },
    f => { f.issue.labels = []; }, f => { f.issue.labels.push({ name: 'delivered' }); },
    f => { f.issue.assignees = []; }, f => { f.data['/collaborators/writer/permission'].permission = 'read'; },
    f => { f.issue.body = 'Unapproved Scope'; }, f => { f.reader.blockedBy = async () => [{ node_id: 'I_foreign' }]; },
  ];
  for (const change of mutations) { const f = fixture(); change(f); await assert.rejects(f.resolve()); }
});

test('resolution accepts only the pinned wake/stage chain, independent of API ordering', async () => {
  const f = fixture();
  f.run.referenced_workflows.unshift({ path: `taco3064/nibfin-core/.github/workflows/stage.yml@${f.adoption.coreCommit}`, sha: f.adoption.coreCommit });
  assert.equal((await f.resolve()).stage, 'shape');
  f.run.referenced_workflows.push(f.run.referenced_workflows[0]);
  await assert.rejects(f.resolve(), /UNTRUSTED_WAKE_CALLER/);
});

test('caller rerun during resolution invalidates routing before any output', async () => {
  const f = fixture(), original = f.reader.get; let reads = 0;
  f.reader.get = async path => {
    if (path.endsWith('/actions/runs/80') && ++reads === 2) f.run.run_attempt = 2;
    return original(path);
  };
  await assert.rejects(f.resolve(), /UNTRUSTED_WAKE_CALLER/);
});

test('fixed workflow rejects a substituted Core revision before checkout or token-bearing execution', async () => {
  const workflow = await readFile(new URL('../.github/workflows/wake.yml', import.meta.url), 'utf8');
  const match = /node --input-type=module <<'NODE'\n([\s\S]+?)\n\s+NODE/.exec(workflow);
  assert.ok(match); assert.ok(match.index < workflow.indexOf('- uses: actions/checkout@'));
  assert.ok(workflow.indexOf('NIBFIN_READ_TOKEN: ${{ secrets.NIBFIN_READ_TOKEN }}') > match.index);
  const commit = 'a'.repeat(40);
  for (const [value, success] of [[commit, true], ['b'.repeat(40), false], ['main', false]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', match[1]], {
      env: { CORE_COMMIT: value, WAKE_ADOPTION: JSON.stringify({ coreCommit: commit }) } });
    assert.equal(child.status === 0, success);
    assert.equal(child.stdout.length, 0);
  }
});
