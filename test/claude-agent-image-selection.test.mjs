import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
    'src/claude-agent-plan.mjs', 'scripts/verify-live-claude-agent-image.mjs',
    'scripts/live-docker-profile.mjs']) {
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
  });
