import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostStageInputs } from '../src/host-stage-inputs.mjs';
import { readNotionProposal } from '../src/notion-proposal.mjs';
import { issueStatePath } from '../src/host-fence.mjs';
import { localReportReader, selectReports } from '../src/local-work-reports.mjs';
import { stageFixture } from './stage-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-stage-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = stageFixture('deliver');
  binding.runner.repository = 'example/core';
  const context = { host: { stateRoot: root }, adopted: {} };
  return { root, binding, context };
}

async function retained(f, outcome, code) {
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.code, code);
  assert.match(outcome.reportReference, /^report:[a-f0-9]{64}$/);
  const issue = f.binding.approval.record.issue;
  const reader = localReportReader({ uid: process.getuid(), stateRoot: f.root,
    subjectId: f.binding.runner.memberId });
  const reports = selectReports(await reader.reports(issue),
    { stage: 'deliver', id: f.binding.execution.id });
  assert.equal(reports.length, 1);
  const { report, projected } = reports[0];
  assert.deepEqual(report.binding.issue, issue);
  assert.equal(report.binding.native.jobId, f.binding.runner.jobId);
  assert.equal(report.binding.native.runId, f.binding.runner.runId);
  assert.equal(report.binding.native.attempt, f.binding.runner.attempt);
  assert.equal(report.binding.executionId, null);
  assert.equal(report.binding.sessionId, null);
  assert.equal(report.producer, 'core-native');
  assert.equal(report.rootCause, null);
  assert.equal(report.failureClass, null);
  assert.equal(projected.code, code);
  assert.equal(projected.executionAuthority, false);
  assert.ok(!JSON.stringify(reports).includes('private-sensitive'));
  await reader.confirm();
  return issueStatePath(f.root, issue);
}

test('Proposal failures retain bounded codes before Agent admission', async t => {
  for (const [status, code] of [
    [401, 'NOTION_PROPOSAL_CREDENTIAL_REJECTED'],
    [403, 'NOTION_PROPOSAL_ACCESS_DENIED'],
    [404, 'NOTION_PROPOSAL_ACCESS_DENIED'],
    [429, 'NOTION_PROPOSAL_UNAVAILABLE'],
    [200, 'NOTION_PROPOSAL_INCOMPLETE'],
  ]) {
    const f = await fixture(t);
    f.context.adopted.notionProposal = {
      pageId: '40006b64-4a20-80da-b1a8-c2e562f95373',
      tokenFile: '/private-sensitive/token',
    };
    const inputs = await readHostStageInputs(f.context, f.binding, 'deliver', {
      readProposal: source => readNotionProposal(source, {
        readToken: async () => 'private-sensitive-placeholder',
        fetcher: async () => new Response('private-sensitive-body', { status }),
      }),
      readInstructions: () => assert.fail('Instructions must not be read'),
    });
    const root = await retained(f, inputs.outcome, code);
    assert.deepEqual(await readdir(root), ['receipts']);
  }
});

test('global instruction failure preserves existing fence without Agent identity',
  async t => {
    const f = await fixture(t);
    f.context.host.globalInstructionsFile = join(f.root, 'private-sensitive-missing');
    // An existing fence is neither acquired nor released by this read boundary.
    const root = issueStatePath(f.root, f.binding.approval.record.issue);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'stage.lock'), 'existing-fence');
    const inputs = await readHostStageInputs(f.context, f.binding, 'deliver');
    await retained(f, inputs.outcome, 'GLOBAL_INSTRUCTIONS_UNAVAILABLE');
    assert.equal(await readFile(join(root, 'stage.lock'), 'utf8'), 'existing-fence');
  });

test('unknown Proposal exceptions never become public diagnostics', async t => {
  const f = await fixture(t);
  f.context.host.notionProposal = {};
  const inputs = await readHostStageInputs(f.context, f.binding, 'deliver', {
    readProposal: async () => { throw Object.assign(
      new Error('private-sensitive-body'), { code: 'PRIVATE_SENSITIVE_CODE' }); },
  });
  await retained(f, inputs.outcome, 'NOTION_PROPOSAL_UNAVAILABLE');
});

test('successful input reads retain values and create no execution state', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'instructions');
  await writeFile(path, 'Global instructions');
  f.context.host.globalInstructionsFile = path;
  f.context.targetHost = { notionProposal: { selected: true } };
  const proposal = { markdown: 'Proposal requirements' };
  const inputs = await readHostStageInputs(f.context, f.binding, 'deliver', {
    readProposal: async source => {
      assert.deepEqual(source, { selected: true });
      return proposal;
    },
  });
  assert.deepEqual(inputs, { proposal, globalInstructions: 'Global instructions' });
  assert.deepEqual(await readdir(f.root), ['instructions']);
});
