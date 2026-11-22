import { validProviderModel as model } from './provider-contract.mjs';
import { executionProfile } from './execution-profiles.mjs';
import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { claudeCredentialKinds } from './claude-credential-kinds.mjs';
import { codexCredentialKind } from './managed-credential-set.mjs';

const providers = ['codex', 'claude'];
// Code-owned composition per provider; Codex keeps its original identity.
const providerTable = Object.freeze({
  codex: Object.freeze({
    components: Object.freeze({ contract: 1, roleAdapter: 'codex-role-v1',
      modelRunner: 'codex-exec-v1', toolChannel: 'codex-isolated-tools-v1' }),
    credentialKind: kind => kind === codexCredentialKind,
  }),
  claude: Object.freeze({
    components: Object.freeze({ contract: 1, roleAdapter: 'claude-role-v1',
      modelRunner: 'claude-code-v1', toolChannel: 'claude-sandbox-tools-v1' }),
    credentialKind: kind => typeof kind === 'string' &&
      Object.hasOwn(claudeCredentialKinds, kind),
  }),
});
const compatibleProfile = name => {
  try { executionProfile(name); return true; } catch { return false; }
};
const image = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const same = (a, b) => digest(a ?? null) === digest(b ?? null);
const pin = value => value?.repository === 'taco3064/nibfin-core' &&
  isSha(value.commit) && isDigest(value.manifestHash);

export function providerIdentity(value) {
  requireThat(providers.includes(value), 'UNKNOWN_INSTALLED_PROVIDER');
  return value;
}

// These names describe code in the verified Core package, never loadable paths.
export function providerComponents(host, provider = 'codex') {
  const isolation = host.repository?.isolation;
  return { ...providerTable[providerIdentity(provider)].components,
    hostProfile: isolation?.kind, source: structuredClone(host.installation?.pin),
    agentImage: isolation?.agent?.image };
}

function compatibleComponents(binding) {
  const c = binding.components;
  requireThat(c?.contract === 1 && pin(c.source) && image(c.agentImage),
    'INCOMPLETE_PROVIDER_COMPOSITION');
  const entry = providerTable[binding.provider];
  requireThat(Object.entries(entry.components).every(([key, value]) =>
    c[key] === value) && compatibleProfile(c.hostProfile) &&
    entry.credentialKind(binding.credentialKind),
  'PROVIDER_COMPOSITION_UNAVAILABLE');
}

// Codex has one fixed kind; a Claude pool names its one stored credential kind.
function bindingCredentialKind(provider, kind) {
  if (provider === 'codex') {
    requireThat(kind === undefined || kind === codexCredentialKind,
      'PROVIDER_CREDENTIAL_KIND_INVALID');
    return codexCredentialKind;
  }
  requireThat(providerTable.claude.credentialKind(kind),
    'PROVIDER_CREDENTIAL_KIND_INVALID');
  return kind;
}

function poolIdentity(host) {
  const runner = host.sharedRunner?.runner ?? host.repository?.runner;
  const second = host.sharedRunner?.additionalRunner;
  const runners = [{ id: runner?.runnerId, name: runner?.runnerName }];
  if (second) runners.push({ id: second.id, name: second.name });
  requireThat(typeof runner?.repository === 'string' && isId(runner.repositoryId) &&
    isId(host.memberId) && runners.every(r => isId(r.id) &&
      typeof r.name === 'string' && r.name.length > 0) &&
    new Set(runners.map(r => r.id)).size === runners.length,
  'PROVIDER_POOL_BINDING_MISMATCH');
  return { repository: runner.repository, repositoryId: runner.repositoryId,
    memberId: host.memberId, runners };
}

function compatibleHost(host) {
  const isolation = host.repository?.isolation;
  const second = host.sharedRunner?.additionalRunner?.isolation;
  requireThat(host.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    pin(host.installation?.pin) && model(host.model) &&
    typeof host.authFile === 'string' && host.authFile.startsWith('/') &&
    compatibleProfile(isolation?.kind) &&
    image(isolation.agent?.image) && image(isolation.hooks?.image) &&
    (!second || second.kind === isolation.kind &&
      second.agent?.image === isolation.agent.image && image(second.hooks?.image)),
  'INCOMPATIBLE_PROVIDER_HOST');
}

// Only administrator-owned adoption calls this. Source and native Runner
// verification precede persistence; this structural check does not replace them.
export function createProviderBinding(host, provider = 'codex', {
  credentialKind,
} = {}) {
  providerIdentity(provider);
  compatibleHost(host);
  const binding = { schemaVersion: 1, provider,
    original: { provider, installation: structuredClone(host.installation.pin),
      pool: poolIdentity(host) },
    modelProfile: { model: host.model },
    credentialKind: bindingCredentialKind(provider, credentialKind),
    components: providerComponents(host, provider) };
  compatibleComponents(binding);
  return binding;
}

