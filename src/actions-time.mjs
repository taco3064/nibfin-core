import { requireThat } from './identity.mjs';

export const actionsTimeErrors = Object.freeze([
  'OIDC_TIME_INVALID', 'OIDC_LIFETIME_INVALID',
  'OIDC_NOT_YET_ACTIVE', 'OIDC_EXPIRED', 'OIDC_ID_MISSING',
]);

// Call only after signature verification. Never expose claims or credentials.
export function validateActionsTime(payload, now) {
  requireThat(Number.isFinite(now) &&
    [payload.iat, payload.nbf, payload.exp].every(Number.isSafeInteger),
  'OIDC_TIME_INVALID');
  const seconds = Math.floor(now / 1000);
  // Issued-at bounds token lifetime. Only not-before defines activation.
  requireThat(payload.iat <= payload.exp && payload.exp - payload.iat <= 600,
    'OIDC_LIFETIME_INVALID');
  requireThat(payload.nbf <= seconds, 'OIDC_NOT_YET_ACTIVE');
  requireThat(seconds < payload.exp, 'OIDC_EXPIRED');
  requireThat(typeof payload.jti === 'string' && payload.jti.length > 0,
    'OIDC_ID_MISSING');
}
