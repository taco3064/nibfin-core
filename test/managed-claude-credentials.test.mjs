import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCredentialInput } from '../src/managed-credential-input.mjs';
import { consumeManagedCredentials, manageCredentials } from
  '../src/managed-credentials.mjs';
import { lifecyclePath, lifecycleState, writeLifecycle } from
  '../src/managed-credential-files.mjs';
import {
  claudeCredentialPaths, credentialPaths, publishedCredentialProvider,
} from '../src/managed-credential-set.mjs';
import { readClaudeCredential } from '../src/claude-model-credentials.mjs';
import { controllerResources } from '../src/security/shared-runner-start-check.mjs';

// Synthetic sentinels only; none is a real credential.
const github = 'fake_github_credential_1234567890';
const oauth = 'sk-ant-oat01-' + 'o'.repeat(40);
const apiKey = 'sk-ant-api03-' + 'k'.repeat(40);
const secrets = [github, oauth, apiKey, 'a'.repeat(25)];
const linux = { skip: process.platform !== 'linux' };
const options = { verify: async () => {} };
const claude = { ...options, provider: 'claude' };

const envelope = (provider, token = github) => Buffer.from(JSON.stringify({
  schemaVersion: 1, githubToken: token, ...provider }));
const codexEnvelope = (token = github) => envelope({ codex: {
  auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(25),
    refresh_token: 'r'.repeat(25), id_token: 'i'.repeat(25) } } }, token);
const claudeInput = (value, token) =>
  decodeCredentialInput(envelope({ claude: value }, token));
const noSecret = value => {
  const text = JSON.stringify(value) + String(value?.message ?? '');
  for (const secret of secrets) assert.ok(!text.includes(secret));
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-claude-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['state', 'credentials', 'codex'])
    await mkdir(join(root, name), { mode: 0o700 });
  return { uid: process.getuid(), gid: process.getgid(), memberId: 77,
    stateRoot: join(root, 'state'), tokenFile: join(root, 'credentials/github-token'),
    authFile: join(root, 'codex/auth.json'),
    oauthFile: join(root, 'credentials/claude-oauth-token'),
    apiKeyFile: join(root, 'credentials/anthropic-api-key'),
    credentials: join(root, 'credentials'), codex: join(root, 'codex'),
    credentialRepositories: [{ repository: 'owner/execution', repositoryId: 10 }] };
}
const kindFiles = host => ({ 'claude-subscription-token': host.oauthFile,
  'anthropic-api-key': host.apiKeyFile });
const listed = async host => ({
  credentials: (await readdir(host.credentials)).sort(),
  codex: (await readdir(host.codex)).sort() });

test('Claude envelope decodes one known credential kind without leaking it', () => {
  assert.deepEqual(claudeInput(oauth), { token: github,
    credentialKind: 'claude-subscription-token', credential: oauth + '\n' });
  assert.deepEqual(claudeInput(apiKey), { token: github,
    credentialKind: 'anthropic-api-key', credential: apiKey + '\n' });
  for (const value of ['sk-ant-' + 'x'.repeat(40), `${oauth}\n`, ` ${apiKey}`,
    'sk-ant-oat01-' + 'h'.repeat(600), '', 7, null, { key: oauth }]) {
    assert.throws(() => claudeInput(value), error =>
      error.code === 'MANAGED_CLAUDE_CREDENTIAL_INVALID' &&
      !error.message.includes('sk-ant'));
  }
  const both = JSON.parse(codexEnvelope());
  both.claude = oauth;
  for (const bytes of [Buffer.from(JSON.stringify(both)),
    envelope({ claude: oauth }, 'short'), Buffer.from(JSON.stringify({
      schemaVersion: 2, githubToken: github, claude: oauth }))]) {
    assert.throws(() => decodeCredentialInput(bytes), error =>
      error.code === 'MANAGED_CREDENTIAL_INPUT_INVALID' &&
      !error.message.includes('sk-ant'));
  }
});

test('Codex envelope decoding keeps its original material', () => {
  const value = decodeCredentialInput(codexEnvelope());
  assert.deepEqual(Object.keys(value), ['token', 'auth']);
  assert.equal(value.auth, JSON.stringify(JSON.parse(codexEnvelope()).codex) + '\n');
});

test('published profile provider selects the intake target', () => {
  for (const profile of [null, {}, { provider: 'codex' }])
    assert.equal(publishedCredentialProvider(profile), 'codex');
  assert.equal(publishedCredentialProvider({ provider: 'claude' }), 'claude');
  for (const provider of ['openai', 7, null])
    assert.throws(() => publishedCredentialProvider({ provider }),
      { code: 'MANAGED_CREDENTIAL_PROVIDER_MISMATCH' });
});

