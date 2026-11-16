import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  cdPaths, cdWorkflow, docsNeedRetry, websiteOnlyLockChange,
} from '../scripts/cd-paths.mjs';

const source = readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url),
  'utf8').replaceAll('\r\n', '\n');

function checkWorkflow(text) {
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on).sort(),
    ['workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['Core CI'], types: ['completed'], branches: ['main'],
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
    "github.event_name == 'workflow_dispatch'",
  ]) assert.ok(jobs['verified-main'].if.includes(rule), rule);

  const build = jobs['build-docs'];
  assert.equal(build.needs, 'verified-main');
  assert.equal(build.if, "needs.verified-main.outputs.website == 'true'");
  assert.equal(build.outputs.ready, "${{ steps.artifact.outcome == 'success' }}");
  assert.deepEqual(build.permissions, { contents: 'read', pages: 'read' });
  assert.equal(build.steps[0].with['persist-credentials'], false);
  assert.ok(build.steps.some(step =>
    step.run === 'bash website/scripts/retry-npm-network.sh ci --ignore-scripts'));
  const check = build.steps.findIndex(step =>
    step.run?.includes('npm run website:preview-check -- --production'));
  const upload = build.steps.findIndex(step =>
    step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.ok(check >= 0 && upload === check + 1 && upload === build.steps.length - 1);
  assert.match(build.steps[check].run,
    /npm run website:check\nnpm run website:preview-check -- --production/);
  assert.equal(build.steps[check].if, undefined);
  assert.equal(build.steps[upload].with.path, 'website/dist');
  assert.equal(build.steps[upload].id, 'artifact');
  assert.equal(build.steps[upload].if, undefined);
  assert.equal(build.steps[check]['continue-on-error'], undefined);

  const deploy = jobs['deploy-docs'];
  assert.equal(deploy.needs, 'build-docs');
  assert.equal(deploy.if, "needs.build-docs.outputs.ready == 'true'");
  assert.deepEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(deploy.environment.name, 'github-pages');
  assert.equal(deploy.steps[0].with, undefined);
  assert.equal(deploy.steps[0].name, 'Publish Docs to Pages');
  assert.match(deploy.steps[0].uses, /^actions\/deploy-pages@[a-f0-9]{40}$/);
  for (const [name, job] of Object.entries(jobs)) {
    const docs = name === 'build-docs' || name === 'deploy-docs';
    assert.equal(job['continue-on-error'],
      docs ? "${{ github.event_name == 'workflow_run' }}" : undefined);
    assert.equal(job.permissions?.pages === 'write', name === 'deploy-docs');
    assert.equal(job.permissions?.['id-token'] === 'write', name === 'deploy-docs');
  }
  assert.doesNotMatch(jobs['verified-main'].if, /ref_type|event_name == 'push'/);
  assert.equal(jobs['release-draft'], undefined);
  const rollout = jobs['consumer-drafts'];
  assert.match(rollout.if, /github.event_name == 'workflow_run'/);
  assert.deepEqual(rollout.needs, ['verified-main', 'rollout']);
  assert.equal(rollout.environment, 'nibfin-rollout');
  assert.equal(rollout.steps.at(-1).with.path, 'activation.json');
}

test('Core CD gates Pages deployment and version drafts independently', () => {
  checkWorkflow(source);
  for (const [valid, invalid] of [
    ['  workflow_dispatch:', '  pull_request:'],
    ["github.repository == 'taco3064/nibfin-core'", 'true'],
    ['      path: website/dist', '      path: .'],
    ['          npm run website:check\n', ''],
    ['    needs: build-docs', '    needs: verified-main'],
    ['      name: github-pages', '      name: unrestricted'],
    ['          persist-credentials: false', '          persist-credentials: true'],
    ['      pages: read', '      pages: write'],
    ["    if: needs.build-docs.outputs.ready == 'true'", '    if: always()'],
    ["    continue-on-error: ${{ github.event_name == 'workflow_run' }}",
      '    continue-on-error: true'],
  ]) {
    assert.ok(source.includes(valid), valid);
    assert.throws(() => checkWorkflow(source.replaceAll(valid, invalid)));
  }
});

