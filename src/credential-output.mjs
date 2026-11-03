import { requireThat } from './identity.mjs';

// Defense in depth only: output filtering cannot make an exposed credential
// safe. Isolation must deny credential reads before any project code executes.
export function subscriptionSecrets(value) {
  requireThat(value?.auth_mode === 'chatgpt' && !value.OPENAI_API_KEY && value.tokens &&
    ['access_token', 'refresh_token', 'id_token'].every(key => typeof value.tokens[key] === 'string' && value.tokens[key].length >= 20),
  'CHATGPT_SUBSCRIPTION_REQUIRED');
  return [...new Set(Object.values(value.tokens).filter(item => typeof item === 'string' && item.length >= 8))];
}
export function containsCredentials(text, secrets) {
  requireThat(typeof text === 'string' && Array.isArray(secrets), 'INVALID_CREDENTIAL_SCAN');
  for (const secret of secrets) {
    const bytes = Buffer.from(secret);
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), bytes.toString('base64'), bytes.toString('base64url'),
      bytes.toString('hex'), bytes.toString('hex').toUpperCase(), encodeURIComponent(secret)])) {
      if (form && text.includes(form)) return true;
    }
  }
  return false;
}
