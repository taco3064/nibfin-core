import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { consumerContract } from '../src/public-api.mjs';
import { preparedResult } from '../src/managed-resource-contract.mjs';
import { decodeCredentialInput } from '../src/managed-credential-input.mjs';

// The Codex capability exactly as published before Claude was advertised.
const codexPreparation = '{"kind":"linux-managed-resources-v1",' +
  '"executable":"/opt/nibfin/core/bin/nibfin-prepare-shared-host.mjs",' +
  '"arguments":["--consent-resource-preparation"],' +
  '"statuses":["prepared","denied","pending"],' +
  '"preparedCode":"MANAGED_RESOURCES_PREPARED",' +
  '"profile":"/etc/nibfin/shared-host-profile.json",' +
  '"resultKeys":["status","code","profile","images","adoption","servicesReady"],' +
  '"imageKeys":["agent","hooks"],' +
  '"exitCodes":{"prepared":0,"denied":1,"pending":2},' +
  '"adoption":false,"servicesReady":false,"credentialsRequired":false,' +
  '"registrationsRequired":false,"architectures":["amd64","arm64"]}';

const preparation = consumerContract.managedResourcePreparation;
const image = name => 'sha256:' + name.repeat(64).slice(0, 64);

test('the Claude advertisement leaves every existing preparation key unchanged', () => {
  const { agents, ...codex } = preparation;
  assert.equal(JSON.stringify(codex), codexPreparation);
  assert.deepEqual(Object.keys(agents), ['claude']);
  assert.deepEqual(agents.claude, {
    arguments: ['--consent-resource-preparation', '--agent=claude'],
    imageKeys: ['agent', 'hooks', 'claudeAgent'],
  });
  assert(Object.isFrozen(agents.claude.arguments));
  assert(Object.isFrozen(agents.claude.imageKeys));
});

test('the advertised vectors match the entry and both prepared results', () => {
  const entry = args => {
    const result = spawnSync(process.execPath,
      ['bin/nibfin-prepare-shared-host.mjs', ...args], { encoding: 'utf8' });
    return [result.status, JSON.parse(result.stdout).code];
  };
  // The Claude vector passes the same consent parsing and reaches the same
  // engine admission as the Codex vector; a reordered vector is refused.
  const claude = preparation.agents.claude;
  assert.deepEqual(entry(claude.arguments), entry(preparation.arguments));
  assert.deepEqual(entry([...claude.arguments].reverse()),
    [1, 'RESOURCE_PREPARATION_CONSENT_REQUIRED']);
  const images = { agent: image('a'), hooks: image('b') };
  assert.deepEqual(Object.keys(preparedResult(images).images), preparation.imageKeys);
  assert.deepEqual(Object.keys(preparedResult(images, image('c')).images),
    claude.imageKeys);
});

test('the Claude credential description matches the intake envelope', () => {
  const claude = consumerContract.managedCredentials.claude;
  assert.deepEqual(Object.keys(consumerContract.managedCredentials), ['claude']);
  assert.deepEqual(claude.credentialKinds, consumerContract.claudeModel.credentialKinds);
  const githubToken = 'g'.repeat(40);
  const values = { 'claude-subscription-token': 'sk-ant-oat01-' + 'a'.repeat(40),
    'anthropic-api-key': 'sk-ant-api03-' + 'b'.repeat(40) };
  assert.deepEqual(Object.keys(values), claude.credentialKinds);
  for (const kind of claude.credentialKinds) {
    const envelope = { schemaVersion: 1, githubToken,
      [claude.envelopeKey]: values[kind] };
    const decoded = decodeCredentialInput(Buffer.from(JSON.stringify(envelope)));
    assert.equal(decoded.credentialKind, kind);
  }
});
