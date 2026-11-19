import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

test('actual Actions shell preserves Core exits, writes summary and removes temp result',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'actions-result-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'tmp'));
    await writeFile(join(root, '.node-version'), process.versions.node);
    await writeFile(join(root, 'bin/nibfin-core.mjs'), `
const status = Number(process.argv[3]);
console.log(JSON.stringify({stage: 'continue', terminalStage: 'deliver',
  status: status ? 'denied' : 'completed', stageProgress: [
    {stage: 'deliver', status: status ? 'denied' : 'completed'}]}));
process.exitCode = status;
`);
    await copyFile(new URL('../scripts/actions-summary.mjs', import.meta.url),
      join(root, 'scripts/actions-summary.mjs'));
    const source = await readFile(new URL('../.github/workflows/shared-runner.yml',
      import.meta.url), 'utf8');
    const shell = parse(source).jobs['shared-stage'].steps[0].run
      .replaceAll('/opt/nibfin/core', root)
      .replaceAll('/opt/nibfin/tools/node-v${version}-linux-x64/bin/node',
        process.execPath);
    for (const status of [0, 1, 2]) {
      const summary = join(root, `summary-${status}`);
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c',
        shell], { cwd: root, encoding: 'utf8', env: { ...process.env,
        NIBFIN_STAGE: 'continue', NIBFIN_ISSUE: String(status),
        RUNNER_TEMP: join(root, 'tmp'), GITHUB_STEP_SUMMARY: summary } });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      assert.match(await readFile(summary, 'utf8'), /deliver/);
      assert.deepEqual(await readdir(join(root, 'tmp')), []);
    }
    // The receiver can update before the installed Core gains its summary helper.
    await rm(join(root, 'scripts/actions-summary.mjs'));
    const result = spawnSync('/bin/bash', ['-e', '-c', shell], { cwd: root,
      encoding: 'utf8', env: { ...process.env, NIBFIN_STAGE: 'continue',
        NIBFIN_ISSUE: '0', RUNNER_TEMP: join(root, 'tmp') } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(join(root, 'tmp')), []);
  });