test('a successful Core run retries Docs when Pages publication failed or was skipped',
  () => {
    const build = { name: 'build-docs', conclusion: 'success' };
    const deploy = { name: 'deploy-docs', steps: [
      { name: 'Publish Docs to Pages', conclusion: 'failure' },
    ] };
    assert.equal(docsNeedRetry([build, deploy]), true);
    assert.equal(docsNeedRetry([build, { ...deploy, steps: [] }]), true);
    assert.equal(docsNeedRetry([{ ...build, conclusion: 'skipped' }]), false);
    assert.equal(docsNeedRetry(undefined), true);
    for (const name of ['Publish Docs to Pages', 'Run actions/deploy-pages@old']) {
      assert.equal(docsNeedRetry([build, { ...deploy,
        steps: [{ name, conclusion: 'success' }],
      }]), false);
    }
  });

test('Docs retries only transient npm failures and preserves final failures', {
  skip: process.platform !== 'linux',
}, t => {
  const directory = mkdtempSync(join(tmpdir(), 'docs-npm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(directory, 'npm'), `#!/bin/bash
echo "$*" >> "$ATTEMPTS"
if [ "$(wc -l < "$ATTEMPTS")" -ge "$SUCCEEDS_AT" ]; then exit 0; fi
printf 'npm error code %s\\n' "$ERROR_CODE" >&2
exit 152
`, { mode: 0o700 });
  const script = fileURLToPath(new URL('../website/scripts/retry-npm-network.sh',
    import.meta.url));
  for (const [code, successAt, tries, status] of [
    ['ECONNRESET', 2, 2, 0], ['ETIMEDOUT', 4, 3, 152], ['EUSAGE', 2, 1, 152],
  ]) {
    const attempts = join(directory, 'attempts');
    writeFileSync(attempts, '');
    const result = spawnSync('bash', [script, 'ci', '--ignore-scripts'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: directory + ':/usr/bin:/bin',
        ATTEMPTS: attempts, SUCCEEDS_AT: String(successAt), ERROR_CODE: code },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(readFileSync(attempts, 'utf8').trim().split('\n'),
      Array(tries).fill('ci --ignore-scripts'));
  }
});

test('CD routes website, package and shared changes', () => {
  assert.deepEqual(cdPaths(['website/astro.config.mjs']), {
    core: false, website: true,
  });
  assert.deepEqual(cdPaths(['src/stages.mjs']), { core: true, website: false });
  assert.deepEqual(cdPaths(['scripts/cd-drafts.sh']), { core: true, website: false });
  assert.deepEqual(cdPaths(['package-lock.json']), { core: true, website: true });
  assert.deepEqual(cdPaths([]), { core: false, website: false });
  const pinPaths = ['.nibfin/producer-pins.json', '.github/workflows/nibfin-wake.yml'];
  const rollout = `Prepare Core ${'a'.repeat(40)} rollout`;
  assert.deepEqual(cdPaths(pinPaths, rollout), { core: false, website: false });
  assert.deepEqual(cdPaths(pinPaths), { core: true, website: false });
});

test('CD skips Core rollout for website-only dependencies in the shared lockfile', () => {
  const nestedParser = 'node_modules/yaml/node_modules/parser';
  const before = {
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['website'], devDependencies: { yaml: '2.9.1' } },
      website: { dependencies: { astro: '6.0.0' } },
      'node_modules/website': { resolved: 'website', link: true },
      'node_modules/astro': { version: '6.0.0' },
      'node_modules/yaml': { version: '2.9.1', dependencies: { parser: '1.0.0' } },
      [nestedParser]: { version: '1.0.0', integrity: 'sha512-old' },
    },
  };
  const after = structuredClone(before);
  after.packages.website.dependencies.tabs = '1.0.0';
  after.packages['node_modules/tabs'] = { version: '1.0.0' };
  const route = (candidate, paths = ['website/package.json', 'package-lock.json']) => {
    const websiteOnly = websiteOnlyLockChange(
      JSON.stringify(before), JSON.stringify(candidate),
    );
    return cdPaths(paths, '', websiteOnly);
  };
  assert.deepEqual(route(after), { core: false, website: true });
  assert.deepEqual(route(after, ['package-lock.json']), { core: false, website: true });
  assert.deepEqual(route(after, ['package-lock.json', 'src/stages.mjs']),
    { core: true, website: true });
  after.packages[nestedParser].integrity = 'sha512-new';
  assert.deepEqual(route(after), { core: true, website: true });
  delete after.packages[nestedParser];
  assert.deepEqual(route(after), { core: true, website: true });
  assert.equal(websiteOnlyLockChange(JSON.stringify(before), undefined), false);
});

test('host rollout diagnoses a behind PR and unfinished checks', {
  skip: process.platform !== 'linux',
}, () => {
  const script = new URL('../scripts/host-auto-rollout.py', import.meta.url);
  const result = spawnSync('python3', ['-B', '-c', `
import runpy
import sys

wait = runpy.run_path(sys.argv[1])["consumer_wait"]
passed = {"name": "verify", "conclusion": "SUCCESS"}
assert wait({"mergeStateStatus": "CLEAN", "statusCheckRollup": [passed]}) is None
assert wait({"mergeStateStatus": "BEHIND", "statusCheckRollup": [passed]}) == {
    "mergeStateStatus": "BEHIND", "checkRollupPresent": True, "incompleteChecks": [],
}
missing = wait({"mergeStateStatus": "CLEAN", "statusCheckRollup": []})
assert missing["checkRollupPresent"] is False
blocked = wait({"mergeStateStatus": "BLOCKED", "statusCheckRollup": [
    passed, {"name": "package", "status": "IN_PROGRESS"},
    {"name": "integration", "conclusion": "FAILURE"},
]})
assert blocked["incompleteChecks"] == [
    {"name": "package", "status": "IN_PROGRESS"},
    {"name": "integration", "status": "FAILURE"},
]
`, fileURLToPath(script)], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('rollout drains actual Runner work despite a queued run without jobs', {
  skip: process.platform !== 'linux',
}, () => {
  const script = new URL('../scripts/host-auto-rollout.py', import.meta.url);
  const result = spawnSync('python3', ['-B', '-c', `
import runpy
import sys

module = runpy.run_path(sys.argv[1])
core = module["CORE"]
idle = module["idle"]
settings = idle.__globals__
settings["consumer_workflows"] = lambda *args: []
host = {core: {"repository": {"approval": {"repositoryId": 1}},
               "sharedRunner": {"repositories": [1],
                                "runner": {"repository": core, "runnerId": 7}},
               "stateRoot": "/missing"}}

state = dict(fenced=False, busy=False, active=0, queued=1, jobs=0)
settings["host_fenced"] = lambda hosts: state["fenced"]

def api(path):
    if path.endswith("/runners"):
        return {"runners": [{"id": 7, "busy": state["busy"]}]}
    if "status=in_progress" in path:
        return {"total_count": state["active"]}
    if "status=queued" in path:
        return {"total_count": state["queued"], "workflow_runs": [{"id": 99}]}
    assert path.endswith("/runs/99/jobs?per_page=1")
    return {"total_count": state["jobs"], "jobs": []}

settings["api"] = api
assert idle(host)
state["jobs"] = 1
assert not idle(host)
assert idle(host, include_queued=False)
state.update(jobs=0, queued=101)
assert not idle(host)
state.update(queued=1, active=1)
assert not idle(host, include_queued=False)
state.update(active=0, busy=True)
assert not idle(host, include_queued=False)
state.update(busy=False, fenced=True)
assert not idle(host, include_queued=False)
`, fileURLToPath(script)], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('workflow-only and contract-test changes select website verification', () => {
  for (const path of [cdWorkflow, 'test/cd-workflow.test.mjs']) {
    const run = flag => {
      const result = spawnSync(process.execPath,
        ['scripts/test-changes.mjs', flag, path], {
          encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
        });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.match(run('--website'), /^website=true\s*$/);
    assert.match(run('--list'), /test\/cd-workflow\.test\.mjs/);
  }
});
