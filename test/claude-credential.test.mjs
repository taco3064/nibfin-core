import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  claudeCredentialKind, claudeCredentialKinds, readClaudeCredential,
  validClaudeCredential,
} from '../src/claude-model-credentials.mjs';
import { claudeModelComponent } from '../src/claude-model-runner.mjs';
import { modelContainerArgs } from '../src/claude-model-container.mjs';
import { modelFixture } from './fixtures/claude-model-lifecycle.mjs';

const token = 'sk-ant-oat01-' + 'a'.repeat(40);
const apiKey = 'sk-ant-api03-' + 'b'.repeat(40);

test('Claude credential kinds distinguish subscription token and API key', () => {
  assert.equal(claudeCredentialKind(token), 'claude-subscription-token');
  assert.equal(claudeCredentialKind(apiKey), 'anthropic-api-key');
  for (const value of ['sk-ant-' + 'c'.repeat(40), 'sk-ant-oat01-short',
    `${token}\n`, `${token} extra`, 'sk-ant-admin01-' + 'd'.repeat(40), undefined, 7]) {
    assert.equal(claudeCredentialKind(value), undefined);
    assert.equal(validClaudeCredential(value), false);
  }
  assert.deepEqual(claudeModelComponent.credentialKinds,
    ['claude-subscription-token', 'anthropic-api-key']);
});

test('self-contained model entry uses the same credential patterns', async () => {
  const entry = await readFile(
    new URL('../src/claude-model-entry.mjs', import.meta.url), 'utf8');
  const { pattern: oauth } = claudeCredentialKinds['claude-subscription-token'];
  const { pattern: api } = claudeCredentialKinds['anthropic-api-key'];
  assert.ok(entry.includes(`/${oauth.source}/.test(input.key)`));
  assert.ok(entry.includes(`/${api.source}/.test(input.key)`));
  assert.match(entry, /\? 'CLAUDE_CODE_OAUTH_TOKEN'/);
  assert.match(entry, /\? 'ANTHROPIC_API_KEY' : undefined/);
  assert.ok(!/sk-ant-\[/.test(entry), 'no generic sk-ant- pattern remains');
});

test('model entry refuses an unrecognized credential before launching', () => {
  const entry = new URL('../src/claude-model-entry.mjs', import.meta.url);
  for (const key of ['sk-ant-' + 'e'.repeat(40), 'not-a-key']) {
    const result = spawnSync(process.execPath, [entry.pathname.replace(/^\/(\w:)/, '$1')],
      { input: JSON.stringify({ prompt: 'x', key }), encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CLAUDE_PRIVATE_MODEL_INPUT_INVALID\n');
  }
});

test('model container keeps memory, updates and extra traffic disabled', () => {
  const args = modelContainerArgs({
    image: `sha256:${'a'.repeat(64)}`, name: 'fixed', channel: '/private/channel',
    plan: { environment: { PATH: '/bin', HOME: '/session',
      CLAUDE_CONFIG_DIR: '/session/config', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CODE_OAUTH_TOKEN: token }, args: [] },
    egress: { network: 'model', proxyUrl: 'http://172.17.0.1:3128' }, inherited: [],
  });
  for (const value of ['CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', 'DISABLE_AUTOUPDATER=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'])
    assert.ok(args.includes(value), value);
  assert.ok(!args.some(value => value.includes(token)));
});

test('model recipe proves no managed settings or user dirs', async () => {
  const recipe = await readFile(
    new URL('../src/security/claude-model.Dockerfile', import.meta.url), 'utf8');
  assert.ok(recipe.includes('test ! -e /etc/claude-code'));
  assert.ok(recipe.includes(
    `io.nibfin.claude-managed-settings="${claudeModelComponent.managedSettings}"`));
});

test('simulated runner rejects unproven managed settings and bad credentials',
  async t => {
    for (const mode of ['settings', 'credential']) {
      await t.test(mode, async t => {
        const f = await modelFixture();
        t.after(async () => {
          try { await f.runner.requestCleanup(f.admission.executionId); }
          finally { await f.close(); }
        });
        if (mode === 'settings') f.modelControls.managedSettings = 'present';
        else f.modelControls.key = 'sk-ant-' + 'f'.repeat(40);
        await assert.rejects(f.execute(), {
          message: mode === 'settings' ? 'CLAUDE_MODEL_IMAGE_UNVERIFIED'
            : 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
        assert.equal(f.modelControls.modelExists, false);
      });
    }
    await t.test('api key', async t => {
      const f = await modelFixture();
      t.after(async () => {
        try { await f.runner.requestCleanup(f.admission.executionId); }
        finally { await f.close(); }
      });
      f.modelControls.key = apiKey;
      assert.equal((await f.execute()).status, 'completed');
    });
  });

test('stored credential must be exactly one private file of its own kind',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'claude-credential-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o700);
    const files = { 'claude-subscription-token': join(root, 'oauth'),
      'anthropic-api-key': join(root, 'api') };
    const uid = process.getuid();
    const store = async (kind, value) => {
      await writeFile(files[kind], value, { mode: 0o600 });
      await chmod(files[kind], 0o600);
    };
    await assert.rejects(readClaudeCredential(uid, files),
      { message: 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
    await store('claude-subscription-token', `${token}\n`);
    assert.equal(await readClaudeCredential(uid, files), token);
    await store('anthropic-api-key', apiKey);
    await assert.rejects(readClaudeCredential(uid, files),
      { message: 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
    await rm(files['claude-subscription-token']);
    assert.equal(await readClaudeCredential(uid, files), apiKey);
    await store('anthropic-api-key', token);
    await assert.rejects(readClaudeCredential(uid, files),
      { message: 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
    await store('anthropic-api-key', apiKey);
    await chmod(files['anthropic-api-key'], 0o644);
    await assert.rejects(readClaudeCredential(uid, files),
      { message: 'CLAUDE_CREDENTIAL_UNAVAILABLE' });
  });
