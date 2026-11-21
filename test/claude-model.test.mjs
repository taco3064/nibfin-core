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

test('recipe copy closure loads bridge without Core delivery dependencies', async () => {
  const { mkdtemp, mkdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'claude-recipe-'));
  try {
    const recipe = (await readFile('src/security/claude-model.Dockerfile', 'utf8'))
      .replaceAll('\\\n', '');
    for (const line of recipe.split('\n')) {
      if (!line.startsWith('COPY ')) continue;
      const fields = line.trim().split(/\s+/).slice(1)
        .filter(field => !field.startsWith('--'));
      const destination = fields.pop();
      for (const source of fields) {
        const target = destination.endsWith('/') ?
          join(root, destination, source.split('/').at(-1)) : join(root, destination);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    }
    const url = pathToFileURL(join(root, 'opt/nibfin/claude/src/claude-work-bridge.mjs'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(url.href)})`], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    const bridge = join(root, 'opt/nibfin/claude/bin/work-tools');
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      const rejected = spawnSync(process.execPath, [bridge], { encoding: 'utf8',
        env: { [name]: 'synthetic-inherited-key' } });
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stderr, 'WORK_CHANNEL_UNAVAILABLE\n');
    }
    const { runWorkBridge } = await import(url.href);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-inherited-token';
    try {
      await assert.rejects(runWorkBridge(process.stdin, process.stdout),
        { message: 'WORK_CREDENTIAL_DENIED' });
    } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  } finally { await rm(root, { recursive: true, force: true }); }
});
