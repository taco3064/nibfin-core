// Pure classifier for the one stored Claude credential: no filesystem or host
// imports, so the provider binding can name a kind without loading host code.
// One pool stores exactly one Claude credential. The subscription token comes
// from the official `claude setup-token`; an API key uses API billing instead.
// `name` is the file name inside the managed credential directory.
export const claudeCredentialKinds = Object.freeze({
  'claude-subscription-token': Object.freeze({
    name: 'claude-oauth-token',
    pattern: /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/,
  }),
  'anthropic-api-key': Object.freeze({
    name: 'anthropic-api-key',
    pattern: /^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,500}$/,
  }),
});

export function claudeCredentialKind(value) {
  if (typeof value !== 'string') return undefined;
  return Object.keys(claudeCredentialKinds)
    .find(kind => claudeCredentialKinds[kind].pattern.test(value));
}
export const validClaudeCredential = value =>
  claudeCredentialKind(value) !== undefined;