test('runner start check denies the bound provider credential set', () => {
  const host = { stateRoot: '/c/state', tokenFile: '/c/credentials/github-token',
    authFile: '/c/codex/auth.json' };
  const sock = '/run/nibfin-engine/docker.sock';
  const oauthPath = join('/c/credentials', 'claude-oauth-token');
  const apiKeyPath = join('/c/credentials', 'anthropic-api-key');
  assert.deepEqual(controllerResources(host, { credentialKind: 'codex-chatgpt' }),
    [host.stateRoot, host.tokenFile, host.authFile, sock]);
  assert.deepEqual(controllerResources(host,
    { credentialKind: 'claude-subscription-token' }),
  [host.stateRoot, host.tokenFile, oauthPath, sock]);
  assert.deepEqual(controllerResources(host, { credentialKind: 'anthropic-api-key' }),
    [host.stateRoot, host.tokenFile, apiKeyPath, sock]);
  assert.throws(() => controllerResources(host, { credentialKind: 'other' }),
    { code: 'MANAGED_CREDENTIAL_KIND_INVALID' });
  assert.deepEqual(credentialPaths(host), [host.tokenFile, host.authFile]);
  assert.deepEqual(claudeCredentialPaths(host), [oauthPath, apiKeyPath]);
});

test('Codex record, files and status keep their original shape', linux, async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', decodeCredentialInput(codexEnvelope()),
    options);
  const record = JSON.parse(await readFile(lifecyclePath(host), 'utf8'));
  assert.deepEqual(Object.keys(record), ['schemaVersion', 'memberId', 'phase', 'files']);
  assert.deepEqual(await listed(host),
    { credentials: ['github-token', 'managed.json'], codex: ['auth.json'] });
  const status = await manageCredentials(host, 'status', null, options);
  assert.deepEqual(Object.keys(status),
    ['status', 'phase', 'access', 'memberId', 'guidance']);
  await assert.rejects(manageCredentials(host, 'replace', claudeInput(oauth), options),
    { code: 'MANAGED_CREDENTIAL_PROVIDER_MISMATCH' });
});

test('Claude intake stores the token and one credential of its kind', linux,
  async t => {
    for (const [value, kind, name] of [
      [oauth, 'claude-subscription-token', 'claude-oauth-token'],
      [apiKey, 'anthropic-api-key', 'anthropic-api-key']]) {
      const host = await fixture(t);
      const result = await manageCredentials(host, 'intake', claudeInput(value), claude);
      assert.equal(result.status, 'active');
      noSecret(result);
      assert.deepEqual(await listed(host), { credentials:
        [name, 'github-token', 'managed.json'].sort(), codex: [] });
      const file = join(host.credentials, name);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(await readFile(file, 'utf8'), value + '\n');
      assert.equal(await readClaudeCredential(host.uid, kindFiles(host)), value);
      const state = await lifecycleState(host);
      assert.equal(state.credentialKind, kind);
      assert.equal(state.files.length, 2);
      const status = await manageCredentials(host, 'status', null, options);
      assert.equal(status.credentialKind, kind);
      assert.equal(status.access, 'authorized');
      noSecret(status);
    }
  });

test('provider mismatch refuses before anything is written', linux, async t => {
  const host = await fixture(t);
  for (const [material, provider] of [[claudeInput(oauth), 'codex'],
    [decodeCredentialInput(codexEnvelope()), 'claude']]) {
    for (const operation of ['intake', 'replace'])
      await assert.rejects(manageCredentials(host, operation, material,
        { ...options, provider }), error => {
        noSecret(error);
        return error.code === 'MANAGED_CREDENTIAL_PROVIDER_MISMATCH';
      });
  }
  await assert.rejects(manageCredentials(host, 'intake', claudeInput(oauth), options),
    { code: 'MANAGED_CREDENTIAL_PROVIDER_MISMATCH' });
  assert.deepEqual(await listed(host), { credentials: [], codex: [] });
});

test('replace renews one kind and refuses a different kind', linux, async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', claudeInput(oauth), claude);
  await assert.rejects(manageCredentials(host, 'replace', claudeInput(apiKey), claude),
    error => {
      noSecret(error);
      return error.code === 'MANAGED_CREDENTIAL_KIND_CHANGE_REQUIRES_DISCONNECT';
    });
  assert.equal(await readFile(host.oauthFile, 'utf8'), oauth + '\n');
  await assert.rejects(readFile(host.apiKeyFile), { code: 'ENOENT' });
  assert.equal((await manageCredentials(host, 'replace', claudeInput(oauth),
    claude)).reused, true);
  const renewed = 'sk-ant-oat01-' + 'n'.repeat(40);
  const result = await manageCredentials(host, 'replace', claudeInput(renewed), claude);
  assert.equal(result.reused, undefined, 'same token, changed credential is written');
  assert.equal(await readFile(host.oauthFile, 'utf8'), renewed + '\n');
  assert.equal(await readClaudeCredential(host.uid, kindFiles(host)), renewed);
  assert.equal((await lifecycleState(host)).phase, 'active');
});

