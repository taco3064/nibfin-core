import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile, symlink, readdir } from
  'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// No service, live token, host configuration or Git metadata is involved.
const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rollout', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    token = module.read_manual_credential(json.load(sys.stdin))
    print('manual' if token == 'synthetic-manual-token' else 'unexpected')
except (RuntimeError, OSError):
    print('refused')
`;

test('legacy rollout refuses managed tokens before reading them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-managed-rollout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'github-token');
  const marker = join(directory, 'managed.json');
  const lock = join(directory, 'managed.lock');
  const run = () => {
    const result = spawnSync('python3', ['-B', '-c', script,
      resolve('scripts/host-auto-rollout.py')], {
      input: JSON.stringify({ tokenFile }), encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout.trim();
  };
  await writeFile(tokenFile, 'synthetic-manual-token', { mode: 0o600 });
  assert.equal(run(), 'manual');
  await writeFile(marker, '{}', { mode: 0o600 });
  assert.equal(run(), 'refused');
  await rm(marker);
  await symlink(join(directory, 'missing'), marker);
  assert.equal(run(), 'refused');
  await rm(marker);
  await writeFile(lock, 'active intake', { mode: 0o600 });
  assert.equal(run(), 'refused');
  assert.equal(await readFile(lock, 'utf8'), 'active intake');
  await rm(lock);
  assert.deepEqual(await readdir(directory), ['github-token']);
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
`, resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('rollout checks the exact successful main push without a status filter', {
  skip: process.platform !== 'linux',
}, () => {
  const result = spawnSync('python3', ['-B', '-c', `
import runpy
import sys

module = runpy.run_path(sys.argv[1])
core = module["CORE"]
success = module["has_main_ci"]
commit = "a" * 40
run = dict(head_sha=commit, head_branch="main", event="push",
           status="completed", conclusion="success",
           head_repository={"full_name": core})
records = [run]

def api(path):
    assert path == f"repos/{core}/actions/workflows/ci.yml/runs?head_sha={commit}&per_page=100"
    return {"workflow_runs": records}

success.__globals__["api"] = api
assert success(commit)
for key, value in (("head_sha", "b" * 40), ("head_branch", "other"),
                   ("event", "pull_request"), ("status", "in_progress"),
                   ("conclusion", "failure"),
                   ("head_repository", {"full_name": "someone/fork"})):
    records[:] = [{**run, key: value}]
    assert not success(commit)
`, resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
