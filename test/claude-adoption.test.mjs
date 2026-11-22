import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controllerCredentials } from '../src/shared-host-credentials.mjs';
import { adoptedProviderBinding } from '../src/shared-host-adopt.mjs';
import { peerConfiguration } from '../src/shared-peer-adoption.mjs';
import {
  compareProviderViews, createProviderBinding, installedProvider,
} from '../src/provider-binding.mjs';
import { digest } from '../src/identity.mjs';
import { providerHost } from './provider-fixture.mjs';

const files = { 'claude-subscription-token': 'claude-oauth-token',
  'anthropic-api-key': 'anthropic-api-key' };
const fake = 'not-a-secret';

async function controller(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-claude-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = join(root, 'credentials');
  await mkdir(credentials);
  const tokenFile = join(credentials, 'github-token');
  await writeFile(tokenFile, fake);
  const profile = { stateRoot: join(root, 'state'), tokenFile,
    authFile: join(root, 'codex', 'auth.json'), provider: 'claude' };
  const calls = [];
  const check = async (path, uid, directory = false) => {
    calls.push([path, uid, directory]);
  };
  const adopt = () => controllerCredentials(profile, 90, { credentials, check });
  return { root, credentials, profile, calls, adopt };
}

function claudeHost() {
  const host = providerHost();
  host.model = 'claude-opus-4';
  return host;
}

test('Codex adoption keeps its original file checks and binding', async () => {
  for (const provider of [undefined, 'codex', 'external-plugin']) {
    const profile = { stateRoot: '/state', tokenFile: '/private/token',
      authFile: '/codex/auth.json', ...(provider ? { provider } : {}) };
    const calls = [];
    const check = async (path, uid, directory = false) => {
      calls.push([path, uid, directory]);
    };
    assert.equal(await controllerCredentials(profile, 90, { check }), undefined);
    assert.deepEqual(calls, [['/state', 90, true], ['/private', 90, true],
      ['/codex', 90, true], ['/private/token', 90, false],
      ['/codex/auth.json', 90, false]]);
  }
  const golden = digest(createProviderBinding(providerHost()));
  for (const provider of [undefined, 'codex'])
    for (const options of [undefined, {},
      { credentialKind: 'claude-subscription-token' }])
      assert.equal(digest(adoptedProviderBinding(providerHost(), provider,
        options)), golden);
  assert.equal(adoptedProviderBinding(providerHost()).credentialKind,
    'codex-chatgpt');
  assert.throws(() => adoptedProviderBinding(providerHost(), 'external-plugin'),
    { code: 'UNKNOWN_INSTALLED_PROVIDER' });
});

test('Claude adoption records the kind of its one stored file', async t => {
  for (const [kind, name] of Object.entries(files)) {
    const { root, credentials, profile, calls, adopt } = await controller(t);
    await writeFile(join(credentials, name), fake);
    assert.equal(await adopt(), kind);
    assert.deepEqual(calls, [[profile.stateRoot, 90, true],
      [credentials, 90, true], [join(root, 'codex'), 90, true],
      [profile.tokenFile, 90, false], [join(credentials, name), 90, false]]);
    const host = claudeHost();
    host.providerBinding = adoptedProviderBinding(host, 'claude',
      { credentialKind: kind });
    assert.equal(host.providerBinding.provider, 'claude');
    assert.equal(host.providerBinding.credentialKind, kind);
    assert.equal(host.authFile, '/private/codex');
    assert.deepEqual(installedProvider(host), host.providerBinding);
  }
});

test('Claude adoption refuses a missing or second stored credential', async t => {
  const { credentials, calls, adopt } = await controller(t);
  await assert.rejects(adopt(), { code: 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID' });
  for (const name of Object.values(files))
    await writeFile(join(credentials, name), fake);
  await assert.rejects(adopt(), { code: 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID' });
  assert.equal(calls.some(([, , directory]) => !directory), false);
  assert.throws(() => adoptedProviderBinding(claudeHost(), 'claude'),
    { code: 'PROVIDER_CREDENTIAL_KIND_INVALID' });
});

test('Claude adoption requires the fixed managed credential directory', async t => {
  const { profile, calls, credentials } = await controller(t);
  await writeFile(join(credentials, files['anthropic-api-key']), fake);
  const check = async path => { calls.push(path); };
  await assert.rejects(controllerCredentials(profile, 90, { check }),
    { code: 'SHARED_HOST_PROFILE_INVALID' });
  const managed = { ...profile,
    tokenFile: '/var/lib/nibfin/controller/state/github-token' };
  await assert.rejects(controllerCredentials(managed, 90, { check }),
    { code: 'SHARED_HOST_PROFILE_INVALID' });
  assert.deepEqual(calls, []);
});

test('a peer copies the adopted Claude binding unchanged', () => {
  const host = claudeHost();
  host.providerBinding = adoptedProviderBinding(host, 'claude',
    { credentialKind: 'anthropic-api-key' });
  const observed = { head: 'e'.repeat(40), action: {}, issue: {} };
  const peer = peerConfiguration(host, 'example/peer', 2,
    { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40) },
    'b'.repeat(40), observed, 'c'.repeat(40));
  assert.deepEqual(peer.providerBinding, host.providerBinding);
  assert.deepEqual(compareProviderViews(host, peer), host.providerBinding);
});

test('Claude adoption checks real private controller files',
  { skip: process.platform !== 'linux' }, async t => {
    const { credentials, profile } = await controller(t);
    await mkdir(profile.stateRoot, { mode: 0o700 });
    await mkdir(join(profile.authFile, '..'), { mode: 0o700 });
    await chmod(credentials, 0o700);
    await chmod(profile.tokenFile, 0o600);
    const file = join(credentials, files['claude-subscription-token']);
    await writeFile(file, fake, { mode: 0o600 });
    const uid = process.getuid();
    const adopt = () => controllerCredentials(profile, uid, { credentials });
    assert.equal(await adopt(), 'claude-subscription-token');
    await chmod(file, 0o644);
    await assert.rejects(adopt(), { code: 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID' });
  });