test('Codex replace with a renewed auth file rewrites the whole set', linux,
  async t => {
    const host = await fixture(t);
    await manageCredentials(host, 'intake', decodeCredentialInput(codexEnvelope()),
      options);
    const same = decodeCredentialInput(codexEnvelope());
    assert.equal((await manageCredentials(host, 'replace', same, options)).reused,
      true);
    const renewed = { ...same, auth: same.auth.replace('r'.repeat(25), 'R'.repeat(25)) };
    assert.equal((await manageCredentials(host, 'replace', renewed, options)).reused,
      undefined);
    assert.equal(await readFile(host.authFile, 'utf8'), renewed.auth);
  });

test('switching Codex to Claude is disconnect, then intake', linux, async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', decodeCredentialInput(codexEnvelope()),
    options);
  await assert.rejects(manageCredentials(host, 'replace', claudeInput(oauth), claude),
    { code: 'MANAGED_CREDENTIAL_KIND_CHANGE_REQUIRES_DISCONNECT' });
  await assert.rejects(manageCredentials(host, 'intake', claudeInput(oauth), claude),
    { code: 'MANAGED_CREDENTIAL_ALREADY_ENROLLED' });
  assert.equal((await manageCredentials(host, 'disconnect')).status, 'disconnected');
  await manageCredentials(host, 'intake', claudeInput(oauth), claude);
  assert.deepEqual(await listed(host), { credentials:
    ['claude-oauth-token', 'github-token', 'managed.json'], codex: [] });
});

test('interrupted disconnect of a Claude set recovers before intake', linux,
  async t => {
    const host = await fixture(t);
    await manageCredentials(host, 'intake', claudeInput(oauth), claude);
    const pending = await manageCredentials(host, 'disconnect', null, {
      settle: async () => { throw new Error('unsettled'); } });
    assert.equal(pending.status, 'pending');
    const state = await lifecycleState(host);
    assert.equal(state.phase, 'disconnecting');
    assert.equal(state.credentialKind, 'claude-subscription-token');
    await assert.rejects(manageCredentials(host, 'intake', claudeInput(apiKey), claude),
      { code: 'MANAGED_CREDENTIAL_ALREADY_ENROLLED' });
    assert.equal((await manageCredentials(host, 'disconnect')).status, 'disconnected');
    assert.deepEqual(await listed(host), { credentials: ['managed.json'], codex: [] });
    await manageCredentials(host, 'intake', claudeInput(apiKey), claude);
    assert.deepEqual(await listed(host), { credentials:
      ['anthropic-api-key', 'github-token', 'managed.json'], codex: [] });
    assert.equal(await readClaudeCredential(host.uid, kindFiles(host)), apiKey);
  });

test('Claude intake refuses when any Claude kind file exists', linux, async t => {
  for (const name of ['oauthFile', 'apiKeyFile']) {
    const host = await fixture(t);
    await writeFile(host[name], 'manual', { mode: 0o600 });
    await chmod(host[name], 0o600);
    for (const value of [oauth, apiKey])
      await assert.rejects(manageCredentials(host, 'intake', claudeInput(value), claude),
        { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
    assert.equal(await readFile(host[name], 'utf8'), 'manual');
    await assert.rejects(readFile(host.tokenFile), { code: 'ENOENT' });
  }
});

test('admission and disconnect verify the recorded Claude file', linux, async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', claudeInput(oauth), claude);
  let ran = false;
  await consumeManagedCredentials(host, async () => { ran = true; }, options);
  assert.equal(ran, true);
  await rename(host.oauthFile, host.oauthFile + '.preserved');
  await writeFile(host.oauthFile, oauth + '\n', { mode: 0o600 });
  await assert.rejects(consumeManagedCredentials(host, async () => {}, options),
    { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
  await assert.rejects(manageCredentials(host, 'disconnect'),
    { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
  assert.equal(await readFile(host.oauthFile, 'utf8'), oauth + '\n');
});

test('a record with an unknown credential kind is invalid state', linux, async t => {
  const host = await fixture(t);
  await writeLifecycle(host, { schemaVersion: 1, memberId: host.memberId,
    phase: 'disconnected', credentialKind: 'other', files: [] });
  await assert.rejects(lifecycleState(host),
    { code: 'MANAGED_CREDENTIAL_STATE_INVALID' });
  await assert.rejects(manageCredentials(host, 'intake', claudeInput(oauth), claude),
    { code: 'MANAGED_CREDENTIAL_STATE_INVALID' });
});
