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

test('rollout never finishes from the installed target commit alone', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import json, runpy, sys, tempfile
from pathlib import Path
module = runpy.run_path(sys.argv[1])
finish = module["finish"]
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    finish.__globals__["CONFIG"] = root
    (root / "rollout-plan.json").write_text(json.dumps({"pin": {"commit": "a" * 40}}))
    try:
        finish([])
        raise AssertionError("An installed commit is insufficient")
    except RuntimeError as error:
        assert "completion" in str(error)
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
    endpoint = f"repos/{core}/actions/workflows/ci.yml/runs"
    assert path == f"{endpoint}?head_sha={commit}&per_page=100"
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
