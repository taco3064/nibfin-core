import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderBinding, installedProvider, providerComponents, validateProviderBinding,
} from '../src/provider-binding.mjs';
import { installedProviderExecutor } from '../src/installed-provider.mjs';
import { unsupportedMcp } from '../src/provider-mcp.mjs';
import { claudeCredentialReader } from '../src/claude-composition.mjs';
import { adoptedProviderBinding } from '../src/shared-host-adopt.mjs';
import { prepareDiagnosisInvocation } from '../src/diagnosis-invocation.mjs';
import { digest } from '../src/identity.mjs';
import { providerHost } from './provider-fixture.mjs';

const kind = 'claude-subscription-token';
const claudeComponents = { contract: 1, roleAdapter: 'claude-role-v1',
  modelRunner: 'claude-code-v1', toolChannel: 'claude-sandbox-tools-v1' };

function claudeHost() {
  const host = providerHost();
  host.model = 'claude-opus-4';
  host.providerBinding = createProviderBinding(host, 'claude', { credentialKind: kind });
  return host;
}

// Captured from the base branch before the Claude composition was added.
test('Codex components, digest and binding object stay byte-identical', () => {
  const host = providerHost();
  assert.equal(digest(providerComponents(host)),
    '9a76fc16dfc592a3d256eec6e3426ce8bd40ee5b6543adb518362a68b240e1c1');
  const golden = 'f5e545caa57ee0630feaa15b2bd492a9eef31404ed97f3ab4c95ad689dc55378';
  assert.equal(digest(createProviderBinding(host)), golden);
  assert.equal(digest(createProviderBinding(host, 'codex',
    { credentialKind: 'codex-chatgpt' })), golden);
  assert.equal(digest(installedProvider(host)), golden);
  assert.deepEqual(Object.keys(createProviderBinding(host)), ['schemaVersion',
    'provider', 'original', 'modelProfile', 'credentialKind', 'components']);
  for (const credentialKind of [kind, 'anthropic-api-key', 'other'])
    assert.throws(() => createProviderBinding(host, 'codex', { credentialKind }),
      { code: 'PROVIDER_CREDENTIAL_KIND_INVALID' });
});

test('a Claude binding names its components and one credential kind', () => {
  const host = claudeHost();
  const binding = installedProvider(host);
  assert.equal(binding.provider, 'claude');
  assert.equal(binding.original.provider, 'claude');
  assert.equal(binding.credentialKind, kind);
  assert.deepEqual(binding.modelProfile, { model: 'claude-opus-4' });
  assert.deepEqual(binding.components, { ...claudeComponents,
    hostProfile: host.repository.isolation.kind, source: host.installation.pin,
    agentImage: host.repository.isolation.agent.image });
  assert.deepEqual(providerComponents(host, 'claude'), binding.components);
  assert(!JSON.stringify(binding).includes(host.authFile));
  const api = createProviderBinding(providerHost(), 'claude',
    { credentialKind: 'anthropic-api-key' });
  assert.equal(validateProviderBinding(api).credentialKind, 'anthropic-api-key');
  for (const credentialKind of [undefined, 'codex-chatgpt', 'toString', 'other'])
    assert.throws(() => createProviderBinding(providerHost(), 'claude',
      { credentialKind }), { code: 'PROVIDER_CREDENTIAL_KIND_INVALID' });
  // Adoption still writes authFile; a Claude binding keeps requiring it.
  const missing = providerHost();
  delete missing.authFile;
  assert.throws(() => createProviderBinding(missing, 'claude', { credentialKind: kind }),
    { code: 'INCOMPATIBLE_PROVIDER_HOST' });
});

