import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { cdPaths, cdWorkflow } from '../scripts/cd-paths.mjs';

const source = readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url),
  'utf8').replaceAll('\r\n', '\n');

function checkWorkflow(text) {
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on).sort(),
    ['push', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['CI'], types: ['completed'], branches: ['main'],
  });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const jobs = workflow.jobs;
  for (const rule of [
    "github.repository == 'taco3064/nibfin-core'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    'github.event.workflow_run.head_repository.id == github.event.repository.id',
    "github.ref == 'refs/heads/main'",
    'github.ref_protected',
    'github.event.created && !github.event.deleted && !github.event.forced',
  ]) assert.ok(jobs['verified-main'].if.includes(rule), rule);

  const build = jobs['build-docs'];
  assert.equal(build.needs, 'verified-main');
  assert.equal(build.if, "needs.verified-main.outputs.website == 'true'");
  assert.deepEqual(build.permissions, { contents: 'read', pages: 'read' });
  assert.equal(build.steps[0].with['persist-credentials'], false);
  const check = build.steps.findIndex(step =>
    step.run?.includes('npm run website:preview-check -- --production'));
  const upload = build.steps.findIndex(step =>
    step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.ok(check >= 0 && upload === check + 1 && upload === build.steps.length - 1);
  assert.equal(build.steps[upload].with.path, 'website/dist');
  assert.equal(build.steps[upload].if, undefined);
  assert.equal(build.steps[check]['continue-on-error'], undefined);

  const deploy = jobs['deploy-docs'];
  assert.equal(deploy.needs, 'build-docs');
  assert.equal(deploy.if, undefined);
  assert.deepEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(deploy.environment.name, 'github-pages');
  assert.equal(deploy.steps[0].with, undefined);
  assert.match(deploy.steps[0].uses, /^actions\/deploy-pages@[a-f0-9]{40}$/);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.permissions?.pages === 'write', name === 'deploy-docs');
    assert.equal(job.permissions?.['id-token'] === 'write', name === 'deploy-docs');
  }
  assert.equal(jobs['release-draft'].needs, 'verified-main');
  assert.equal(jobs['release-draft'].if,
    "github.event_name == 'push' && github.ref_type == 'tag'");
}

test('Core CD gates Pages deployment and version drafts independently', () => {
  checkWorkflow(source);
  for (const [valid, invalid] of [
    ['  workflow_dispatch:', '  pull_request:'],
    ["github.repository == 'taco3064/nibfin-core'", 'true'],
    ['      path: website/dist', '      path: .'],
    ['    needs: build-docs', '    needs: verified-main'],
    ['      name: github-pages', '      name: unrestricted'],
    ['          persist-credentials: false', '          persist-credentials: true'],
    ['      pages: read\n    steps:', '      pages: write\n    steps:'],
    ['    needs: build-docs', '    needs: build-docs\n    if: always()'],
  ]) {
    assert.ok(source.includes(valid), valid);
    assert.throws(() => checkWorkflow(source.replaceAll(valid, invalid)));
  }
});

test('CD routes website, package and shared changes', () => {
  assert.deepEqual(cdPaths(['website/astro.config.mjs']), {
    core: false, website: true,
  });
  assert.deepEqual(cdPaths(['src/stages.mjs']), { core: true, website: false });
  assert.deepEqual(cdPaths(['package-lock.json']), { core: true, website: true });
  assert.deepEqual(cdPaths([]), { core: false, website: false });
});

test('workflow-only and contract-test changes select website verification', () => {
  for (const path of [cdWorkflow, 'test/cd-workflow.test.mjs']) {
    const run = flag => spawnSync(process.execPath,
      ['scripts/test-changes.mjs', flag, path], { encoding: 'utf8' });
    assert.match(run('--website').stdout, /^website=true\s*$/);
    assert.match(run('--list').stdout, /test\/cd-workflow\.test\.mjs/);
  }
});
