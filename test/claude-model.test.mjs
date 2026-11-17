import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { claudeModelComponent } from '../src/claude-model-runner.mjs';
import { modelContainerArgs } from '../src/claude-model-container.mjs';
import { claudeWorkServer } from '../src/claude-work-channel.mjs';

test('Claude model mounts just the private read-only channel', () => {
  const args = modelContainerArgs({
    image: `sha256:${'a'.repeat(64)}`, name: 'fixed',
    channel: '/private/session/work-channel',
    plan: { environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      ANTHROPIC_API_KEY: 'must-not-enter-docker-config' }, args: [] },
    egress: { network: 'model', proxyUrl: 'http://172.17.0.1:3128' }, inherited: [],
  });
  const mounts = args.flatMap((arg, i) => arg === '--mount' ? [args[i + 1]] : []);
  assert.deepEqual(mounts, [
    'type=bind,src=/private/session/work-channel,dst=/session/work-channel,' +
      'readonly,bind-propagation=rprivate,bind-recursive=disabled',
  ]);
  assert.ok(args.includes('--user=1001:1001'));
  assert.ok(args.includes('--log-driver=none'));
  assert.ok(args.includes('--security-opt=apparmor=codex-security-container'));
  assert.ok(!args.some(value => value.includes('ANTHROPIC_API_KEY')));
});

test('model package and protected runner share the bridge and release', async () => {
  const recipe = await readFile(
    new URL('../src/security/claude-model.Dockerfile', import.meta.url), 'utf8');
  const version = claudeModelComponent.cli.version;
  assert.ok(recipe.includes(`io.nibfin.claude-version="${version}"`));
  assert.ok(recipe.includes(claudeWorkServer().command));
});