test('Claude binding validation rejects foreign components and kinds', () => {
  for (const change of [
    b => { b.credentialKind = 'codex-chatgpt'; },
    b => { delete b.credentialKind; },
    b => { b.components.roleAdapter = 'codex-role-v1'; },
    b => { b.components.modelRunner = 'codex-exec-v1'; },
    b => { b.components.toolChannel = 'codex-isolated-tools-v1'; },
  ]) {
    const binding = structuredClone(claudeHost().providerBinding);
    change(binding);
    assert.throws(() => validateProviderBinding(binding),
      { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
  }
  const host = claudeHost();
  host.providerBinding.components = providerComponents(host);
  assert.throws(() => installedProvider(host),
    { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
  const codex = providerHost();
  codex.providerBinding = createProviderBinding(codex);
  codex.providerBinding.components = providerComponents(codex, 'claude');
  assert.throws(() => installedProvider(codex),
    { code: 'PROVIDER_COMPOSITION_UNAVAILABLE' });
});

test('legacy hosts without a binding are inferred only as Codex', () => {
  const host = providerHost();
  host.model = 'claude-opus-4';
  assert.equal(installedProvider(host).provider, 'codex');
  assert.equal(installedProvider(host).credentialKind, 'codex-chatgpt');
});

test('adoption keeps refusing Claude until credential intake exists', () => {
  assert.throws(() => adoptedProviderBinding(providerHost(), 'claude'),
    { code: 'CLAUDE_ADOPTION_UNAVAILABLE' });
  assert.equal(digest(adoptedProviderBinding(providerHost(), undefined)),
    digest(createProviderBinding(providerHost())));
  assert.throws(() => adoptedProviderBinding(providerHost(), 'external-plugin'),
    { code: 'UNKNOWN_INSTALLED_PROVIDER' });
});

test('Claude dispatch checks its CLI version instead of the login file', () => {
  const host = claudeHost();
  host.repository.isolation.agent.codexVersion = '2.1.326 (Claude Code)';
  const compose = installedProviderExecutor(host);
  const options = { installation: host.installation, model: host.model,
    isolation: host.repository.isolation };
  for (const change of [
    o => { o.isolation = { ...o.isolation,
      agent: { ...o.isolation.agent, codexVersion: 'codex-cli 0.138.0' } }; },
    o => { o.isolation = { ...o.isolation,
      agent: { ...o.isolation.agent, image: 'sha256:' + 'e'.repeat(64) } }; },
    o => { o.model = 'repo-selected'; },
    o => { o.installation = { directory: '/repo' }; },
  ]) {
    const changed = structuredClone(options);
    change(changed);
    assert.throws(() => compose(changed), { code: 'PROVIDER_COMPONENT_MISMATCH' });
  }
  assert.throws(() => compose({ ...options, provider: 'codex' }),
    { code: 'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD' });
});

test('Claude pools find host or target-repository MCP unsupported', () => {
  const host = claudeHost();
  const mcp = { servers: { fixture: {} } };
  assert.equal(unsupportedMcp({ ...host, mcp }, mcp), true);
  // Only the target repository's host profile configures MCP.
  assert.equal(unsupportedMcp(host, mcp), true);
  assert.equal(unsupportedMcp(host, undefined), false);
  // An unconfigured source needs no provider observation at all.
  assert.equal(unsupportedMcp({}, undefined), false);
  const codex = providerHost();
  assert.equal(unsupportedMcp({ ...codex, mcp }, mcp), false);
});

test('the binding loads no host or filesystem module for credential kinds', async () => {
  const { readFile } = await import('node:fs/promises');
  const leaf = await readFile(new URL('../src/claude-credential-kinds.mjs',
    import.meta.url), 'utf8');
  assert.doesNotMatch(leaf, /^import /m);
  const binding = await readFile(new URL('../src/provider-binding.mjs',
    import.meta.url), 'utf8');
  assert.doesNotMatch(binding, /claude-model-credentials/);
});

test('diagnosis on a Claude pool refuses before reading any credential', async () => {
  const uid = process.getuid();
  const adopted = { ...claudeHost(), uid };
  let reads = 0;
  const count = async () => { reads++; };
  await assert.rejects(prepareDiagnosisInvocation({ uid, diagnosisHost: adopted },
    { id: 'I_target' }, { verify: count, read: count, socket: count,
      environment: count }), { code: 'CLAUDE_DIAGNOSIS_UNSUPPORTED' });
  assert.equal(reads, 0);
});

test('the composed Claude reader returns only a credential of the bound kind',
  async () => {
    const token = 'sk-ant-oat01-' + 'c'.repeat(40);
    const key = 'sk-ant-api03-' + 'k'.repeat(40);
    assert.equal(await claudeCredentialReader(kind, async () => token)(), token);
    assert.equal(await claudeCredentialReader('anthropic-api-key',
      async () => key)(), key);
    await assert.rejects(claudeCredentialReader('anthropic-api-key',
      async () => token)(), { code: 'CLAUDE_CREDENTIAL_KIND_MISMATCH' });
    await assert.rejects(claudeCredentialReader(kind, async () => 'other')(),
      { code: 'CLAUDE_CREDENTIAL_KIND_MISMATCH' });
    for (const invalid of [undefined, 'codex-chatgpt', 'toString'])
      assert.throws(() => claudeCredentialReader(invalid),
        { code: 'PROVIDER_CREDENTIAL_KIND_INVALID' });
  });
