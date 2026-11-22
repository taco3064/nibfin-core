import { claudeCredentialKind, claudeCredentialKinds, readClaudeCredential }
  from './claude-model-credentials.mjs';
import { requireThat } from './identity.mjs';

// The binding names only a credential kind. The stored value must match it;
// CodexRoleAgent reports every read failure as CLAUDE_CREDENTIAL_UNAVAILABLE.
export function claudeCredentialReader(kind, read = readClaudeCredential) {
  requireThat(typeof kind === 'string' && Object.hasOwn(claudeCredentialKinds, kind),
    'PROVIDER_CREDENTIAL_KIND_INVALID');
  return async () => {
    const value = await read();
    requireThat(claudeCredentialKind(value) === kind, 'CLAUDE_CREDENTIAL_KIND_MISMATCH');
    return value;
  };
}
