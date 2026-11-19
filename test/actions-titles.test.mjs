import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { supportsTargetTitle, targetTitleInput }
  from '../src/dispatch-presentation.mjs';
import { observeStageProgress } from '../src/stage-presentation.mjs';
import { actionsSummary } from '../scripts/actions-summary.mjs';
import { cdBaseline } from '../scripts/cd-baseline.mjs';
import { includesPackagePath } from '../src/source-package.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';

function workflow(name) {
  return parse(readFileSync(new URL(`../.github/workflows/${name}.yml`,
    import.meta.url), 'utf8'));
}

test('official Issue Wake uses the authoritative installed caller recipe', () => {
  const source = readFileSync(new URL('../.github/workflows/nibfin-issue.yml',
    import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const commit = /core_commit: ([a-f0-9]{40})/.exec(source)?.[1];
  assert.equal(source, callerRecipe('issue', commit));
});

// Evaluate the limited expressions in actual YAML, after YAML comment/folding rules.
function title(name, inputs = {}, event = {}, eventName = 'workflow_dispatch') {
  const github = { repository: 'owner/execution', ref_name: 'main',
    event_name: eventName, event };
  return workflow(name)['run-name'].replace(/\$\{\{([\s\S]*?)\}\}/g, (_, value) =>
    String(runInNewContext(value.replaceAll(' == ', ' === '), {
      inputs, github, fromJSON: JSON.parse,
      format: (pattern, ...args) => pattern.replace(/\{(\d+)\}/g,
        (_match, index) => args[Number(index)]),
    }))).replace(/\s+/g, ' ').trim();
}

test('shared titles preserve Issue suffix, target and honest continuation name', () => {
  const inputs = { repository_id: '7', issue_number: '42', stage: 'continue',
    target_repository: 'owner/project' };
  assert.equal(title('shared-runner', inputs), 'Auto · owner/project#42');
  for (const [stage, label] of Object.entries({ shape: 'Shape', deliver: 'Deliver',
    'validate-shape': 'Validate Shape', 'publish-shape': 'Publish Shape',
    'pre-accept-hooks': 'Pre-accept hooks', 'post-accept-hooks': 'Post-accept hooks',
    accept: 'Accept', 'review-pr': 'Review', 'commit-pr': 'Publish PR',
    merge: 'Merge', close: 'Close' })) {
    assert.equal(title('shared-runner', { ...inputs, stage }),
      `${label} · owner/project#42`);
  }
  assert.equal(title('shared-runner', { ...inputs, stage: 'future-stage' }),
    'future-stage · owner/project#42');
  delete inputs.target_repository;
  assert.equal(title('shared-runner', inputs), 'Auto · repository ID 7#42');
  inputs.stage = 'wake';
  inputs.wake_event = JSON.stringify({ event: {
    repository: { full_name: 'owner/forwarded' } } });
  assert.equal(title('shared-runner', inputs), 'Wake · owner/forwarded#42');
});

test('event, CI, deployment and retry titles describe their actual operation', () => {
  assert.equal(title('nibfin-issue', {}, { issue: { number: 42 }, action: 'labeled',
    label: { name: 'scope' } }, 'issues'),
  'Wake · owner/execution#42 · labeled scope');
  assert.equal(title('ci', {}, { pull_request: { number: 99 } }, 'pull_request'),
    'CI · owner/execution · PR #99');
  assert.equal(title('ci', {}, {}, 'push'), 'CI · owner/execution · main');
  assert.equal(title('ci'), 'Environment check · owner/execution · main');
  assert.equal(title('cd'), 'Deploy · owner/execution · main');
  assert.equal(title('cd', { deploy_docs: true }),
    'Deploy docs · owner/execution · main');
  assert.equal(title('retry-shared-runner', {}, {
    workflow_run: { display_title: 'Auto · owner/project#42' } }, 'workflow_run'),
  'Retry check · Auto · owner/project#42');
});

test('display metadata is omitted for older receivers without changing admission', () => {
  const source = readFileSync(new URL('../.github/workflows/shared-runner.yml',
    import.meta.url), 'utf8');
  assert.equal(supportsTargetTitle(source), true);
  assert.deepEqual(targetTitleInput({ targetTitle: true }, 'owner/project'),
    { target_repository: 'owner/project' });
  assert.deepEqual(targetTitleInput({}, 'owner/project'), {});
  assert.equal(supportsTargetTitle(source.replace(
    /^.*target_repository: \{.*\}\r?\n/m, '')), false);
  assert.equal(workflow('shared-runner').name, 'Nibfin shared Runner');
  assert.ok(workflow('shared-runner').jobs['shared-stage']);
  assert.equal(workflow('ci').name, 'Core CI');
  assert.equal(includesPackagePath('scripts/actions-summary.mjs'), true);
});

test('progress preserves results, repair order and interruptions', async () => {
  const result = { stage: 'deliver', status: 'completed' };
  const observer = observeStageProgress(async stage => {
    if (stage === 'accept') return { status: 'denied', code: 'CHANGES_REQUIRED' };
    if (stage === 'review-pr') throw new Error('Interrupted');
    return result;
  });
  assert.equal(await observer.execute('deliver'), result);
  await observer.execute('accept');
  await observer.execute('deliver');
  await assert.rejects(observer.execute('review-pr'), /Interrupted/);
  assert.deepEqual(observer.progress.map(entry => entry.stage),
    ['deliver', 'accept', 'deliver', 'review-pr']);
  assert.equal(observer.progress.at(-1).status, 'interrupted');
  const summary = actionsSummary(JSON.stringify({ status: 'denied',
    stage: 'continue', terminalStage: 'accept', code: 'CHANGES_REQUIRED',
    stageProgress: observer.progress }));
  assert.match(summary, /accept \| denied \(CHANGES_REQUIRED\)/);
  assert.match(summary, /normal Core continuation/);
  assert.match(actionsSummary('no result'), /No final Core result/);
  assert.match(actionsSummary(JSON.stringify({ status: 'completed', stage: 'close' })),
    /Next: none/);
});

test('CD baselines use successful native source and job, independently of title', () => {
  const run = { event: 'workflow_run', conclusion: 'success', head_branch: 'main',
    head_sha: 'a'.repeat(40), repository: { id: 7 }, head_repository: { id: 7 } };
  const jobs = [{ name: 'verified-main', conclusion: 'success' }];
  for (const display_title of ['Main CD old', 'Deploy · owner/core · main', ''])
    assert.equal(cdBaseline({ ...run, display_title }, jobs), run.head_sha);
  assert.equal(cdBaseline(run, [{ name: 'verified-main', conclusion: 'skipped' }]),
    undefined);
  assert.equal(cdBaseline({ ...run, event: 'workflow_dispatch' }, jobs), undefined);
  assert.equal(cdBaseline({ ...run, head_repository: { id: 8 } }, jobs), undefined);
});
