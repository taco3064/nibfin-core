import { fstatSync } from 'node:fs';
import { requireThat } from './identity.mjs';
import { claudeCredentialKind } from './claude-credential-kinds.mjs';

export const credentialInputLimit = 65536;
const invalid = 'MANAGED_CREDENTIAL_INPUT_INVALID';

// Production calls this only with fd 0, after verifying the administrator entry.
export function privateCredentialPipe(fd = 0) {
  const stat = fstatSync(fd);
  requireThat(stat.isFIFO() && (stat.mode & 0o077) === 0, invalid);
}

// Only fixed codes leave this module; credential text never does.
const passed = new Set(['MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED',
  'MANAGED_CLAUDE_CREDENTIAL_INVALID']);
const safeCode = error => passed.has(error.code) ? error.code : invalid;

// A Claude envelope carries one whole credential of a known kind.
function claudeMaterial(token, credential) {
  const credentialKind = claudeCredentialKind(credential);
  requireThat(credentialKind, 'MANAGED_CLAUDE_CREDENTIAL_INVALID');
  return { token, credentialKind, credential: credential + '\n' };
}

export function decodeCredentialInput(bytes) {
  try {
    requireThat(bytes.length > 0 && bytes.length <= credentialInputLimit, invalid);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    const keys = value && Object.keys(value).sort().join(',');
    requireThat(['codex,githubToken,schemaVersion',
      'claude,githubToken,schemaVersion'].includes(keys) &&
      value.schemaVersion === 1 &&
      typeof value.githubToken === 'string' &&
      /^[A-Za-z0-9_]{20,16300}$/.test(value.githubToken), invalid);
    if (Object.hasOwn(value, 'claude'))
      return claudeMaterial(value.githubToken, value.claude);
    const auth = value.codex;
    requireThat(auth?.auth_mode === 'chatgpt' && !auth.OPENAI_API_KEY &&
      auth.tokens && typeof auth.tokens === 'object' &&
      ['access_token', 'refresh_token', 'id_token'].every(key =>
        typeof auth.tokens[key] === 'string' && auth.tokens[key].length >= 20 &&
        auth.tokens[key].length <= 16384), 'MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED');
    // Preserve the supported Codex file representation, never a session home.
    requireThat(Object.keys(auth).every(key =>
      ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key)) &&
      Object.keys(auth.tokens).every(key =>
        ['access_token', 'refresh_token', 'id_token', 'account_id'].includes(key)),
    'MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED');
    requireThat((auth.last_refresh === undefined ||
      typeof auth.last_refresh === 'string' && auth.last_refresh.length <= 100) &&
      (auth.tokens.account_id === undefined ||
        typeof auth.tokens.account_id === 'string' &&
        auth.tokens.account_id.length <= 200),
    'MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED');
    return { token: value.githubToken, auth: JSON.stringify(auth) + '\n' };
  } catch (error) {
    const code = safeCode(error);
    throw Object.assign(new Error(code), { code });
  }
}

export async function readCredentialInput(input) {
  const chunks = [];
  let size = 0;
  const timeout = setTimeout(() => input.destroy(new Error(invalid)), 10000);
  try {
    for await (const chunk of input) {
      size += chunk.length;
      requireThat(size <= credentialInputLimit, invalid);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    try { return decodeCredentialInput(bytes); }
    finally { bytes.fill(0); }
  } catch (error) {
    const code = safeCode(error);
    throw Object.assign(new Error(code), { code });
  } finally {
    clearTimeout(timeout);
    for (const chunk of chunks) chunk.fill(0);
  }
}
