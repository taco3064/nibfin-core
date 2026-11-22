import { dirname, join } from 'node:path';
import { claudeCredentialKinds } from './claude-credential-kinds.mjs';
import { requireThat } from './identity.mjs';

// The provider credential kind stored with the GitHub token. Codex has one
// fixed kind; a Claude pool stores exactly one of its known kinds.
export const codexCredentialKind = 'codex-chatgpt';

const claudeKind = kind => typeof kind === 'string' &&
  Object.hasOwn(claudeCredentialKinds, kind);

// The managed file of one Claude kind inside a credential directory.
export function claudeCredentialFile(directory, kind) {
  requireThat(claudeKind(kind), 'MANAGED_CREDENTIAL_KIND_INVALID');
  return join(directory, claudeCredentialKinds[kind].name);
}

// A record or input without a kind is the original Codex set.
export function credentialKindOf(value) {
  const kind = value?.credentialKind ?? codexCredentialKind;
  requireThat(kind === codexCredentialKind || claudeKind(kind),
    'MANAGED_CREDENTIAL_KIND_INVALID');
  return kind;
}

export function credentialKindProvider(kind) {
  return credentialKindOf({ credentialKind: kind }) === codexCredentialKind
    ? 'codex' : 'claude';
}

// The ordered lifecycle file set: the GitHub token, then the provider credential.
export function credentialPaths(host, kind = codexCredentialKind) {
  if (credentialKindOf({ credentialKind: kind }) === codexCredentialKind)
    return [host.tokenFile, host.authFile];
  return [host.tokenFile, claudeCredentialFile(dirname(host.tokenFile), kind)];
}

// Every Claude kind file, so one pool never holds a second Claude credential.
export function claudeCredentialPaths(host) {
  return Object.keys(claudeCredentialKinds)
    .map(kind => claudeCredentialFile(dirname(host.tokenFile), kind));
}

// The published host profile names the intake target; absence is Codex.
export function publishedCredentialProvider(profile) {
  const provider = profile?.provider === undefined ? 'codex' : profile.provider;
  requireThat(provider === 'codex' || provider === 'claude',
    'MANAGED_CREDENTIAL_PROVIDER_MISMATCH');
  return provider;
}