export function validateProviderBinding(binding) {
  requireThat(binding?.schemaVersion === 1, 'INVALID_PROVIDER_BINDING');
  providerIdentity(binding.provider);
  requireThat(binding.original?.provider === binding.provider,
    'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD');
  requireThat(pin(binding.original.installation) && model(binding.modelProfile?.model),
    'INVALID_PROVIDER_BINDING');
  const pool = binding.original.pool;
  requireThat(typeof pool?.repository === 'string' && isId(pool.repositoryId) &&
    isId(pool.memberId) && Array.isArray(pool.runners) &&
    pool.runners.length > 0 && pool.runners.length <= 2 &&
    pool.runners.every(r => isId(r.id) && typeof r.name === 'string' && r.name) &&
    new Set(pool.runners.map(r => r.id)).size === pool.runners.length,
  'PROVIDER_POOL_BINDING_MISMATCH');
  compatibleComponents(binding);
  return structuredClone(binding);
}

// Absence is compatible only with the recognized Codex host, model, package,
// isolation and native registration layout. It is never a provider selector.
export function installedProvider(host, requested) {
  const binding = host.providerBinding === undefined
    ? createProviderBinding(host) : validateProviderBinding(host.providerBinding);
  compatibleHost(host);
  requireThat(host.provider === undefined || host.provider === binding.provider,
    'PROVIDER_OVERRIDE_FORBIDDEN');
  if (requested !== undefined) requireThat(requested === binding.provider,
    'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD');
  requireThat(binding.modelProfile.model === host.model &&
    same(binding.components, providerComponents(host, binding.provider)),
  'PROVIDER_COMPONENT_MISMATCH');
  requireThat(same(binding.original.pool, poolIdentity(host)),
    'PROVIDER_POOL_BINDING_MISMATCH');
  validateViews(host, binding);
  return binding;
}

function validateViews(host, binding) {
  for (const view of [host.repository, ...Object.values(host.issues ?? {}),
    host.repository?.runner, host.repository?.eventRunner,
    host.sharedRunner, host.sharedRunner?.runner, host.sharedRunner?.additionalRunner]) {
    if (!view) continue;
    requireThat(view.provider === undefined || view.provider === binding.provider,
      'PROVIDER_OVERRIDE_FORBIDDEN');
    requireThat(view.providerBinding === undefined || same(view.providerBinding, binding),
      'PROVIDER_VIEW_MISMATCH');
  }
}

// A peer is a view of the primary pool, not a second installation or selector.
// Legacy slot views may expose only one Runner; compare against the primary's
// complete record instead of inventing a new original pool association.
export function compareProviderViews(primary, peer) {
  const binding = installedProvider(primary);
  requireThat(same(peer.installation, primary.installation) &&
    peer.memberId === primary.memberId &&
    (peer.provider === undefined || peer.provider === binding.provider) &&
    (peer.model === undefined || peer.model === binding.modelProfile.model) &&
    (peer.authFile === undefined || peer.authFile === primary.authFile),
  'PROVIDER_VIEW_MISMATCH');
  requireThat(primary.providerBinding === undefined
    ? peer.providerBinding === undefined : same(peer.providerBinding, binding),
  'PROVIDER_VIEW_MISMATCH');
  validateViews(peer, binding);
  const isolation = peer.repository?.isolation;
  requireThat(isolation?.kind === binding.components.hostProfile &&
    isolation.agent?.image === binding.components.agentImage,
  'PROVIDER_VIEW_MISMATCH');
  return binding;
}

export function validateProviderUpdate(current, next) {
  const before = installedProvider(current);
  const selected = next.providerBinding?.provider ?? next.provider;
  if (selected !== undefined) {
    providerIdentity(selected);
    requireThat(selected === before.provider,
      'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD');
  }
  const after = installedProvider(next);
  requireThat(before.provider === after.provider &&
    (current.providerBinding === undefined && next.providerBinding === undefined
      ? same(before.original.pool, after.original.pool)
      : same(before.original, after.original)),
  'PROVIDER_CHANGE_REQUIRES_RETIREMENT_REBUILD');
  // Once materialized, the original identity cannot revert to legacy inference.
  requireThat(current.providerBinding === undefined || next.providerBinding !== undefined,
    'PROVIDER_BINDING_REMOVAL_FORBIDDEN');
  return after;
}
