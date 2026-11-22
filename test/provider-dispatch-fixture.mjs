import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderBinding } from '../src/provider-binding.mjs';
import { providerHost } from './provider-fixture.mjs';

// Dispatch hands codexStageExecutor exactly what composition needs: Codex options
// unchanged, Claude options plus the binding's provider and credential kind.
const received = [];
mock.module('../src/codex-stage.mjs', { namedExports: {
  codexStageExecutor: async options => { received.push(options); return 'executor'; },
} });
const { installedProviderExecutor } = await import('../src/installed-provider.mjs');

const codex = providerHost();
codex.providerBinding = createProviderBinding(codex);
const codexOptions = { installation: codex.installation, authFile: codex.authFile,
  model: codex.model, isolation: codex.repository.isolation, token: 'fixture',
  execution: { role: 'writer' } };
assert.equal(await installedProviderExecutor(codex)(codexOptions), 'executor');
assert.deepEqual(received[0], codexOptions);
assert.deepEqual(Object.keys(received[0]), Object.keys(codexOptions));

const claude = providerHost();
claude.model = 'claude-opus-4';
claude.repository.isolation.agent.codexVersion = '2.1.326 (Claude Code)';
claude.providerBinding = createProviderBinding(claude, 'claude',
  { credentialKind: 'anthropic-api-key' });
const claudeOptions = { installation: claude.installation,
  // Adoption still records a login path; Claude composition never uses it.
  authFile: '/not/the/adopted/path', model: claude.model,
  isolation: claude.repository.isolation, token: 'fixture' };
assert.equal(await installedProviderExecutor(claude)(claudeOptions), 'executor');
assert.deepEqual(received[1], { ...claudeOptions, provider: 'claude',
  credentialKind: 'anthropic-api-key' });
console.log('Provider dispatch passed.');
