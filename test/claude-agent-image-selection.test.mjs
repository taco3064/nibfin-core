import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  diagnosedDocker, failureTail,
} from '../scripts/verify-live-claude-agent-image.mjs';

test('live image check failures name the step, exit code and bounded stderr',
  async () => {
    const stderr = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(400)}`)
      .join('\n') + '\n\n';
    const tail = failureTail(stderr).split('\n');
    assert.equal(tail.length, 40);
    assert(tail[0].startsWith('line 20 ') && tail.at(-1).startsWith('line 59 '));
    assert(tail.every(line => line.length <= 300));
    // A RUN's own error stays visible even when later build output follows it.
    const build = ['#8 0.017 runc run failed: error mounting "sysfs"',
      'E: Unable to locate package bubblewrap', ...stderr.split('\n')].join('\n');
    const shown = failureTail(build).split('\n');
    assert.deepEqual(shown.slice(0, 3), ['#8 0.017 runc run failed: error mounting ' +
      '"sysfs"', 'E: Unable to locate package bubblewrap', '...']);
    assert.equal(shown.length, 43);
    const logged = [];
    const progress = { step: 'build managed-agent' };
    const calls = [];
    const run = async (file, args, options) => {
      calls.push({ file, args, options });
      return args.includes('ok') ? { exitCode: 0, stdout: Buffer.from('done') }
        : { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
    };
    const docker = diagnosedDocker(run, '/run/test.sock', progress,
      line => logged.push(line));
    assert.equal(await docker(['image', 'ok'], { input: 'recipe' }), 'done');
    assert.deepEqual(calls[0].args.slice(0, 2), ['--host', 'unix:///run/test.sock']);
    assert.equal(calls[0].options.input, 'recipe');
    assert.equal(calls[0].options.allowedExitCodes.length, 256);
    await assert.rejects(docker(['build', '--file', '-']),
      { code: 'PROCESS_FAILED', exitCode: 1 });
    assert.equal(logged[0], 'NIBFIN_CLAUDE_IMAGE_STEP_FAILED ' +
      'step=build managed-agent command=docker build exit=1');
    assert.equal(logged[1], failureTail(stderr));
  });

const root = fileURLToPath(new URL('..', import.meta.url));
const select = (flag, path) => {
  const result = spawnSync(process.execPath, ['scripts/test-changes.mjs', flag, path],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('Claude agent image inputs and resolvers select the live image check', () => {
  for (const path of ['src/security/managed-claude-agent.Dockerfile',
    'src/security/claude-package.mjs', 'src/security/nibfin-bash',
    'src/security/managed-agent.Dockerfile', 'src/security/agent.Dockerfile',
    'src/security/managed-npm/package-lock.json', 'src/agent-image-inputs.mjs',
    'src/claude-agent-plan.mjs', 'src/managed-derived-image.mjs',
    'scripts/verify-live-claude-agent-image.mjs',
    'scripts/live-docker-profile.mjs', 'src/security/nibfin-claude.apparmor',
    'src/security/codex-security.apparmor', 'src/claude-bootstrap.mjs',
    'src/security/seccomp.json']) {
    assert.equal(select('--claude-agent-image', path), 'true\n', path);
    assert.equal(select('--native-docker', path), 'native_docker=true\n', path);
  }
  for (const path of ['README.md', 'src/security/claude-model.Dockerfile',
    'src/stage-handlers.mjs'])
    assert.equal(select('--claude-agent-image', path), 'false\n', path);
});

test('the native Docker route runs the live check only for selected PRs',
  async () => {
    const action = await readFile(new URL(
      '../.github/actions/native-docker/action.yml', import.meta.url), 'utf8');
    const step = action.split('\n    - name: ').find(part =>
      part.startsWith('Build and check the managed Claude agent image'));
    assert(step, 'step missing');
    assert.match(step, /if: github\.event_name == 'pull_request'/);
    assert.match(step,
      /if \[\[ "\$\(node scripts\/test-changes\.mjs --claude-agent-image\)" == true/);
    assert.match(step, /node scripts\/verify-live-claude-agent-image\.mjs/);
    // Both profiles load before the daemon starts and unload at the end.
    for (const profile of ['codex-security', 'nibfin-claude']) {
      const file = `src/security/${profile}.apparmor`;
      const load = action.indexOf(`sudo apparmor_parser -r ${file}\n`);
      assert(load >= 0 && load < action.indexOf('/usr/bin/dockerd'), profile);
      assert(action.includes(`sudo apparmor_parser -R ${file}\n`), profile);
    }
  });
